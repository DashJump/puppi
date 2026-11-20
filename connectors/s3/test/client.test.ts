import { createHash } from "node:crypto";

import { isTransient } from "@puppi/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Client, type StoreOptions } from "../src/index.js";

const ACCESS = "AKIDEXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const PART = 8 * 1024 * 1024;

const secrets = { access_key_id: ACCESS, secret_access_key: SECRET };

type Fetch = typeof globalThis.fetch;

function client(options: StoreOptions & { config?: Record<string, unknown> } = {}): Client {
  const { config, ...rest } = options;

  return new Client(
    {
      bucket: "podcasts",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:9000",
      ...config,
    },
    secrets,
    rest,
  );
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  const size = 64 * 1024;

  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }

      const end = Math.min(bytes.length, offset + size);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/** Delivers `total` bytes, then fails the next read. One part is already uploaded. */
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

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: Uint8Array;
}

function memoryBucket(options: { complete?: "error" } = {}) {
  const objects = new Map<string, { body: Uint8Array; type: string | null }>();
  const uploads = new Map<string, Map<number, Uint8Array>>();
  const calls: Call[] = [];
  let nextId = 0;

  const fetch: Fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    calls.push({ method: request.method, url: request.url, headers: request.headers, body });

    const key = url.pathname.split("/").slice(2).map(decodeURIComponent).join("/");

    if (request.method === "HEAD") {
      const found = objects.get(key);

      if (!found) return new Response(null, { status: 404 });

      return new Response(null, {
        status: 200,
        headers: {
          "content-length": String(found.body.byteLength),
          "content-type": found.type ?? "application/octet-stream",
        },
      });
    }

    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const id = `upload-${++nextId}`;
      uploads.set(id, new Map());

      return new Response(
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }

    if (request.method === "PUT" && url.searchParams.has("partNumber")) {
      const id = url.searchParams.get("uploadId") ?? "";
      const number = Number(url.searchParams.get("partNumber"));
      uploads.get(id)?.set(number, body);

      return new Response(null, { status: 200, headers: { etag: `"part-${number}"` } });
    }

    if (request.method === "POST" && url.searchParams.has("uploadId")) {
      const id = url.searchParams.get("uploadId") ?? "";

      if (options.complete === "error") {
        return new Response(
          '<Error xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Code>InternalError</Code><Message>no</Message></Error>',
          { status: 200 },
        );
      }

      const parts = [...(uploads.get(id)?.entries() ?? [])].sort((a, b) => a[0] - b[0]);
      const length = parts.reduce((sum, [, part]) => sum + part.byteLength, 0);
      const merged = new Uint8Array(length);
      let offset = 0;

      for (const [, part] of parts) {
        merged.set(part, offset);
        offset += part.byteLength;
      }

      objects.set(key, { body: merged, type: null });
      uploads.delete(id);

      return new Response(
        `<CompleteMultipartUploadResult><ETag>&quot;done-${parts.length}&quot;</ETag></CompleteMultipartUploadResult>`,
      );
    }

    if (request.method === "DELETE") {
      if (url.searchParams.has("uploadId")) {
        uploads.delete(url.searchParams.get("uploadId") ?? "");

        return new Response(null, { status: 204 });
      }

      objects.delete(key);

      return new Response(null, { status: 204 });
    }

    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      return new Response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", {
        status: 200,
      });
    }

    if (request.method === "GET") {
      const found = objects.get(key);

      if (!found) return new Response(null, { status: 404 });

      return new Response(found.body, {
        status: 200,
        headers: {
          "content-type": found.type ?? "application/octet-stream",
          "content-length": String(found.body.byteLength),
        },
      });
    }

    if (request.method === "PUT") {
      objects.set(key, { body, type: request.headers.get("content-type") });

      return new Response(null, { status: 200, headers: { etag: '"single"' } });
    }

    return new Response("unexpected", { status: 500 });
  };

  return { fetch, calls, objects, uploads };
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  for (;;) {
    const next = await reader.read();

    if (next.done) break;
    if (!next.value) continue;

    chunks.push(next.value);
    length += next.value.byteLength;
  }

  const out = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return out;
}

