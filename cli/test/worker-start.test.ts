/**
 * `puppi worker start` runs the pool entry in the foreground. The spawn is
 * fake: the test is about the arguments, not a live socket.
 */

import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");

  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter();

      setImmediate(() => child.emit("close", 0));

      return child;
    }),
  };
});

const { spawn } = await import("node:child_process");

const { poolEntry } = await import("../src/harness.js");
const { main } = await import("../src/index.js");

let dir: string;

afterEach(async () => {
  vi.clearAllMocks();
  delete process.env["PUPPI_WORKER_TOKEN"];
  delete process.env["PUPPI_WORKER_TOKEN_FILE"];
  delete process.env["PUPPI_WORKER_SLOTS"];
  delete process.env["PUPPI_SIGNING_KEY"];
  delete process.env["PUPPI_API_TOKEN"];
  delete process.env["PUPPI_SECRET_KEY"];
  delete process.env["PUPPI_SECRET_WAREHOUSE_PASSWORD"];
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("puppi worker start", () => {
  it("runs the pool entry this CLI depends on, with the slot count", async () => {
    dir = await mkdtemp(join(tmpdir(), "puppi-pool-"));
    process.env["PUPPI_WORKER_TOKEN"] = "pwt_test";
    process.env["PUPPI_SIGNING_KEY"] = "ed25519:seed";
    process.env["PUPPI_API_TOKEN"] = "bearer";
    process.env["PUPPI_SECRET_KEY"] = "master";
    process.env["PUPPI_SECRET_WAREHOUSE_PASSWORD"] = "s3cr3t";
    delete process.env["PUPPI_WORKER_SLOTS"];

    const project = await mkdtemp(join(tmpdir(), "puppi-project-"));
    const pool = poolEntry(project);

    try {
      expect(
        await main([
          "worker",
          "start",
          "--slots",
          "4",
          "--dir",
          project,
          "--engine-url",
          "http://engine:4000",
        ]),
      ).toBe(0);
    } finally {
      await rm(project, { recursive: true, force: true });
    }

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [pool],
      expect.objectContaining({
        stdio: "inherit",
        env: expect.objectContaining({
          PUPPI_ENGINE_URL: "http://engine:4000",
          PUPPI_WORKER_SLOTS: "4",
          PUPPI_WORKER_TOKEN: "pwt_test",
          PUPPI_SECRET_WAREHOUSE_PASSWORD: "s3cr3t",
        }),
      }),
    );

    const env = vi.mocked(spawn).mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;

    expect(env["PUPPI_SIGNING_KEY"]).toBeUndefined();
    expect(env["PUPPI_API_TOKEN"]).toBeUndefined();
    expect(env["PUPPI_SECRET_KEY"]).toBeUndefined();
  });

  it("needs a worker token, and --slots has to be a positive integer", async () => {
    dir = await mkdtemp(join(tmpdir(), "puppi-pool-"));
    delete process.env["PUPPI_WORKER_TOKEN"];
    delete process.env["PUPPI_WORKER_TOKEN_FILE"];

    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    expect(await main(["worker", "start", "--dir", dir])).toBe(2);
    expect(stderr.join("")).toContain("PUPPI_WORKER_TOKEN");

    process.env["PUPPI_WORKER_TOKEN"] = "pwt_test";
    expect(await main(["worker", "start", "--slots", "0", "--dir", dir])).toBe(2);
    expect(spawn).not.toHaveBeenCalled();
  });
});
