import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { isTransient } from "@puppi/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../src/index.js";
import { sha256, sign } from "../src/sigv4.js";

/**
 * Storage checks against MinIO: head miss and hit, a small PUT, a multipart
 * object with a short last part, a read back, sha256 of the stored bytes, the binding
 * prefix, encoded keys, an aborted upload, and a terminal 403.
 * `podcasts/audio` itself is not this package.
 *
 * CI starts the community image pinned below: a `go install` rebuild of
 * RELEASE.2025-10-15T17-29-55Z, not the upstream binary. Docker Hub no
 * longer has `minio/minio`. A machine without docker uses a `minio` binary.
 */

const exec = promisify(execFile);
const ACCESS = "testaccess";
const SECRET = "testsecret";
const PART = 8 * 1024 * 1024;
/** `alpine/minio:RELEASE.2025-10-15T17-29-55Z`. A community `go install` rebuild, not the upstream binary. */
const MINIO_IMAGE =
  "alpine/minio@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4";

const secrets = { access_key_id: ACCESS, secret_access_key: SECRET };

let endpoint = "";
let stop = async (): Promise<void> => {};

beforeAll(async () => {
  const started = await startMinio();
  endpoint = started.endpoint;
  stop = started.stop;
  await createBucket(endpoint);
}, 180_000);

afterAll(async () => {
  await stop();
});

describe("minio", () => {
  it("stores a small object and a multipart object, and a second write replaces the first", async () => {
    const store = open();
    const small = randomBytes(3 * 1024 * 1024);
    const large = randomBytes(PART + 123);

    const first = await store.putStream("f1/ep1.mp3", streamOf(small), {
      contentType: "audio/mpeg",
      contentLength: small.length,
    });
    const second = await store.putStream("f1/ep2.mp3", streamOf(large), {
      contentType: "audio/mpeg",
      contentLength: large.length,
    });

    expect(first).toMatchObject({ bytes: small.length, sha256: sha(small) });
    expect(second).toMatchObject({ bytes: large.length, sha256: sha(large) });
    expect(second.etag).toMatch(/-2/);
    expect(await storedHash("audio/f1/ep1.mp3")).toEqual({
      bytes: small.length,
      sha256: sha(small),
    });
    expect(await storedHash("audio/f1/ep2.mp3")).toEqual({
      bytes: large.length,
      sha256: sha(large),
    });
    expect(await store.head("f1/ep1.mp3")).toEqual({
      bytes: small.length,
      contentType: "audio/mpeg",
    });
    expect(await store.head("f1/missing.mp3")).toBeNull();

    const replaced = randomBytes(32);
    await store.putStream("f1/ep1.mp3", streamOf(replaced), { contentType: "audio/mpeg" });
    expect(await storedHash("audio/f1/ep1.mp3")).toEqual({
      bytes: replaced.length,
      sha256: sha(replaced),
    });
    expect(await store.head("f1/ep1.mp3")).toMatchObject({ bytes: replaced.length });
  }, 120_000);

  it("gets a multipart object back, and a missing key is terminal", async () => {
    const store = open();
    const large = randomBytes(PART + 123);

    await store.putStream("f1/read.mp3", streamOf(large), { contentType: "audio/mpeg" });
    const read = new Uint8Array(await new Response(await store.get("f1/read.mp3")).arrayBuffer());

    expect(sha(read)).toBe(sha(large));

    const error = await store.get("f1/missing.mp3").catch((caught: unknown) => caught);

    expect((error as Error).message).toBe("nothing at audio/f1/missing.mp3");
    expect(isTransient(error)).toBe(false);
  }, 60_000);

  it("encodes a key with a space and unicode", async () => {
    const store = open();
    const bytes = Uint8Array.from([1, 2, 3, 9]);

    await store.putStream("café/episode 1.mp3", streamOf(bytes), { contentType: "audio/mpeg" });

    expect(await store.head("café/episode 1.mp3")).toEqual({
      bytes: 4,
      contentType: "audio/mpeg",
    });
    expect(await storedHash("audio/café/episode 1.mp3")).toEqual({ bytes: 4, sha256: sha(bytes) });
  });

  it("aborts a failed upload so the bucket has no object and no pending upload", async () => {
    const store = open();

    await expect(store.putStream("f1/broken.mp3", dieAfter(PART + 1), {})).rejects.toThrow(
      /download failed/,
    );

    expect(await store.head("f1/broken.mp3")).toBeNull();
    const listed = await signed(`${endpoint}/podcasts?uploads=`);
    expect(listed).not.toContain("<Upload>");
  }, 60_000);

  it("reports a bad key as terminal", async () => {
    const store = new Client(config(), {
      access_key_id: ACCESS,
      secret_access_key: "not-the-secret",
    });
    const error = await store
      .putStream("f1/nope.mp3", streamOf(Uint8Array.from([1])), {})
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 403 });
    expect(isTransient(error)).toBe(false);
  });
});

