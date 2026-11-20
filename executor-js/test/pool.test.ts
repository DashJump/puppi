import { type ChildProcess, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { signingPayload, type SigningSubject } from "@puppi/sdk";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { WebSocket, WebSocketServer } from "ws";

import { bundleCarryingStorage } from "./support/storage-adapters.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../dist/worker/pool.js");
const workerToken = "super-secret-worker-token";
const sentinel = "ada@example.com";
const image = "ghcr.io/example/puppi-worker:0.4";

type Frame = Record<string, unknown>;
type Gate = "open" | "forbidden" | "unauthorized";

interface Pool {
  frames: Frame[];
  stdout: string[];
  root: string;
  cacheDir: string;
  downloads(): number;
  upgradeTimes(): number[];
  headers(): Record<string, string | undefined>;
  send(frame: unknown): void;
  closeSockets(): void;
  gate: { current: Gate };
  pid: number | undefined;
  exitCode(): number | null;
  stderr(): string;
  bundleArrivals(): number;
  releaseBundle(): void;
  readyAt(): number[];
  until(label: string, ready: () => boolean, ms?: number): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const pending = cleanups.splice(0);

  for (let index = pending.length - 1; index >= 0; index -= 1) {
    await pending[index]?.();
  }
});

describe("pool worker", () => {
  it("acks a non-event stdout line and still finishes the attempt", async () => {
    const pool = await start();
    const digest = publish(
      pool,
      "claim-1",
      bundle(
        `console.log("not-json"); console.log(${JSON.stringify(JSON.stringify({ message: "nope" }))}); await ctx.emit([{ id: 1 }]);`,
      ),
    );

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("complete", () => completes(pool, "attempt-1").length === 1);

    expect(pool.stderr()).toContain("executor sent a non-event line");
    expect(pool.stderr()).toContain("executor sent a non-event JSON value");
    expect(record(completes(pool, "attempt-1")[0]?.["result"])["event"]).toBe("result");
  }, 15_000);

  it("drop-tables reports the drop and removes its scratch directory", async () => {
    const pool = await start();
    const digest = publish(pool, "claim-1", bundle(`await ctx.emit([{ id: 1 }]);`));
    const ref = "kept.nowhere";

    pool.send(dropTables("attempt-1", digest, "claim-1", pool.root, [ref]));
    await pool.until("dropped", () => completes(pool, "attempt-1").length === 1);
    await pool.until("scratch gone", () => scratchChildren(pool.root).length === 0);

    expect(completes(pool, "attempt-1")[0]).toMatchObject({
      message: "complete",
      attempt_id: "attempt-1",
      fence: 1,
      last_seq: 0,
      result: { message: "dropped", dropped: [ref], failed: [] },
    });
    expect(pool.downloads()).toBe(1);
  }, 15_000);

  it("a cancel during a drop-tables download does not spawn, and the slot can be used again", async () => {
    const pool = await start({ slots: 1, holdBundle: true });
    const digest = publish(pool, "claim-1", bundle(`await ctx.emit([{ id: 1 }]);`));
    const next = publish(pool, "claim-2", bundle(`ctx.log("again"); await ctx.emit([{ id: 1 }]);`));

    pool.send(dropTables("attempt-1", digest, "claim-1", pool.root, ["kept.one"]));
    await pool.until("downloading", () => pool.bundleArrivals() >= 1);
    pool.send({ message: "cancel", attempt_id: "attempt-1", fence: 1, reason: "stopped" });
    pool.releaseBundle();

    pool.send(lease("attempt-2", "run-2", next, "claim-2", pool.root));
    await pool.until("reused", () => resultOf(pool, "attempt-2"));

    expect(completes(pool, "attempt-1")).toHaveLength(0);
    expect(pool.exitCode()).toBeNull();
  }, 15_000);

  it("a drop-tables frame without a bundle digest does not download", async () => {
    const pool = await start();

    pool.send(dropTables("attempt-1", "not-a-digest", "claim-1", pool.root, ["kept.one"]));
    await pool.until("failed", () => completes(pool, "attempt-1").length === 1);

    expect(completes(pool, "attempt-1")[0]?.["result"]).toEqual({
      event: "error",
      class: "retryable",
      message: "drop-tables frame is missing a bundle digest",
    });
    expect(pool.downloads()).toBe(0);
  });

  it("a drop-tables scratch directory that cannot be created is retryable", async () => {
    const pool = await start();
    const digest = publish(pool, "claim-1", bundle(`await ctx.emit([{ id: 1 }]);`));
    const unlock = lockScratchParents(pool.root);

    try {
      pool.send(dropTables("attempt-1", digest, "claim-1", pool.root, ["kept.one"]));
      await pool.until(
        "scratch create failed",
        () =>
          /EACCES|EPERM|ENOTDIR/.test(pool.stderr()) || completes(pool, "attempt-1").length === 1,
      );
      process.kill(pool.pid ?? 0, "SIGTERM");
      await pool.until("exited", () => pool.exitCode() !== null, 2_000);
      expect(pool.exitCode()).toBe(0);
      expect(completes(pool, "attempt-1")[0]?.["result"]).toMatchObject({
        event: "error",
        class: "retryable",
      });
    } finally {
      unlock();
    }
  }, 15_000);

  it("returns one sequenced attempt and one complete", async () => {
    const pool = await start();
    const source = bundle(`ctx.log("hello"); await ctx.emit([{ id: 1 }]);`);
    const digest = publish(pool, "claim-1", source);

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("complete", () => completes(pool, "attempt-1").length === 1);

    const events = pool.frames.filter(
      (frame) => frame["message"] === "event" && frame["attempt_id"] === "attempt-1",
    );
    expect(events.map((frame) => frame["seq"])).toEqual(events.map((_, index) => index + 1));
    expect(events.map((frame) => record(frame["event"]))).toContainEqual(
      expect.objectContaining({
        event: "logs",
        lines: [expect.objectContaining({ level: "info", message: "hello" })],
      }),
    );
    expect(completes(pool)).toEqual([
      expect.objectContaining({
        attempt_id: "attempt-1",
        fence: 1,
        last_seq: events.length,
        result: expect.objectContaining({ event: "result" }),
      }),
    ]);
    expect(pool.headers()).toMatchObject({
      authorization: `Bearer ${workerToken}`,
      "x-puppi-worker-version": "0.4",
      "x-puppi-residency": "standard",
      "x-puppi-worker-id": "droplet-1",
    });
    expect(pool.stdout.map((line) => JSON.parse(line) as Frame)).toContainEqual(
      expect.objectContaining({
        lease: "accepted",
        attempt_id: "attempt-1",
        asset_key: "source/things",
        bundle_digest: digest,
      }),
    );
    expect(pool.frames.find((frame) => frame["message"] === "ready")).toMatchObject({
      slots: 1,
    });
  }, 15_000);

  it("runs two attempts at once when it has two slots", async () => {
    const pool = await start({ slots: 2 });
    const hold = join(pool.root, "hold");
    const digestA = publish(pool, "claim-a", holding(join(pool.root, "pid-a"), hold));
    const digestB = publish(pool, "claim-b", holding(join(pool.root, "pid-b"), hold));

    expect(pool.frames.find((frame) => frame["message"] === "ready")).toMatchObject({ slots: 2 });
    pool.send(lease("attempt-a", "run-a", digestA, "claim-a", pool.root));
    pool.send(lease("attempt-b", "run-b", digestB, "claim-b", pool.root));

    await pool.until(
      "both running",
      () => pid(pool, "pid-a") !== undefined && pid(pool, "pid-b") !== undefined,
    );
    expect(alive(pid(pool, "pid-a"))).toBe(true);
    expect(alive(pid(pool, "pid-b"))).toBe(true);
    expect(completes(pool)).toHaveLength(0);

    writeFileSync(hold, "go");
    await pool.until("both done", () => completes(pool).length === 2);
  }, 15_000);

  it("a child crash is a retryable complete", async () => {
    const pool = await start();
    const digest = publish(pool, "claim-1", bundle(`process.exit(1);`));

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("crashed", () => completes(pool, "attempt-1").length === 1);

    expect(completes(pool, "attempt-1")[0]?.["result"]).toEqual({
      event: "error",
      class: "retryable",
      message: "executor exited 1",
    });
  });

  it("a crashed child does not leave its temp files", async () => {
    const pool = await start();
    const note = join(pool.root, "leak-note");
    const digest = publish(pool, "claim-1", leaking(note));

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until(
      "crashed",
      () => completes(pool, "attempt-1").length === 1 && existsSync(note),
    );

    const recorded = JSON.parse(readFileSync(note, "utf8")) as { tmp: string; dir: string };
    expect({
      tmp: existsSync(recorded.tmp),
      dir: existsSync(recorded.dir),
    }).toEqual({ tmp: false, dir: false });
  });

  it("killing the worker does not leave the runtime child running", async () => {
    const pool = await start();
    const hold = join(pool.root, "hold");
    const digest = publish(pool, "claim-1", holding(join(pool.root, "pid-1"), hold));

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("running", () => pid(pool, "pid-1") !== undefined);

    const childPid = pid(pool, "pid-1");
    expect(commandLine(childPid)).toContain("runtime.js");
    expect(alive(childPid)).toBe(true);

    const worker = pool.pid ?? 0;
    process.kill(worker, "SIGKILL");
    await pool.until("worker dead", () => !alive(worker));

    const deadline = Date.now() + 1_000;
    while (alive(childPid) && Date.now() < deadline) await delay(20);

    expect(alive(childPid)).toBe(false);
  }, 15_000);

  it("killing the worker removes the attempt scratch directory", async () => {
    const pool = await start();
    const note = join(pool.root, "scratch-note");
    const digest = publish(pool, "claim-1", scratchHold(note, join(pool.root, "hold")));

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("running", () => existsSync(note));
    const scratch = readFileSync(note, "utf8").trim();
    expect(existsSync(scratch)).toBe(true);

    const worker = pool.pid ?? 0;
    process.kill(worker, "SIGKILL");
    await pool.until("worker dead", () => !alive(worker));

    const deadline = Date.now() + 2_000;
    while (existsSync(scratch) && Date.now() < deadline) await delay(20);

    expect(existsSync(scratch)).toBe(false);
  }, 15_000);

  it("a dropped socket removes the attempt scratch directory", async () => {
    const pool = await start();
    const note = join(pool.root, "scratch-note");
    const digest = publish(pool, "claim-1", scratchHold(note, join(pool.root, "hold")));

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("running", () => existsSync(note));
    const scratch = readFileSync(note, "utf8").trim();
    expect(existsSync(scratch)).toBe(true);

    pool.closeSockets();
    const deadline = Date.now() + 2_000;
    while (existsSync(scratch) && Date.now() < deadline) await delay(20);

    expect(existsSync(scratch)).toBe(false);
  }, 15_000);

  it("a dropped socket removes the scratch directory while stdout is still open", async () => {
    const pool = await start();
    const note = join(pool.root, "scratch-note");
    const digest = publish(pool, "claim-1", heldStdout(note));
    let holder = 0;

    try {
      pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
      await pool.until("running", () => existsSync(note));
      const recorded = JSON.parse(readFileSync(note, "utf8")) as { tmp: string; pid: number };
      holder = recorded.pid;
      expect(existsSync(recorded.tmp)).toBe(true);

      const ready = (): number =>
        pool.frames.filter((frame) => frame["message"] === "ready").length;
      const before = ready();
      pool.closeSockets();
      await pool.until("reconnected", () => ready() > before);
      expect(existsSync(recorded.tmp)).toBe(false);
    } finally {
      if (holder) {
        try {
          process.kill(holder, "SIGKILL");
        } catch {
          // The holder already exited.
        }
      }
    }
  }, 15_000);

  it("a scratch directory that cannot be created is retryable and does not stick", async () => {
    const pool = await start();
    const digest = publish(pool, "claim-1", bundle(`await ctx.emit([{ id: 1 }]);`));
    const unlock = lockScratchParents(pool.root);

    try {
      pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
      await pool.until(
        "scratch create failed",
        () =>
          /EACCES|EPERM|ENOTDIR/.test(pool.stderr()) || completes(pool, "attempt-1").length === 1,
      );
      process.kill(pool.pid ?? 0, "SIGTERM");
      await pool.until("exited", () => pool.exitCode() !== null, 2_000);
      expect(pool.exitCode()).toBe(0);
      expect(completes(pool, "attempt-1")[0]?.["result"]).toMatchObject({
        event: "error",
        class: "retryable",
      });
    } finally {
      unlock();
    }
  }, 15_000);

  it("the attempt scratch directory is private", async () => {
    const pool = await start();
    const note = join(pool.root, "mode-note");
    const digest = publish(pool, "claim-1", modeNote(note));

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("mode", () => existsSync(note) && resultOf(pool, "attempt-1"));

    expect(Number(readFileSync(note, "utf8").trim())).toBe(0o700);
  }, 15_000);

  it("boot removes scratch directories under this worker's root only", async () => {
    const pool = await start({
      prepare(root) {
        mkdirSync(join(root, "puppi-pool-droplet-1", "puppi-stale"), { recursive: true });
        writeFileSync(join(root, "puppi-pool-droplet-1", "puppi-stale", "leak"), "x");
        mkdirSync(join(root, "puppi-other", "puppi-keep"), { recursive: true });
        writeFileSync(join(root, "puppi-other", "puppi-keep", "keep"), "x");
      },
    });

    expect(existsSync(join(pool.root, "puppi-pool-droplet-1", "puppi-stale"))).toBe(false);
    expect(existsSync(join(pool.root, "puppi-other", "puppi-keep", "keep"))).toBe(true);
  });

  it("socket loss kills every child", async () => {
    const pool = await start({ slots: 2 });
    const hold = join(pool.root, "hold");
    const digestA = publish(pool, "claim-a", holding(join(pool.root, "pid-a"), hold));
    const digestB = publish(pool, "claim-b", holding(join(pool.root, "pid-b"), hold));
    pool.send(lease("attempt-a", "run-a", digestA, "claim-a", pool.root));
    pool.send(lease("attempt-b", "run-b", digestB, "claim-b", pool.root));
    await pool.until(
      "both running",
      () => pid(pool, "pid-a") !== undefined && pid(pool, "pid-b") !== undefined,
    );

    const first = pid(pool, "pid-a");
    const second = pid(pool, "pid-b");
    pool.closeSockets();

    await pool.until("children dead", () => !alive(first) && !alive(second));
    expect(completes(pool)).toHaveLength(0);
    await pool.until(
      "reconnected",
      () => pool.frames.filter((frame) => frame["message"] === "ready").length >= 2,
    );
  });

  it("a cancel during download does not spawn, and the slot can be used again", async () => {
    const pool = await start({ slots: 1, holdBundle: true });
    const digest = publish(
      pool,
      "claim-1",
      holding(join(pool.root, "pid-1"), join(pool.root, "hold")),
    );
    const next = publish(pool, "claim-2", bundle(`ctx.log("again"); await ctx.emit([{ id: 1 }]);`));

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("downloading", () => pool.bundleArrivals() >= 1);
    pool.send({ message: "cancel", attempt_id: "attempt-1", fence: 1, reason: "stopped" });
    pool.releaseBundle();

    pool.send(lease("attempt-2", "run-2", next, "claim-2", pool.root));
    await pool.until("reused", () => resultOf(pool, "attempt-2"));

    expect(pid(pool, "pid-1")).toBeUndefined();
    expect(completes(pool, "attempt-1")).toHaveLength(0);
    expect(pool.exitCode()).toBeNull();
  }, 15_000);

  it("keeps staged pages for a rejected outcome and drops them when recorded", async () => {
    const pool = await start({ settle: false });
    const kept = publish(pool, "claim-1", appending(join(pool.root, "pid-1")));
    const dropped = publish(pool, "claim-2", appending(join(pool.root, "pid-2")));

    pool.send(lease("attempt-1", "run-1", kept, "claim-1", pool.root));
    await pool.until("kept complete", () => resultOf(pool, "attempt-1"));
    const pages = stagedPages(pool.root);
    expect(pages.length).toBeGreaterThan(0);
    expect(alive(pid(pool, "pid-1"))).toBe(true);

    pool.send(settled("attempt-1", "rejected"));
    await pool.until("kept exited", () => !alive(pid(pool, "pid-1")));
    expect(stagedPages(pool.root)).toEqual(pages);

    pool.send(lease("attempt-2", "run-2", dropped, "claim-2", pool.root));
    await pool.until("dropped complete", () => resultOf(pool, "attempt-2"));
    expect(stagedPages(pool.root).length).toBeGreaterThan(0);

    pool.send(settled("attempt-2", "recorded"));
    await pool.until("dropped exited", () => !alive(pid(pool, "pid-2")));
    expect(stagedPages(pool.root)).toEqual(pages);
  }, 15_000);

  it("cancel kills the child and leaves staged pages", async () => {
    const pool = await start({ settle: false });
    const digest = publish(
      pool,
      "claim-1",
      stagedHold(join(pool.root, "pid-1"), join(pool.root, "hold")),
    );

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until(
      "staged",
      () => pid(pool, "pid-1") !== undefined && stagedPages(pool.root).length > 0,
    );
    const pages = stagedPages(pool.root);

    pool.send({ message: "cancel", attempt_id: "attempt-1", fence: 1, reason: "stopped" });
    await pool.until("dead", () => !alive(pid(pool, "pid-1")));
    pool.send(settled("attempt-1", "recorded"));
    await delay(200);

    expect(alive(pid(pool, "pid-1"))).toBe(false);
    expect(stagedPages(pool.root)).toEqual(pages);
    expect(completes(pool, "attempt-1")).toHaveLength(0);
  }, 15_000);

  it("a cancel after the result still drops recorded pages", async () => {
    const pool = await start({ settle: false });
    const kept = publish(pool, "claim-1", appending(join(pool.root, "pid-1")));
    const dropped = publish(pool, "claim-2", appending(join(pool.root, "pid-2")));

    pool.send(lease("attempt-1", "run-1", kept, "claim-1", pool.root));
    await pool.until("kept complete", () => resultOf(pool, "attempt-1"));
    expect(stagedPages(pool.root).length).toBeGreaterThan(0);
    expect(alive(pid(pool, "pid-1"))).toBe(true);

    pool.send({ message: "cancel", attempt_id: "attempt-1", fence: 1, reason: "owner_gone" });
    await delay(200);
    expect(alive(pid(pool, "pid-1"))).toBe(true);

    pool.send(settled("attempt-1", "rejected"));
    await pool.until("kept exited", () => !alive(pid(pool, "pid-1")));
    const pages = stagedPages(pool.root);
    expect(pages.length).toBeGreaterThan(0);

    pool.send(lease("attempt-2", "run-2", dropped, "claim-2", pool.root));
    await pool.until("dropped complete", () => resultOf(pool, "attempt-2"));
    expect(alive(pid(pool, "pid-2"))).toBe(true);
    expect(stagedPages(pool.root).length).toBeGreaterThan(0);

    pool.send({ message: "cancel", attempt_id: "attempt-2", fence: 1, reason: "owner_gone" });
    pool.send(settled("attempt-2", "recorded"));
    pool.send({ message: "cancel", attempt_id: "attempt-2", fence: 1, reason: "owner_gone" });
    await pool.until("dropped", () => !alive(pid(pool, "pid-2")));
    expect(stagedPages(pool.root)).toEqual(pages);
  }, 15_000);

  it("a fenced checkpoint does not continue the seal", async () => {
    const pool = await start({ settle: false, holdCheckpoint: true });
    const marker = join(pool.root, "continued");
    const digest = publish(pool, "claim-1", continued(join(pool.root, "pid-1"), marker));

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("checkpoint", () =>
      pool.frames.some((frame) => record(frame["event"])["event"] === "checkpoint"),
    );

    pool.send({ message: "settled", attempt_id: "attempt-1", fence: 1, fenced: true });
    await pool.until(
      "stopped",
      () => pid(pool, "pid-1") !== undefined && !alive(pid(pool, "pid-1")),
    );
    await delay(200);

    expect(existsSync(marker)).toBe(false);
    expect(completes(pool, "attempt-1")).toHaveLength(0);
  }, 15_000);

  it("a fenced settled frame stops the child and leaves staged pages", async () => {
    const pool = await start({ settle: false });
    const running = publish(
      pool,
      "claim-1",
      stagedHold(join(pool.root, "pid-1"), join(pool.root, "hold")),
    );
    const finished = publish(pool, "claim-2", appending(join(pool.root, "pid-2")));

    pool.send(lease("attempt-1", "run-1", running, "claim-1", pool.root));
    await pool.until(
      "running",
      () => pid(pool, "pid-1") !== undefined && stagedPages(pool.root).length > 0,
    );
    const runningPages = stagedPages(pool.root);
    pool.send({ message: "settled", attempt_id: "attempt-1", fence: 1, fenced: true });
    await pool.until("stopped", () => !alive(pid(pool, "pid-1")));
    expect(stagedPages(pool.root)).toEqual(runningPages);
    expect(completes(pool, "attempt-1")).toHaveLength(0);

    pool.send(lease("attempt-2", "run-2", finished, "claim-2", pool.root));
    await pool.until("complete", () => resultOf(pool, "attempt-2"));
    const both = stagedPages(pool.root);
    expect(both.length).toBeGreaterThan(runningPages.length);
    expect(alive(pid(pool, "pid-2"))).toBe(true);

    pool.send(settled("attempt-2", "fenced"));
    await pool.until("fenced complete", () => !alive(pid(pool, "pid-2")));
    const after = stagedPages(pool.root);
    expect(after).toEqual(expect.arrayContaining(runningPages));
    expect(after.length).toBeGreaterThan(runningPages.length);
  }, 15_000);

  it("sends ready again before the socket goes idle", async () => {
    const pool = await start();
    expect(pool.readyAt()).toHaveLength(1);

    await pool.until("keepalive", () => pool.readyAt().length >= 2, 25_000);
    const [first, second] = pool.readyAt();
    const gap = (second ?? 0) - (first ?? 0);
    expect(gap).toBeGreaterThanOrEqual(15_000);
    expect(gap).toBeLessThan(60_000);
  }, 30_000);

  it("cancel kills one child", async () => {
    const pool = await start({ slots: 2 });
    const hold = join(pool.root, "hold");
    const digestA = publish(pool, "claim-a", holding(join(pool.root, "pid-a"), hold));
    const digestB = publish(pool, "claim-b", holding(join(pool.root, "pid-b"), hold));
    pool.send(lease("attempt-a", "run-a", digestA, "claim-a", pool.root));
    pool.send(lease("attempt-b", "run-b", digestB, "claim-b", pool.root));
    await pool.until(
      "both running",
      () => pid(pool, "pid-a") !== undefined && pid(pool, "pid-b") !== undefined,
    );

    pool.send({ message: "cancel", attempt_id: "attempt-a", fence: 1, reason: "stopped" });
    await pool.until("one dead", () => !alive(pid(pool, "pid-a")));
    expect(alive(pid(pool, "pid-b"))).toBe(true);
    expect(completes(pool, "attempt-a")).toHaveLength(0);
  });

  it("cancel kills a child that ignores SIGTERM", async () => {
    const pool = await start();
    const digest = publish(
      pool,
      "claim-1",
      stubborn(join(pool.root, "pid-1"), join(pool.root, "term-1")),
    );
    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("running", () => pid(pool, "pid-1") !== undefined);

    const started = Date.now();
    pool.send({ message: "cancel", attempt_id: "attempt-1", fence: 1, reason: "stopped" });
    await pool.until("signaled", () => existsSync(join(pool.root, "term-1")));
    await delay(1_000);
    expect(alive(pid(pool, "pid-1"))).toBe(true);

    await pool.until("killed", () => !alive(pid(pool, "pid-1")), 8_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
  }, 15_000);

  it("stop signals once and replies stopped with the held fence", async () => {
    const pool = await start();
    const term = join(pool.root, "term-1");
    const digest = publish(pool, "claim-1", termCount(join(pool.root, "pid-1"), term));

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("running", () => pid(pool, "pid-1") !== undefined);

    const stop = { message: "stop", attempt_id: "attempt-1", fence: 1, reason: "cancelled" };
    pool.send(stop);
    pool.send(stop);

    await pool.until("signaled", () => existsSync(term));
    await delay(300);
    expect(readFileSync(term, "utf8")).toBe("1");

    await pool.until(
      "stopped",
      () =>
        pool.frames.some(
          (frame) =>
            frame["message"] === "stopped" &&
            frame["attempt_id"] === "attempt-1" &&
            frame["fence"] === 1 &&
            frame["worker_id"] === "droplet-1" &&
            frame["reason"] === "cancelled",
        ),
      8_000,
    );
    expect(
      pool.frames.filter(
        (frame) => frame["message"] === "stopped" && frame["attempt_id"] === "attempt-1",
      ),
    ).toHaveLength(1);
    expect(readFileSync(term, "utf8")).toBe("1");
  }, 15_000);

  it("a cache hit skips the download and a bad copy is fetched again", async () => {
    const pool = await start();
    const source = bundle(`ctx.log("hello"); await ctx.emit([{ id: 1 }]);`);
    const bytes = Buffer.from(source);
    const digest = digestOf(bytes);
    for (const token of ["claim-1", "claim-2", "claim-3"]) remember(pool, token, bytes);

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("first", () => resultOf(pool, "attempt-1"));
    expect(pool.downloads()).toBe(1);

    pool.send(lease("attempt-2", "run-2", digest, "claim-2", pool.root));
    await pool.until("second", () => resultOf(pool, "attempt-2"));
    expect(pool.downloads()).toBe(1);

    writeFileSync(join(pool.cacheDir, `${digest.slice("sha256:".length)}.mjs`), "not the bundle");
    pool.send(lease("attempt-3", "run-3", digest, "claim-3", pool.root));
    await pool.until("third", () => resultOf(pool, "attempt-3"));
    expect(pool.downloads()).toBe(2);
  }, 15_000);

  it("a digest mismatch is terminal", async () => {
    const pool = await start();
    const digest = digestOf(Buffer.from("the bundle the lease named"));
    remember(pool, "claim-1", Buffer.from("different bytes"));

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("refused", () => completes(pool, "attempt-1").length === 1);

    expect(completes(pool, "attempt-1")[0]?.["result"]).toMatchObject({
      event: "error",
      class: "terminal",
    });
    expect(String(record(completes(pool, "attempt-1")[0]?.["result"])["message"])).toContain(
      "bundle digest mismatch",
    );
    expect(pool.frames.filter((frame) => frame["message"] === "event")).toHaveLength(0);
    expect(pool.stdout.map((line) => JSON.parse(line) as Frame)).toContainEqual(
      expect.objectContaining({ lease: "refused", attempt_id: "attempt-1" }),
    );
  });

  it("the child environment has no PUPPI_ variables", async () => {
    const pool = await start();
    const digest = publish(
      pool,
      "claim-1",
      bundle(
        `ctx.log(JSON.stringify(Object.keys(process.env).filter((key) => key.startsWith("PUPPI_")).sort())); await ctx.emit([{ id: 1 }]);`,
      ),
    );

    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("done", () => resultOf(pool, "attempt-1"));

    expect(pool.frames.map((frame) => record(frame["event"]))).toContainEqual(
      expect.objectContaining({
        event: "logs",
        lines: [
          expect.objectContaining({
            message: '["PUPPI_EVENT_ACK","PUPPI_SCRATCH"]',
          }),
        ],
      }),
    );
    expect(JSON.stringify(pool.frames)).not.toContain(workerToken);
    expect(pool.stdout.join("\n")).not.toContain(workerToken);
  }, 15_000);

  it("SIGTERM drains the attempt it holds and exits 0", async () => {
    const pool = await start();
    const hold = join(pool.root, "hold");
    const digest = publish(pool, "claim-1", holding(join(pool.root, "pid-1"), hold));
    pool.send(lease("attempt-1", "run-1", digest, "claim-1", pool.root));
    await pool.until("running", () => pid(pool, "pid-1") !== undefined);

    process.kill(pool.pid ?? 0, "SIGTERM");
    await pool.until("draining", () =>
      pool.frames.some((frame) => frame["message"] === "ready" && frame["slots"] === 0),
    );
    expect(alive(pid(pool, "pid-1"))).toBe(true);
    expect(pool.exitCode()).toBeNull();

    writeFileSync(hold, "go");
    await pool.until("exited", () => pool.exitCode() !== null);
    expect(pool.exitCode()).toBe(0);
    expect(resultOf(pool, "attempt-1")).toBe(true);
  }, 15_000);

  it("strict withholds user text and keeps verdicts and classes", async () => {
    const key = keyPair();
    const pool = await start({ residency: "strict", trustedKeys: key.id });
    const digest = publish(pool, "claim-1", strictBundle());
    const thrown = publish(
      pool,
      "claim-2",
      bundle(`throw new Error(${JSON.stringify(sentinel)});`),
    );

    pool.send(signedLease(pool, digest, key));
    await pool.until("checked", () => resultOf(pool, "attempt-1"));
    pool.send(
      signedLease(pool, thrown, key, { attemptId: "attempt-2", runId: "run-2", claim: "claim-2" }),
    );
    await pool.until("thrown", () => completes(pool, "attempt-2").length === 1);
    await pool.until("stderr kept", () => pool.stderr().includes("kept on worker droplet-1"));

    expect(JSON.stringify(pool.frames)).not.toContain(sentinel);
    expect(pool.stderr()).not.toContain(sentinel);
    expect(pool.stderr()).toContain("kept on worker droplet-1");

    const noted = pool.frames.find((frame) => record(frame["event"])["name"] === "noted");
    expect(record(noted?.["event"])).toMatchObject({
      source: "user",
      attributes: { rows: 3, ok: true },
    });
    expect(record(record(noted?.["event"])["attributes"])["email"]).toBeUndefined();
    expect(noted?.["withheld"]).toContain("attributes.email");

    const loaded = pool.frames.find((frame) => record(frame["event"])["name"] === "bundle_loaded");
    expect(record(loaded?.["event"])["source"]).toBe("shim");
    expect(loaded?.["withheld"]).toBeUndefined();

    const logged = pool.frames.find((frame) => record(frame["event"])["event"] === "logs");
    expect(logged?.["withheld"]).toContain("lines.0.message");

    for (const frame of pool.frames) {
      const event = record(frame["event"]);
      if (event["event"] === "log") expect(event["message"]).toBe("");

      if (event["event"] === "logs" && Array.isArray(event["lines"])) {
        for (const line of event["lines"]) expect(record(line)["message"]).toBe("");
      }
    }

    const result = record(completes(pool, "attempt-1")[0]?.["result"]);
    const check = record(checkRows(result)[0]);
    expect(check).toMatchObject({ result: "fail", severity: "block", detail: null });
    expect(completes(pool, "attempt-1")[0]?.["withheld"]).toContain("check_results.0.detail");

    expect(completes(pool, "attempt-2")[0]?.["result"]).toMatchObject({
      event: "error",
      class: "terminal",
      message: "terminal",
    });
    expect(completes(pool, "attempt-2")[0]?.["withheld"]).toEqual(["message"]);

    const kept = pool.stdout
      .map((line) => JSON.parse(line) as Frame)
      .filter((row) => JSON.stringify(row).includes(sentinel));
    expect(kept.length).toBeGreaterThan(0);
    for (const row of kept) {
      expect(row).toMatchObject({
        run_id: expect.any(String),
        attempt_id: expect.any(String),
        asset_key: "source/things",
      });
    }
  }, 15_000);

  it("a refused upgrade reports the image and backs off", async () => {
    const pool = await start({ gate: "forbidden", waitForReady: false });

    await pool.until("image", () => pool.stdout.some((line) => line.includes(image)));
    await pool.until("retried", () => pool.upgradeTimes().length >= 2);
    const times = pool.upgradeTimes();
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(80);
  });

  it("a revoked token is reported and the worker keeps backing off", async () => {
    const pool = await start();
    pool.gate.current = "unauthorized";
    pool.closeSockets();

    await pool.until("rejected", () =>
      pool.stdout.some((line) => line.includes("worker token rejected")),
    );
    expect(pool.upgradeTimes().length).toBeGreaterThanOrEqual(2);
    expect(pool.exitCode()).toBeNull();
  });

  it("fills a file secret into the adapter and masks it on the wire", async () => {
    const value = "warehouse-password-9f3c1a";
    const pool = await start({ secretFiles: { warehouse_password: `${value}\n` } });
    const out = join(pool.root, "seen");
    const digest = publish(pool, "claim-1", secretBundle(out));
    const frame = lease("attempt-1", "run-1", digest, "claim-1", pool.root);
    const input = frame["input"] as Frame;
    input["bindings"] = {
      ...(input["bindings"] as Frame),
      vault: { type: "vault", config: {}, secrets: {}, mode: "live" },
    };
    frame["worker_secrets"] = { vault: { token: "warehouse_password" } };

    expect(pool.frames.find((item) => item["message"] === "ready")).toMatchObject({
      secrets: ["warehouse_password"],
    });
    pool.send(frame);
    await pool.until("filled", () => completes(pool, "attempt-1").length === 1);

    expect(readFileSync(out, "utf8")).toBe(value);
    const wire = JSON.stringify(pool.frames);
    expect(wire).not.toContain(value);
    expect(wire).toContain("[redacted]");
    expect(pool.stdout.join("\n")).not.toContain(value);
  }, 15_000);

  it("a strict worker refuses an engine-held value before any child", async () => {
    const key = keyPair();
    const pool = await start({ residency: "strict", trustedKeys: key.id });
    const digest = digestOf(Buffer.from("unused"));
    const frame = lease("attempt-1", "run-1", digest, "claim-1", pool.root);
    const input = frame["input"] as Frame;
    input["bindings"] = {
      lake: {
        type: "filesystem",
        config: { root: pool.root },
        secrets: { password: "from-engine" },
        mode: "live",
      },
    };

    await expectTerminal(pool, frame, "redeclare `lake.password` --on-worker");
  });

  it("a strict worker refuses an unsigned bundle before any child", async () => {
    const key = keyPair();
    const pool = await start({ residency: "strict", trustedKeys: key.id });
    const digest = digestOf(Buffer.from("unsigned"));
    const frame = lease("attempt-1", "run-1", digest, "claim-1", pool.root);

    await expectTerminal(pool, frame, "unsigned bundle");
  });

  it("a strict worker refuses a binding whose config differs from its signature", async () => {
    const key = keyPair();
    const pool = await start({ residency: "strict", trustedKeys: key.id });
    const digest = digestOf(Buffer.from("mismatch"));
    const frame = signedLease(pool, digest, key, { root: "/signed" });
    const input = frame["input"] as Frame;
    input["bindings"] = {
      lake: {
        type: "filesystem",
        config: { root: pool.root },
        secrets: {},
        mode: "live",
      },
    };

    await expectTerminal(pool, frame, "binding lake does not match its signature");
  });

  it("a strict worker refuses an output ref outside the signed prefix", async () => {
    const key = keyPair();
    const pool = await start({ residency: "strict", trustedKeys: key.id });
    const digest = digestOf(Buffer.from("outside"));
    const frame = signedLease(pool, digest, key);
    (frame["input"] as Frame)["output_storage_ref"] = "elsewhere.attempt-1";

    await expectTerminal(
      pool,
      frame,
      "output ref elsewhere.attempt-1 is outside storage prefix out",
    );
  });

  it("a strict worker without trusted keys refuses to start", async () => {
    const pool = await start({ residency: "strict", waitForReady: false });

    await pool.until("exited", () => pool.exitCode() !== null);
    expect(pool.stderr()).toContain("PUPPI_RESIDENCY=strict requires PUPPI_TRUSTED_KEYS");
    expect(pool.frames.some((frame) => frame["message"] === "ready")).toBe(false);
    expect(pool.exitCode()).toBe(1);
  });

  it("a second trusted key verifies during a rotation", async () => {
    const current = keyPair();
    const next = keyPair();
    const pool = await start({
      residency: "strict",
      trustedKeys: `${current.id},${next.id}`,
    });
    const source = bundle(`ctx.log("rotated"); await ctx.emit([{ id: 1 }]);`);
    const digest = publish(pool, "claim-1", source);
    const frame = signedLease(pool, digest, next);

    expect(pool.headers()["x-puppi-trusted-keys"]).toBe(
      `${current.fingerprint},${next.fingerprint}`,
    );
    pool.send(frame);
    await pool.until("ran", () => completes(pool, "attempt-1").length === 1);

    expect(record(completes(pool, "attempt-1")[0]?.["result"])["event"]).toBe("result");
    expect(pool.stdout.map((line) => JSON.parse(line) as Frame)).toContainEqual(
      expect.objectContaining({
        lease: "accepted",
        signing_key: next.fingerprint,
        bundle_digest: digest,
      }),
    );
  }, 15_000);
});

function completes(pool: Pool, attemptId?: string): Frame[] {
  return pool.frames.filter(
    (frame) =>
      frame["message"] === "complete" &&
      (attemptId === undefined || frame["attempt_id"] === attemptId),
  );
}

function resultOf(pool: Pool, attemptId: string): boolean {
  return completes(pool, attemptId).some((frame) => record(frame["result"])["event"] === "result");
}

function checkRows(result: Frame): Frame[] {
  const value = result["check_results"];
  return Array.isArray(value) ? value.filter(isFrame) : [];
}

function record(value: unknown): Frame {
  return isFrame(value) ? value : {};
}

function isFrame(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pid(pool: Pool, name: string): number | undefined {
  try {
    const value = Number(readFileSync(join(pool.root, name), "utf8"));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function alive(value: number | undefined): boolean {
  if (value === undefined) return false;

  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function commandLine(value: number | undefined): string {
  if (value === undefined) return "";

  try {
    return readFileSync(`/proc/${value}/cmdline`).toString("utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

function bundle(body: string, checks = "checks: {},"): string {
  return bundleCarryingStorage(`export default {
    adapters: {},
    assets: {
      "source/things": {
        key: "source/things",
        ${checks}
        config: {},
        run: async (ctx) => { ${body} },
      },
    },
  };`);
}

function heldStdout(note: string): string {
  // A grandchild inherits the runtime's stdout and outlives that process.
  // Socket loss has to remove the scratch directory before that pipe closes.
  return `import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    const held = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: ["ignore", "inherit", "ignore"],
    });
    held.unref();
    writeFileSync(${JSON.stringify(note)}, JSON.stringify({ tmp: tmpdir(), pid: held.pid }));
    export default {
      adapters: {},
      assets: {
        "source/things": {
          key: "source/things",
          checks: {},
          config: {},
          run: async () => {
            setInterval(() => {}, 1_000);
            await new Promise(() => {});
          },
        },
      },
    };`;
}

function scratchHold(note: string, holdFile: string): string {
  return `import { existsSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    export default {
      adapters: {},
      assets: {
        "source/things": {
          key: "source/things",
          checks: {},
          config: {},
          run: async (ctx) => {
            writeFileSync(${JSON.stringify(note)}, tmpdir());
            while (!existsSync(${JSON.stringify(holdFile)})) {
              await new Promise((resolve) => setTimeout(resolve, 15));
            }
            await ctx.emit([{ id: 1 }]);
          },
        },
      },
    };`;
}

function modeNote(note: string): string {
  return `import { statSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    export default {
      adapters: {},
      assets: {
        "source/things": {
          key: "source/things",
          checks: {},
          config: {},
          run: async (ctx) => {
            writeFileSync(${JSON.stringify(note)}, String(statSync(tmpdir()).mode & 0o777));
            await ctx.emit([{ id: 1 }]);
          },
        },
      },
    };`;
}

function leaking(note: string): string {
  return `import { mkdtempSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    export default {
      adapters: {},
      assets: {
        "source/things": {
          key: "source/things",
          checks: {},
          config: {},
          run: async () => {
            const dir = mkdtempSync(join(tmpdir(), "podcast-index-"));
            writeFileSync(join(dir, "dump.bin"), "leak");
            writeFileSync(${JSON.stringify(note)}, JSON.stringify({ tmp: tmpdir(), dir }));
            process.exit(1);
          },
        },
      },
    };`;
}

function holding(pidFile: string, holdFile: string): string {
  return `import { existsSync, writeFileSync } from "node:fs";
    export default {
      adapters: {},
      assets: {
        "source/things": {
          key: "source/things",
          checks: {},
          config: {},
          run: async (ctx) => {
            writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
            while (!existsSync(${JSON.stringify(holdFile)})) {
              await new Promise((resolve) => setTimeout(resolve, 15));
            }
            ctx.log("hello");
            await ctx.emit([{ id: 1 }]);
          },
        },
      },
    };`;
}

function appending(pidFile: string): string {
  return `import { writeFileSync } from "node:fs";
    export default {
      adapters: {},
      assets: {
        "source/things": {
          key: "source/things",
          checks: {},
          config: { mode: "append", cursor: "created" },
          run: async (ctx) => {
            writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
            ctx.checkpoint({ created: 20, page: "p2" });
            await ctx.emit([{ id: 1, created: 20 }]);
          },
        },
      },
    };`;
}

function continued(pidFile: string, marker: string): string {
  return `import { writeFileSync } from "node:fs";
    export default {
      adapters: {},
      assets: {
        "source/things": {
          key: "source/things",
          checks: {},
          config: { mode: "append", cursor: "created" },
          run: async (ctx) => {
            writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
            ctx.checkpoint({ created: 20, page: "p2" });
            await ctx.emit([{ id: 1, created: 20 }]);
            writeFileSync(${JSON.stringify(marker)}, "continued");
          },
        },
      },
    };`;
}

function secretBundle(outFile: string): string {
  return `import { writeFileSync } from "node:fs";
    class Client {
      token;
      constructor(_config, secrets) { this.token = secrets.token; }
    }
    export default {
      adapters: { vault: { type: "vault", Client } },
      assets: {
        "source/things": {
          key: "source/things",
          checks: {},
          config: {},
          run: async (ctx) => {
            const client = ctx.connection("vault");
            writeFileSync(${JSON.stringify(outFile)}, client.token);
            ctx.log(client.token);
            await ctx.emit([{ id: 1 }]);
          },
        },
      },
    };`;
}

function stagedHold(pidFile: string, holdFile: string): string {
  return `import { existsSync, writeFileSync } from "node:fs";
    export default {
      adapters: {},
      assets: {
        "source/things": {
          key: "source/things",
          checks: {},
          config: { mode: "append", cursor: "created" },
          run: async (ctx) => {
            writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
            ctx.checkpoint({ created: 20, page: "p2" });
            await ctx.emit([{ id: 1, created: 20 }]);
            while (!existsSync(${JSON.stringify(holdFile)})) {
              await new Promise((resolve) => setTimeout(resolve, 15));
            }
          },
        },
      },
    };`;
}

function settled(attemptId: string, outcome: "recorded" | "rejected" | "fenced"): Frame {
  return { message: "settled", attempt_id: attemptId, fence: 1, outcome };
}

function stagedPages(root: string): string[] {
  const dir = join(root, "out");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.includes("__page_") && name.endsWith(".parquet"))
    .sort();
}

function keyPair(): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const raw = Buffer.from(der).subarray(der.length - 32);

  return {
    id: `ed25519:${raw.toString("base64")}`,
    fingerprint: createHash("sha256").update(raw).digest("hex"),
    privateKey,
  };
}

function signedSubject(subject: SigningSubject, key: SigningKey): Frame {
  const signature = sign(null, Buffer.from(signingPayload(subject)), key.privateKey).toString(
    "base64",
  );
  const { kind: _kind, ...body } = subject;

  return { ...body, signature, signing_key: key.id };
}

function signedLease(
  pool: Pool,
  digest: string,
  key: SigningKey,
  options: { root?: string; attemptId?: string; runId?: string; claim?: string } = {},
): Frame {
  const attemptId = options.attemptId ?? "attempt-1";
  const config = { root: options.root ?? pool.root };
  const frame = lease(
    attemptId,
    options.runId ?? "run-1",
    digest,
    options.claim ?? "claim-1",
    pool.root,
  );
  const input = frame["input"] as Frame;
  input["output_storage_ref"] = `out.${attemptId}`;
  input["bindings"] = {
    lake: { type: "filesystem", config, secrets: {}, mode: "live" },
  };
  frame["signatures"] = {
    deployment: signedSubject({ kind: "deployment", bundle_digest: digest }, key),
    environment: signedSubject({ kind: "environment", name: "prod", storage_prefix: "out" }, key),
    bindings: {
      lake: signedSubject(
        {
          kind: "binding",
          name: "lake",
          type: "filesystem",
          config,
          secret_refs: {},
          mode: "live",
        },
        key,
      ),
    },
  };

  return frame;
}

async function expectTerminal(pool: Pool, frame: Frame, reason: string): Promise<void> {
  const digest = (frame["execution"] as Frame)["bundle_digest"];
  pool.send(frame);
  await pool.until("refused", () => completes(pool, "attempt-1").length === 1);

  expect(completes(pool, "attempt-1")[0]?.["result"]).toEqual({
    event: "error",
    class: "terminal",
    message: reason,
  });
  expect(pool.stdout.map((line) => JSON.parse(line) as Frame)).toContainEqual(
    expect.objectContaining({
      lease: "refused",
      attempt_id: "attempt-1",
      bundle_digest: digest,
      reason,
    }),
  );
  expect(pool.downloads()).toBe(0);
  expect(existsSync(join(pool.root, "pid-1"))).toBe(false);
}

function secretEnv(root: string, options: StartOptions): Record<string, string> {
  if (!options.secretFiles) return {};

  const dir = join(root, "secrets");
  mkdirSync(dir);

  for (const [name, value] of Object.entries(options.secretFiles)) {
    writeFileSync(join(dir, name), value);
  }

  return { PUPPI_SECRETS_DIR: dir };
}

function trustedEnv(options: StartOptions): Record<string, string> {
  return options.trustedKeys ? { PUPPI_TRUSTED_KEYS: options.trustedKeys } : {};
}

function termCount(pidFile: string, termFile: string): string {
  return `import { existsSync, readFileSync, writeFileSync } from "node:fs";
    export default {
      adapters: {},
      assets: {
        "source/things": {
          key: "source/things",
          checks: {},
          config: {},
          run: async () => {
            process.on("SIGTERM", () => {
              const count = existsSync(${JSON.stringify(termFile)})
                ? Number(readFileSync(${JSON.stringify(termFile)}, "utf8"))
                : 0;
              writeFileSync(${JSON.stringify(termFile)}, String(count + 1));
            });
            writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
            await new Promise(() => setInterval(() => undefined, 1_000));
          },
        },
      },
    };`;
}

function stubborn(pidFile: string, termFile: string): string {
  return `import { writeFileSync } from "node:fs";
    export default {
      adapters: {},
      assets: {
        "source/things": {
          key: "source/things",
          checks: {},
          config: {},
          run: async () => {
            process.on("SIGTERM", () => {
              writeFileSync(${JSON.stringify(termFile)}, String(Date.now()));
            });
            writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
            await new Promise(() => setInterval(() => undefined, 1_000));
          },
        },
      },
    };`;
}

function strictBundle(): string {
  return bundle(
    `ctx.log(${JSON.stringify(sentinel)});
     ctx.telemetry.event("noted", { email: ${JSON.stringify(sentinel)}, rows: 3, ok: true });
     console.log(${JSON.stringify(sentinel)});
     console.error(${JSON.stringify(sentinel)});
     await ctx.emit([{ id: 1 }]);`,
    `checks: { custom: { contact: { severity: "block" } } },
     customChecks: { contact: async () => ({ result: "fail", detail: ${JSON.stringify(sentinel)} }) },`,
  );
}

function scratchChildren(root: string): string[] {
  const dir = join(root, "puppi-pool-droplet-1");
  if (!existsSync(dir)) return [];

  return readdirSync(dir).filter((name) => name.startsWith("puppi-"));
}

function dropTables(
  attemptId: string,
  digest: string,
  claimToken: string,
  root: string,
  refs: string[],
): Frame {
  return {
    message: "drop-tables",
    attempt_id: attemptId,
    fence: 1,
    claim_token: claimToken,
    connection: "lake",
    binding: { type: "filesystem", config: { root }, secrets: {}, mode: "live" },
    storage_refs: refs,
    bundle_digest: digest,
  };
}

function lease(
  attemptId: string,
  runId: string,
  digest: string,
  claimToken: string,
  root: string,
): Frame {
  return {
    message: "lease",
    claim_token: claimToken,
    execution: {
      attempt_id: attemptId,
      run_id: runId,
      fence: 1,
      runtime_profile: "remote-node",
      bundle_digest: digest,
      output_materialization_id: `mat-${attemptId}`,
      lease_expires_at: null,
      deadline_at: null,
    },
    input: {
      bundle_ref: "engine-local",
      sdk_version: "0.2.0",
      asset_key: "source/things",
      partition: "",
      inputs: {},
      checkpoint: null,
      cursor_from: null,
      bindings: {
        lake: { type: "filesystem", config: { root }, secrets: {}, mode: "live" },
      },
      storage_connection: "lake",
      output_storage_ref: `out.${attemptId}`,
    },
  };
}

const published = new WeakMap<Pool, Map<string, Buffer>>();

function publish(pool: Pool, token: string, source: string): string {
  const bytes = Buffer.from(bundleCarryingStorage(source));
  remember(pool, token, bytes);
  return digestOf(bytes);
}

function remember(pool: Pool, token: string, bytes: Buffer): void {
  const bundles = published.get(pool);
  if (!bundles) throw new Error("pool has no bundle table");
  bundles.set(token, bytes);
}

function digestOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function inherited(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...overrides };

  for (const key of ["PATH", "HOME", "LANG"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  return env;
}

function rawText(data: Buffer | ArrayBuffer | Buffer[] | string): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function lockScratchParents(root: string): () => void {
  mkdirSync(join(root, "cache"), { recursive: true });
  const locked = [root];
  chmodSync(root, 0o555);

  for (const name of readdirSync(root)) {
    if (!name.startsWith("puppi")) continue;

    const path = join(root, name);
    if (!statSync(path).isDirectory()) continue;

    chmodSync(path, 0o555);
    locked.push(path);
  }

  return () => {
    for (const path of locked) chmodSync(path, 0o755);
  };
}

function releaseNothing(): void {
  return undefined;
}

interface StartOptions {
  slots?: number;
  residency?: "standard" | "strict";
  gate?: Gate;
  waitForReady?: boolean;
  holdBundle?: boolean;
  settle?: boolean;
  holdCheckpoint?: boolean;
  secretFiles?: Record<string, string>;
  trustedKeys?: string;
  prepare?: (root: string) => void;
}

interface SigningKey {
  id: string;
  fingerprint: string;
  privateKey: KeyObject;
}

async function start(options: StartOptions = {}): Promise<Pool> {
  const root = mkdtempSync(join(tmpdir(), "puppi-pool-"));
  const cacheDir = join(root, "cache");
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, `${workerToken}\n`);
  const bundles = new Map<string, Buffer>();
  const frames: Frame[] = [];
  const stdout: string[] = [];
  const upgradeTimes: number[] = [];
  const clients: WebSocket[] = [];
  let stderr = "";
  let downloads = 0;
  let arrivals = 0;
  const readyAt: number[] = [];
  let headers: Record<string, string | undefined> = {};
  const gate = { current: options.gate ?? "open" };
  let releaseBundle = releaseNothing;
  const held = options.holdBundle
    ? new Promise<void>((resolveHold) => {
        releaseBundle = resolveHold;
      })
    : null;

  const server = createServer((request, response) => {
    if (request.headers.upgrade) return;
    void onRequest(request, response);
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  const sockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    upgradeTimes.push(Date.now());
    headers = {};
    for (const [key, value] of Object.entries(request.headers)) {
      headers[key] = Array.isArray(value) ? value.join(",") : value;
    }

    if (gate.current === "forbidden") {
      rejectUpgrade(socket, 403, JSON.stringify({ error: `incompatible worker; pull ${image}` }));
      return;
    }

    if (gate.current === "unauthorized") {
      rejectUpgrade(socket, 401, "");
      return;
    }

    sockets.handleUpgrade(request, socket, head, (ws) => {
      clients.push(ws);
      let holdEvents = false;

      ws.on("message", (data) => {
        const parsed: unknown = JSON.parse(rawText(data));
        if (!isFrame(parsed)) return;

        frames.push(parsed);
        if (parsed["message"] === "ready") readyAt.push(Date.now());

        if (parsed["message"] === "event") {
          // A checkpoint and the span beside it leave in one turn. Holding
          // the checkpoint holds every later ack, matching the socket's
          // per-attempt order, so the span cannot release the seal.
          if (
            options.holdCheckpoint === true &&
            record(parsed["event"])["event"] === "checkpoint"
          ) {
            holdEvents = true;
          }

          if (holdEvents) return;

          ws.send(
            JSON.stringify({
              message: "settled",
              attempt_id: parsed["attempt_id"],
              fence: parsed["fence"],
              fenced: false,
            }),
          );

          return;
        }

        if (options.settle === false || parsed["message"] !== "complete") return;

        ws.send(
          JSON.stringify({
            message: "settled",
            attempt_id: parsed["attempt_id"],
            fence: parsed["fence"],
            outcome: "recorded",
          }),
        );
      });
      ws.on("error", () => undefined);
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");

  options.prepare?.(root);

  const child = spawn(process.execPath, [entry], {
    env: inherited({
      TMPDIR: root,
      PUPPI_ENGINE_URL: `http://127.0.0.1:${address.port}`,
      PUPPI_WORKER_TOKEN_FILE: tokenFile,
      PUPPI_WORKER_ID: "droplet-1",
      PUPPI_WORKER_SLOTS: String(options.slots ?? 1),
      PUPPI_RESIDENCY: options.residency ?? "standard",
      PUPPI_BUNDLE_CACHE: cacheDir,
      ...secretEnv(root, options),
      ...trustedEnv(options),
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (child.stdout) {
    createInterface({ input: child.stdout }).on("line", (line) => stdout.push(line));
  }
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", () => undefined);

  const pool: Pool = {
    frames,
    stdout,
    root,
    cacheDir,
    downloads: () => downloads,
    upgradeTimes: () => upgradeTimes,
    headers: () => headers,
    send(frame) {
      const open = clients.filter((ws) => ws.readyState === WebSocket.OPEN);
      const current = open[open.length - 1];
      if (!current) throw new Error("no worker socket");
      current.send(JSON.stringify(frame));
    },
    closeSockets() {
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      }
    },
    gate,
    pid: child.pid,
    exitCode: () => child.exitCode,
    stderr: () => stderr,
    bundleArrivals: () => arrivals,
    releaseBundle,
    readyAt: () => readyAt,
    until(label, ready, ms = 8_000) {
      return waitFor(label, ready, () => ({ frames, stdout, stderr }), ms);
    },
  };
  published.set(pool, bundles);

  cleanups.push(() => shutdown(child, server, clients, root));

  if (options.waitForReady !== false) {
    await pool.until("ready", () => frames.some((frame) => frame["message"] === "ready"));
  }

  return pool;

  async function onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? "";

    if (url === "/api/v1/executor/claims/bundle") {
      arrivals += 1;
      if (held) await held;

      const header = request.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      const bytes = bundles.get(token);

      if (!bytes) {
        response.writeHead(404);
        response.end();
        return;
      }

      downloads += 1;
      response.writeHead(200);
      response.end(bytes);
      return;
    }

    if (gate.current === "forbidden") {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `incompatible worker; pull ${image}` }));
      return;
    }

    if (gate.current === "unauthorized") {
      response.writeHead(401);
      response.end();
      return;
    }

    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "upgrade_required" }));
  }
}

function rejectUpgrade(socket: Duplex, status: number, body: string): void {
  socket.on("error", () => undefined);
  const reason = status === 403 ? "Forbidden" : "Unauthorized";
  const payload = Buffer.from(body);
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
  );
  socket.end(payload);
}

async function waitFor(
  label: string,
  ready: () => boolean,
  detail: () => { frames: Frame[]; stdout: string[]; stderr: string },
  ms: number,
): Promise<void> {
  const deadline = Date.now() + ms;

  while (!ready()) {
    if (Date.now() >= deadline) {
      const snapshot = detail();
      throw new Error(
        `${label}\nframes=${JSON.stringify(snapshot.frames)}\nstdout=${snapshot.stdout.join("\n")}\nstderr=${snapshot.stderr}`,
      );
    }

    await delay(20);
  }
}

async function shutdown(
  child: ChildProcess,
  server: Server,
  clients: WebSocket[],
  root: string,
): Promise<void> {
  killPids(root);

  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }

  for (const ws of clients) ws.terminate();

  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
    setTimeout(resolveClose, 300);
  });
  rmSync(root, { recursive: true, force: true });
}

function killPids(root: string): void {
  let names: string[] = [];

  try {
    names = readdirSync(root);
  } catch {
    return;
  }

  for (const name of names) {
    if (!name.startsWith("pid")) continue;

    const value = Number(readFileSync(join(root, name), "utf8"));
    if (!Number.isInteger(value) || value <= 0) continue;

    try {
      process.kill(value, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