describe("s3", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the missing bucket or secret at construction", () => {
    expect(() => new Client({}, secrets)).toThrow(/"bucket"/);
    expect(() => new Client({ bucket: "podcasts" }, {})).toThrow(/"access_key_id"/);
    expect(() => new Client({ bucket: "podcasts" }, { access_key_id: ACCESS })).toThrow(
      /"secret_access_key"/,
    );
  });

  it("puts a small object in one request and hashes it", async () => {
    const bucket = memoryBucket();
    const store = client({ fetch: bucket.fetch, config: { prefix: "/audio/" } });
    const bytes = Uint8Array.from([1, 2, 3, 4]);

    const put = await store.putStream("f1/ep1.mp3", streamOf(bytes), {
      contentType: "audio/mpeg",
      contentLength: bytes.length,
    });

    expect(put).toEqual({ bytes: 4, sha256: sha(bytes), etag: '"single"' });
    expect(store.keyFor("f1/ep1.mp3")).toBe("audio/f1/ep1.mp3");
    expect(bucket.calls.map((call) => call.method)).toEqual(["PUT"]);
    expect(bucket.calls[0]?.headers.get("content-type")).toBe("audio/mpeg");
    expect(bucket.calls[0]?.headers.get("x-amz-content-sha256")).toBe(sha(bytes));
    expect(decodeURIComponent(new URL(bucket.calls[0]?.url ?? "").pathname)).toBe(
      "/podcasts/audio/f1/ep1.mp3",
    );
    expect(bucket.objects.get("audio/f1/ep1.mp3")?.body).toEqual(bytes);

    const again = await store.putStream("f1/ep1.mp3", streamOf(bytes), {
      contentType: "audio/mpeg",
    });

    expect(again.sha256).toBe(put.sha256);
    expect(bucket.objects.get("audio/f1/ep1.mp3")?.body).toEqual(bytes);
    expect(await store.head("f1/ep1.mp3")).toEqual({ bytes: 4, contentType: "audio/mpeg" });
    expect(await store.exists("f1/ep1.mp3")).toBe(true);
    expect(await store.head("missing")).toBeNull();
    expect(await store.exists("missing")).toBe(false);
    await store.close();
  });

  it("puts, gets, heads, and drops an engine-owned key", async () => {
    const bucket = memoryBucket();
    const store = client({ fetch: bucket.fetch, config: { prefix: "env" } }) as Client & {
      put(
        key: string,
        body: ReadableStream<Uint8Array>,
        options?: { contentType?: string | null },
      ): Promise<{ sha256: string; bytes: number; contentType: string | null }>;
      get(key: string): Promise<ReadableStream<Uint8Array>>;
      drop(key: string): Promise<void>;
    };
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const ref = "prod.podcast_index_dump__abcd1234";

    const put = await store.put(ref, streamOf(bytes), { contentType: "application/gzip" });

    expect(put).toEqual({
      bytes: 4,
      sha256: sha(bytes),
      contentType: "application/gzip",
    });
    expect(await store.head(ref)).toEqual({ bytes: 4, contentType: "application/gzip" });
    expect(await readAll(await store.get(ref))).toEqual(bytes);

    await store.drop(ref);
    expect(await store.head(ref)).toBeNull();
    await store.drop(ref);
  });

  it("splits a body above one part, and a length hint can keep it in one PUT", async () => {
    const bytes = new Uint8Array(PART + 10).fill(9);
    const multipart = memoryBucket();
    const put = await client({ fetch: multipart.fetch }).putStream("ep2.mp3", streamOf(bytes), {
      contentType: null,
      contentLength: null,
    });

    expect(put.sha256).toBe(sha(bytes));
    expect(put.etag).toBe('"done-2"');
    expect(put.bytes).toBe(bytes.length);
    expect(sha(multipart.objects.get("ep2.mp3")?.body ?? new Uint8Array())).toBe(sha(bytes));
    expect(multipart.objects.get("ep2.mp3")?.body.byteLength).toBe(bytes.length);
    expect(multipart.calls.map((call) => call.method)).toEqual(["POST", "PUT", "PUT", "POST"]);
    const complete = multipart.calls[3]?.body;
    const xml = new TextDecoder().decode(complete);
    expect(xml).toContain("<PartNumber>1</PartNumber>");
    expect(xml).toContain("<PartNumber>2</PartNumber>");
    expect(multipart.calls[2]?.body.byteLength).toBe(10);
    expect(multipart.uploads.size).toBe(0);

    const hinted = memoryBucket();
    await client({ fetch: hinted.fetch }).putStream("ep2.mp3", streamOf(bytes), {
      contentLength: 9 * 1024 * 1024 * 10_000,
    });

    expect(hinted.calls.map((call) => call.method)).toEqual(["PUT"]);
  });

  it("encodes spaces and unicode, and signs a fresh request each time", async () => {
    const auths: string[] = [];
    let second = 0;
    const bucket = memoryBucket();
    const store = client({
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const authorization = request.headers.get("authorization") ?? "";
        auths.push(authorization);
        expect(request.url).not.toContain(SECRET);
        expect(authorization).not.toContain(SECRET);
        expect(authorization).toContain(ACCESS);
        expect(request.headers.get("user-agent")).toContain("puppi-adapter-s3");
        expect(request.redirect).toBe("manual");
        return bucket.fetch(request);
      },
      now: () => new Date(Date.UTC(2020, 0, 1, 0, 0, second++)),
      config: { prefix: "audio" },
    });

    await store.putStream("café/episode 1!.mp3", streamOf(Uint8Array.from([7])), {});
    await store.head("café/episode 1!.mp3");

    expect(decodeURIComponent(new URL(bucket.calls[0]?.url ?? "").pathname)).toBe(
      "/podcasts/audio/café/episode 1!.mp3",
    );
    expect(auths).toHaveLength(2);
    expect(auths[0]).not.toBe(auths[1]);
  });

  it("gets a multipart object back under the prefix, retries a 429 and a 503, and names a missing key", async () => {
    const bucket = memoryBucket();
    const store = client({ fetch: bucket.fetch, config: { prefix: "audio" } });
    const bytes = new Uint8Array(PART + 10).fill(5);

    await store.putStream("f1/ep1.mp3", streamOf(bytes), {});
    const read = new Uint8Array(await new Response(await store.get("f1/ep1.mp3")).arrayBuffer());

    expect(sha(read)).toBe(sha(bytes));
    const get = bucket.calls.at(-1);
    expect(get?.method).toBe("GET");
    expect(decodeURIComponent(new URL(get?.url ?? "").pathname)).toBe("/podcasts/audio/f1/ep1.mp3");
    expect(get?.headers.get("authorization")).toContain(ACCESS);

    const error = await store.get("missing.mp3").catch((caught: unknown) => caught);

    expect((error as Error).message).toBe("nothing at audio/missing.mp3");
    expect(isTransient(error)).toBe(false);

    let flaps = 0;
    const flaky = client({
      fetch: async (input, init) => {
        flaps += 1;

        if (flaps === 1) return new Response("slow", { status: 429 });
        if (flaps === 2) return new Response("down", { status: 503 });

        return bucket.fetch(input, init);
      },
      config: { prefix: "audio" },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const pending = flaky.get("f1/ep1.mp3");
    await vi.advanceTimersByTimeAsync(1_000);
    const retried = await new Response(await pending).arrayBuffer();

    expect(flaps).toBe(3);
    expect(retried.byteLength).toBe(bytes.length);
  });

  it("uses a path-style endpoint, and virtual-hosted AWS when the endpoint is omitted", async () => {
    const urls: string[] = [];
    const fetch: Fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      urls.push(request.url);
      const host = new URL(request.url).host;

      if (host.endsWith(".r2.cloudflarestorage.com")) {
        expect(request.headers.get("authorization")).toContain("/auto/s3/aws4_request");
      }

      return new Response(null, { status: 404 });
    };

    await client({
      fetch,
      config: { endpoint: "https://acct.r2.cloudflarestorage.com/", region: "auto" },
    }).head("a");
    await client({ fetch, config: { endpoint: undefined, region: "eu-west-1" } }).head("a");
    await client({ fetch, config: { endpoint: undefined, region: undefined } }).head("a");

    expect(new URL(urls[0] ?? "").host).toBe("acct.r2.cloudflarestorage.com");
    expect(decodeURIComponent(new URL(urls[0] ?? "").pathname)).toBe("/podcasts/a");
    expect(new URL(urls[1] ?? "").host).toBe("podcasts.s3.eu-west-1.amazonaws.com");
    expect(new URL(urls[1] ?? "").pathname).toBe("/a");
    expect(new URL(urls[2] ?? "").host).toBe("podcasts.s3.us-east-1.amazonaws.com");
  });

  it("retries 429, 5xx, and a dropped connection, and leaves 403 terminal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let flaps = 0;
    const flaky: Fetch = async () => {
      flaps += 1;

      if (flaps === 1) return new Response("slow", { status: 429 });
      if (flaps === 2) return new Response("down", { status: 503 });
      if (flaps === 3) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

      return new Response(null, { status: 404 });
    };

    const retried = client({ fetch: flaky }).head("a");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await retried).toBeNull();
    expect(flaps).toBe(4);

    let denied = 0;
    const forbidden: Fetch = async () => {
      denied += 1;

      return new Response("AccessDenied", { status: 403, statusText: "Forbidden" });
    };

    const error = await client({ fetch: forbidden })
      .putStream("a", streamOf(Uint8Array.from([1])), {})
      .catch((caught: unknown) => caught);

    expect(denied).toBe(1);
    expect(error).toMatchObject({ status: 403 });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("403");
    expect(isTransient(error)).toBe(false);

    const pending = client({
      fetch: async () => new Response("down", { status: 500, statusText: "Error" }),
    })
      .head("a")
      .catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(1_000);
    const blown = await pending;

    expect(blown).toMatchObject({ status: 500 });
    expect(isTransient(blown)).toBe(true);
  });

  it("aborts a failed multipart upload and treats an error document on 200 as failure", async () => {
    const aborted = memoryBucket();

    await expect(
      client({ fetch: aborted.fetch }).putStream("ep.mp3", dieAfter(PART + 1), {}),
    ).rejects.toThrow(/download failed/);

    expect(aborted.objects.size).toBe(0);
    expect(aborted.uploads.size).toBe(0);
    expect(aborted.calls.some((call) => call.method === "DELETE")).toBe(true);

    const failed = memoryBucket({ complete: "error" });

    const error = await client({ fetch: failed.fetch })
      .putStream("ep.mp3", streamOf(new Uint8Array(PART + 1)), {})
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 500 });
    expect(isTransient(error)).toBe(true);

    expect(failed.objects.size).toBe(0);
    expect(failed.uploads.size).toBe(0);
    expect(failed.calls.some((call) => call.method === "DELETE")).toBe(true);
  });
});