function open(): Client {
  return new Client({ ...config(), prefix: "audio" }, secrets);
}

function config(): Record<string, string> {
  return { bucket: "podcasts", region: "us-east-1", endpoint };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;

  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }

      const end = Math.min(bytes.length, offset + 64 * 1024);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

function dieAfter(total: number): ReadableStream<Uint8Array> {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024);

  return new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.error(new Error("download failed"));
        return;
      }

      const n = Math.min(chunk.length, total - sent);
      controller.enqueue(chunk.subarray(0, n));
      sent += n;
    },
  });
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function storedHash(key: string): Promise<{ bytes: number; sha256: string }> {
  const path = key.split("/").map(encodeURIComponent).join("/");
  const response = await signedFetch(`${endpoint}/podcasts/${path}`);

  if (!response.ok) {
    throw new Error(
      `GET ${key} answered ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
  }

  const body = new Uint8Array(await response.arrayBuffer());

  return { bytes: body.byteLength, sha256: sha(body) };
}

async function signed(url: string): Promise<string> {
  const response = await signedFetch(url);

  return response.text();
}

function signedFetch(url: string, method = "GET"): Promise<Response> {
  const body = new Uint8Array();
  const headers = sign(
    { method, url, headers: { "x-amz-content-sha256": sha256(body) }, body },
    {
      region: "us-east-1",
      service: "s3",
      credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
    },
  );

  return fetch(url, { method, headers });
}

async function createBucket(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last = "no response";

  while (Date.now() < deadline) {
    const response = await signedFetch(`${url}/podcasts`, "PUT");

    if (response.ok || response.status === 409) return;

    last = `${response.status} ${await response.text()}`;
    if (response.status !== 503) break;

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`create bucket answered ${last}`);
}

async function startMinio(): Promise<{ endpoint: string; stop: () => Promise<void> }> {
  if (await exists("docker")) return startDocker();
  if (await exists("minio")) return startBinary("minio");

  throw new Error("minio conformance needs docker or a minio binary on PATH");
}

async function startDocker(): Promise<{ endpoint: string; stop: () => Promise<void> }> {
  const name = `puppi-s3-${process.pid}`;
  // The image runs as user `minio`. Its `/data` volume is root-owned, so the
  // server stores under `/tmp`, which that user can create.

  await exec("docker", [
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::9000",
    "-e",
    `MINIO_ROOT_USER=${ACCESS}`,
    "-e",
    `MINIO_ROOT_PASSWORD=${SECRET}`,
    MINIO_IMAGE,
    "server",
    "/tmp/minio",
  ]);

  const { stdout } = await exec("docker", ["port", name, "9000"]);
  const port = /:(\d+)\s*$/m.exec(stdout)?.[1];

  if (!port) throw new Error(`docker did not publish 9000: ${stdout}`);

  const base = `http://127.0.0.1:${port}`;

  try {
    await waitFor(`${base}/minio/health/ready`);
  } catch (error) {
    const logs = await exec("docker", ["logs", name]).catch(() => ({ stdout: "", stderr: "" }));
    const detail = `${logs.stderr}\n${logs.stdout}`.trim();
    const message = error instanceof Error ? error.message : String(error);

    await exec("docker", ["rm", "-f", name]).catch(() => undefined);

    throw new Error(detail ? `${message}\n${detail}` : message, { cause: error });
  }

  return {
    endpoint: base,
    stop: async () => {
      await exec("docker", ["rm", "-f", name]).catch(() => undefined);
    },
  };
}

async function startBinary(bin: string): Promise<{ endpoint: string; stop: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "puppi-minio-"));
  const port = await freePort();
  const child = spawn(bin, ["server", join(dir, "data"), "--address", `127.0.0.1:${port}`], {
    env: { ...process.env, MINIO_ROOT_USER: ACCESS, MINIO_ROOT_PASSWORD: SECRET },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/minio/health/ready`);

  return {
    endpoint: base,
    stop: async () => {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function exists(command: string): Promise<boolean> {
  return exec("sh", ["-c", `command -v ${command}`]).then(
    () => true,
    () => false,
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }

      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = "not up";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.ok) return;

      last = `${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`minio did not answer ${url}: ${last}`);
}
