import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import type { ExecutorInput } from "../src/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../dist/worker/main.js");
const bundle = Buffer.from("this is not valid javascript");
const digest = `sha256:${createHash("sha256").update(bundle).digest("hex")}`;

const input: ExecutorInput = {
  bundle_ref: "replaced-by-test-server",
  sdk_version: "0.2.0",
  asset_key: "source/things",
  partition: "",
  inputs: {},
  checkpoint: null,
  cursor_from: null,
  bindings: {},
  storage_connection: null,
  output_storage_ref: "test.source_things",
  connections: {},
};

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

describe("the remote worker", () => {
  it("claims, verifies and executes one bundle, then reports one terminal result", async () => {
    const received: Array<{ path: string; body: Record<string, unknown> }> = [];
    const token = "one-attempt-token";
    let base = "";

    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);

      if (request.url === "/lease") {
        return json(response, {
          message: "lease",
          execution: {
            attempt_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            run_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            fence: 1,
            runtime_profile: "remote-node",
            bundle_digest: digest,
            output_materialization_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
            lease_expires_at: null,
            deadline_at: null,
          },
          input: { ...input, bundle_ref: `${base}/bundle` },
        });
      }

      if (request.url === "/bundle") {
        response.writeHead(200, { "content-type": "text/javascript" });
        return response.end(bundle);
      }

      const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      received.push({ path: request.url ?? "", body });
      response.writeHead(202);
      response.end();
    });

    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    base = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise((resolveClose) => server.close(() => resolveClose()));

    const { code } = await runWorker({
      PUPPI_CLAIM_URL: base,
      PUPPI_CLAIM_TOKEN: token,
    });

    expect(code).toBe(1);
    expect(received.map(({ path }) => path)).toEqual(["/events", "/complete"]);
    expect(received[0]?.body).toMatchObject({
      message: "event",
      fence: 1,
      seq: 1,
      event: { event: "span", name: "bundle_loaded", attributes: { error: true } },
    });
    expect(received[1]?.body).toMatchObject({
      message: "complete",
      fence: 1,
      last_seq: 1,
      result: { event: "error", class: "terminal" },
    });
  });

  it("stops when the engine rejects the fence", async () => {
    const received: string[] = [];
    const token = "fenced-attempt-token";
    let base = "";

    const server = createServer(async (request, response) => {
      if (request.url === "/lease") {
        return json(response, {
          message: "lease",
          execution: {
            attempt_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            run_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            fence: 1,
            runtime_profile: "remote-node",
            bundle_digest: digest,
            output_materialization_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
            lease_expires_at: null,
            deadline_at: null,
          },
          input: { ...input, bundle_ref: `${base}/bundle` },
        });
      }

      if (request.url === "/bundle") {
        response.writeHead(200, { "content-type": "text/javascript" });
        return response.end(bundle);
      }

      await readBody(request);
      received.push(request.url ?? "");
      response.writeHead(409);
      response.end();
    });

    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    base = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise((resolveClose) => server.close(() => resolveClose()));

    const { code } = await runWorker({
      PUPPI_CLAIM_URL: base,
      PUPPI_CLAIM_TOKEN: token,
    });

    expect(code).toBe(0);
    expect(received).toEqual(["/events", "/complete"]);
  });

  it("removes the downloaded bundle and the attempt temp files", async () => {
    const root = mkdtempSync(join(tmpdir(), "puppi-remote-"));
    const note = join(root, "leak-note");
    const attemptId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const source = Buffer.from(`import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "podcast-index-"));
writeFileSync(join(dir, "dump.bin"), "leak");
writeFileSync(process.env.PUPPI_LEAK_NOTE, JSON.stringify({ tmp: tmpdir(), dir }));
export default { adapters: {}, assets: {} };
`);
    const sourceDigest = `sha256:${createHash("sha256").update(source).digest("hex")}`;
    let base = "";

    const server = createServer(async (request, response) => {
      if (request.url === "/lease") {
        return json(response, {
          message: "lease",
          execution: {
            attempt_id: attemptId,
            run_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            fence: 1,
            runtime_profile: "remote-node",
            bundle_digest: sourceDigest,
            output_materialization_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
            lease_expires_at: null,
            deadline_at: null,
          },
          input: { ...input, bundle_ref: `${base}/bundle` },
        });
      }

      if (request.url === "/bundle") {
        response.writeHead(200, { "content-type": "text/javascript" });
        return response.end(source);
      }

      await readBody(request);
      response.writeHead(202);
      response.end();
    });

    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    base = `http://127.0.0.1:${address.port}`;
    closeServer = () =>
      new Promise((resolveClose) => {
        rmSync(root, { recursive: true, force: true });
        server.close(() => resolveClose());
      });

    const { code } = await runWorker({
      PUPPI_CLAIM_URL: base,
      PUPPI_CLAIM_TOKEN: "scratch-attempt-token",
      PUPPI_LEAK_NOTE: note,
      TMPDIR: root,
    });

    const recorded = JSON.parse(readFileSync(note, "utf8")) as { tmp: string; dir: string };
    expect(code).toBe(1);
    expect(existsSync(recorded.tmp)).toBe(false);
    expect(existsSync(recorded.dir)).toBe(false);
    expect(readdirSync(root)).toEqual(["leak-note"]);
  });

  it("boot removes only this worker's leftover scratch directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "puppi-remote-"));
    const host = "scratch-host";
    const stale = join(root, `puppi-worker-${host}`, "puppi-stale");
    const kept = join(root, "puppi-other", "puppi-keep");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "leak"), "x");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "keep"), "x");
    const token = "sweep-attempt-token";
    let base = "";

    const server = createServer(async (request, response) => {
      if (request.url === "/lease") {
        return json(response, {
          message: "lease",
          execution: {
            attempt_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            run_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            fence: 1,
            runtime_profile: "remote-node",
            bundle_digest: digest,
            output_materialization_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
            lease_expires_at: null,
            deadline_at: null,
          },
          input: { ...input, bundle_ref: `${base}/bundle` },
        });
      }

      if (request.url === "/bundle") {
        response.writeHead(200, { "content-type": "text/javascript" });
        return response.end(bundle);
      }

      await readBody(request);
      response.writeHead(202);
      response.end();
    });

    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP address");
    base = `http://127.0.0.1:${address.port}`;
    closeServer = () =>
      new Promise((resolveClose) => {
        rmSync(root, { recursive: true, force: true });
        server.close(() => resolveClose());
      });

    await runWorker({
      PUPPI_CLAIM_URL: base,
      PUPPI_CLAIM_TOKEN: token,
      TMPDIR: root,
      HOSTNAME: host,
      FLY_MACHINE_ID: "",
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(kept, "keep"))).toBe(true);
  });
});

function runWorker(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    execFile(
      process.execPath,
      [entry],
      { env: { ...process.env, ...env } },
      (error, _stdout, stderr) => {
        const code = (error as (NodeJS.ErrnoException & { code?: number }) | null)?.code ?? 0;
        if (typeof code !== "number") return reject(error);
        resolveRun({ code, stderr });
      },
    );
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
