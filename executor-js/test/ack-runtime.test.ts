/**
 * The engine acks every stdout line when `PUPPI_EVENT_ACK=1`. A checkpoint
 * and the span recorded beside it are both waiting in that same turn, so the
 * ack for the checkpoint has to reach the older waiter.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ExecutorEvent, ExecutorInput, Lease, OutboundEnvelope } from "../src/protocol.js";
import { bundleCarryingStorage } from "./support/storage-adapters.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../dist/runtime.js");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("an acking parent", () => {
  it("finishes a two-page append in one attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "puppi-ack-"));
    roots.push(root);
    const bundle = join(root, "bundle.mjs");

    writeFileSync(
      bundle,
      bundleCarryingStorage(`export default {
        assets: {
          "source/things": {
            key: "source/things",
            group: "default",
            visibility: "project",
            role: "source",
            producer: "ts",
            deps: [],
            connections: [],
            partitioning: {},
            checks: {},
            config: { mode: "append", cursor: "created" },
            run: async (ctx) => {
              ctx.checkpoint({ created: 20, page: "p2" });
              await ctx.emit([{ id: 1, created: 20 }]);
              ctx.checkpoint({ created: 50, page: null });
              await ctx.emit([{ id: 2, created: 50 }]);
            },
          },
        },
        adapters: {},
      };`),
    );

    const input: ExecutorInput = {
      bundle_ref: bundle,
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
      output_storage_ref: "run.things__ack",
      connections: {},
    };

    const events = await runAcked(input);
    const results = events.filter((event) => event.event === "result");

    expect(events.filter((event) => event.event === "error")).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      stats: { row_count: 2 },
      cursor_to: "50",
    });
  }, 8_000);

  it("stdin EOF removes the scratch directory and exits 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "puppi-ack-root-"));
    roots.push(root);
    const scratch = mkdtempSync(join(root, "puppi-"));
    writeFileSync(join(scratch, "bundle.mjs"), "leak");

    const code = await exitOnEof({ PUPPI_SCRATCH: scratch });

    expect({ code, scratch: existsSync(scratch) }).toEqual({ code: 1, scratch: false });
  });

  it("stdin EOF does not remove a directory outside the scratch root", async () => {
    const root = mkdtempSync(join(tmpdir(), "puppi-ack-root-"));
    const outside = mkdtempSync(join(tmpdir(), "puppi-outside-"));
    roots.push(root, outside);
    const scratch = mkdtempSync(join(root, "puppi-"));
    const bundle = join(root, "bundle.mjs");
    const marker = join(root, "ready");
    writeFileSync(join(outside, "keep"), "x");
    writeFileSync(
      bundle,
      bundleCarryingStorage(`import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(marker)}, "ready");
        process.env.PUPPI_SCRATCH = ${JSON.stringify(outside)};
        export default {
          adapters: {},
          assets: {
            "source/things": {
              key: "source/things",
              group: "default",
              visibility: "project",
              role: "source",
              producer: "ts",
              deps: [],
              connections: [],
              partitioning: {},
              checks: {},
              config: {},
              run: async () => {
                setInterval(() => {}, 1_000);
                await new Promise(() => {});
              },
            },
          },
        };`),
    );

    const code = await exitOnEof({ PUPPI_SCRATCH: scratch }, async (child) => {
      const stdin = child.stdin;
      if (!stdin) throw new Error("runtime stdin was not piped");
      stdin.write(`${JSON.stringify(leaseFor(hangInput(bundle, root)))}\n`);
      const deadline = Date.now() + 3_000;
      while (!existsSync(marker) && Date.now() < deadline) await delay(20);
      if (!existsSync(marker)) throw new Error("bundle never retargeted scratch");
      stdin.end();
    });

    expect({
      code,
      scratch: existsSync(scratch),
      outside: existsSync(join(outside, "keep")),
    }).toEqual({ code: 1, scratch: false, outside: true });
  });
});

function leaseFor(input: ExecutorInput): Lease {
  return {
    message: "lease",
    execution: {
      attempt_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      run_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      fence: 1,
      runtime_profile: "local-node",
      bundle_digest: null,
      output_materialization_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      lease_expires_at: null,
      deadline_at: null,
    },
    input,
  };
}

function hangInput(bundle: string, root: string): ExecutorInput {
  return {
    bundle_ref: bundle,
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
    output_storage_ref: "run.things__ack",
    connections: {},
  };
}

function exitOnEof(
  env: Record<string, string>,
  drive?: (child: ChildProcess) => Promise<void>,
): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, PUPPI_EVENT_ACK: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);

    const finish = (code: number | null): void => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      resolveExit(code);
    };

    const fail = (error: unknown): void => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    child.on("error", fail);
    child.on("exit", (code) => finish(code));
    child.stderr?.on("data", () => undefined);
    child.stdout?.on("data", () => undefined);

    if (drive) {
      void drive(child).catch(fail);
      return;
    }

    child.stdin?.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function runAcked(input: ExecutorInput): Promise<ExecutorEvent[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, PUPPI_EVENT_ACK: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdin = child.stdin;
    const stdout = child.stdout;

    if (!stdin || !stdout) {
      child.kill();
      reject(new Error("runtime stdio was not piped"));
      return;
    }

    const events: ExecutorEvent[] = [];
    const stderr: Buffer[] = [];
    const lines = createInterface({ input: stdout });
    let exitCode: number | null = null;
    let stdoutClosed = false;
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 3_000);

    const finish = (): void => {
      if (settled || exitCode === null || !stdoutClosed) return;

      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new Error(`acked runtime did not finish\n${Buffer.concat(stderr).toString("utf8")}`),
        );
        return;
      }

      if (exitCode !== 0) {
        reject(new Error(`runtime exited ${exitCode}\n${Buffer.concat(stderr).toString("utf8")}`));
        return;
      }

      resolvePromise(events);
    };

    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      exitCode = code ?? 1;
      finish();
    });
    lines.on("line", (line) => {
      if (!line.trim()) return;

      const envelope = JSON.parse(line) as OutboundEnvelope;
      const event = envelope.message === "complete" ? envelope.result : envelope.event;
      events.push(event);
      const ack = event.event === "result" ? { outcome: "recorded" } : { ok: true };
      stdin.write(`${JSON.stringify(ack)}\n`);
    });
    lines.on("close", () => {
      stdoutClosed = true;
      finish();
    });
    stdin.on("error", () => undefined);
    stdin.write(`${JSON.stringify(leaseFor(input))}\n`);
  });
}
