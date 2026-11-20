/**
 * ctx.emitFile streams one object to storage. The bytes never go through the
 * full_refresh spool, and the sha256 computed on the way is the content hash.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { execute, type SettleAttempt } from "../src/execute.js";
import type { ExecutorEvent, ExecutorInput, ResultEvent } from "../src/protocol.js";
import { bundleCarryingStorage } from "./support/storage-adapters.js";

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(resolve(here, "protocol/executor-v2.schema.json"), "utf8"),
) as { $defs: Record<string, object> };
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const validateEvent = ajv.compile({ ...schema.$defs["ExecutorEvent"], $defs: schema.$defs });

const roots: string[] = [];

const FILE_STORE = "__fileStore";
const BODY = "__body";

function setSlot(name: string, value: unknown): void {
  (globalThis as Record<string, unknown>)[name] = value;
}

function clearSlot(name: string): void {
  delete (globalThis as Record<string, unknown>)[name];
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  clearSlot(FILE_STORE);
});

interface FileStore {
  puts: { ref: string; bytes: Uint8Array; contentType: string | null; sameStream: boolean }[];
  objects: Map<string, { bytes: Uint8Array; contentType: string | null }>;
  writes: number;
  dropped: string[];
  /** When set, `drop` throws this message and leaves the object. */
  failDrop?: string;
}

describe("ctx.emitFile", () => {
  it("streams the body to put and records sha256 as the content hash", async () => {
    const root = directory();
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const body = streamOf(bytes);
    setSlot(BODY, body);
    const ref = "prod.podcast_index_dump__abcd1234_ef567890_e1";
    const bundle = writeBundle(
      root,
      `import { createHash } from "node:crypto";
      export default {
        adapters: { files: filesAdapter() },
        assets: {
          "podcast_index/dump": {
            key: "podcast_index/dump",
            role: "source",
            config: { mode: "full_refresh", output: "file" },
            checks: {},
            run: async (ctx) => {
              await ctx.emitFile(globalThis.__body, {
                contentType: "application/gzip",
                meta: { etag: "abc" },
              });
            },
          },
        },
      };
      function filesAdapter() {
        return {
          type: "files",
          config_schema: {},
          secret_fields: [],
          Client: class {
            async put(ref, body, options) {
              const store = globalThis.__fileStore;
              const bytes = await readStream(body);
              store.puts.push({
                ref,
                bytes,
                contentType: options && options.contentType ? options.contentType : null,
                sameStream: body === globalThis.__body,
              });
              store.objects.set(ref, { bytes, contentType: options ? options.contentType : null });
              return {
                sha256: sha256(bytes),
                bytes: bytes.byteLength,
                contentType: options && options.contentType ? options.contentType : null,
              };
            }
            async get(ref) {
              const found = globalThis.__fileStore.objects.get(ref);
              if (!found) throw new Error("nothing at " + ref);
              return streamOf(found.bytes);
            }
            async head(ref) {
              const found = globalThis.__fileStore.objects.get(ref);
              return found ? { bytes: found.bytes.byteLength, contentType: found.contentType } : null;
            }
            async drop(ref) {
              globalThis.__fileStore.dropped.push(ref);
              globalThis.__fileStore.objects.delete(ref);
            }
            async write() {
              globalThis.__fileStore.writes += 1;
              throw new Error("write");
            }
            async read() { return []; }
            async query() { return []; }
            async close() {}
          },
        };
      }
      function streamOf(bytes) {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }
      async function readStream(body) {
        const reader = body.getReader();
        const chunks = [];
        let length = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
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
      function sha256(bytes) {
        return createHash("sha256").update(bytes).digest("hex");
      }`,
    );

    const store: FileStore = { puts: [], objects: new Map(), writes: 0, dropped: [] };
    setSlot(FILE_STORE, store);

    const outcome = await attempt(bundle, ref, {});
    const result = outcome.result;

    expect(outcome.error?.message).toBeUndefined();
    expect(store.writes).toBe(0);
    expect(store.puts).toEqual([
      {
        ref,
        bytes,
        contentType: "application/gzip",
        sameStream: true,
      },
    ]);
    expect(result?.storage_ref).toBe(ref);
    expect(result?.observed_schema).toEqual([]);
    expect(result?.stats).toEqual({
      row_count: 0,
      bytes: 4,
      content_hash: createHash("sha256").update(bytes).digest("hex"),
      content_type: "application/gzip",
      meta: { etag: "abc" },
    });
    expect(validateEvent(result), JSON.stringify(validateEvent.errors)).toBe(true);
  });

  it("refuses emit and emitFile when the storage binding is read_only", async () => {
    const emitRoot = directory();
    const fileRoot = directory();
    const emitBundle = writeBundle(
      emitRoot,
      `export default {
        adapters: {},
        assets: {
          "podcast_index/dump": {
            key: "podcast_index/dump",
            role: "source",
            config: { mode: "full_refresh" },
            checks: {},
            run: async (ctx) => {
              await ctx.emit([{ id: 1 }]);
            },
          },
        },
      };`,
    );
    const gzipBundle = writeBundle(
      fileRoot,
      `export default {
        adapters: {},
        assets: {
          "podcast_index/dump": {
            key: "podcast_index/dump",
            role: "source",
            config: { mode: "full_refresh", output: "file" },
            checks: {},
            run: async (ctx) => {
              await ctx.emitFile(new ReadableStream(), { contentType: "application/gzip" });
            },
          },
        },
      };`,
    );
    const emitted = await attempt(emitBundle, "prod.dump__ro", {
      bindings: {
        lake: {
          type: "filesystem",
          config: { root: emitRoot },
          secrets: {},
          mode: "read_only" as const,
        },
      },
      storage_connection: "lake",
    });
    const filed = await attempt(gzipBundle, "prod.dump__ro-file", {
      bindings: {
        lake: {
          type: "filesystem",
          config: { root: fileRoot },
          secrets: {},
          mode: "read_only" as const,
        },
      },
      storage_connection: "lake",
    });

    expect(emitted.error?.message).toMatch(/cannot emit: its storage binding is read_only/);
    expect(emitted.result).toBeUndefined();
    expect(filed.error?.message).toMatch(/cannot emit a file: its storage binding is read_only/);
    expect(filed.result).toBeUndefined();
  });

  it("refuses emit and emitFile in one attempt", async () => {
    const root = directory();
    const bundle = writeBundle(
      root,
      `export default {
        adapters: {},
        assets: {
          "podcast_index/dump": {
            key: "podcast_index/dump",
            role: "source",
            config: { mode: "full_refresh" },
            checks: {},
            run: async (ctx) => {
              await ctx.emit([{ id: 1 }]);
              await ctx.emitFile(new ReadableStream(), { contentType: "application/gzip" });
            },
          },
        },
      };`,
    );

    const outcome = await attempt(bundle, "prod.dump__1", {
      bindings: {
        lake: { type: "filesystem", config: { root }, secrets: {}, mode: "live" },
      },
      storage_connection: "lake",
    });

    expect(outcome.error?.message).toMatch(/both ctx\.emit and ctx\.emitFile/);
    expect(outcome.result).toBeUndefined();
  });

  it("refuses append at run time", async () => {
    const root = directory();
    const bundle = writeBundle(
      root,
      `export default {
        adapters: {},
        assets: {
          "podcast_index/dump": {
            key: "podcast_index/dump",
            role: "source",
            config: { mode: "append", cursor: "downloaded_at" },
            checks: {},
            run: async (ctx) => {
              await ctx.emitFile(new ReadableStream(), {});
            },
          },
        },
      };`,
    );

    const outcome = await attempt(bundle, "prod.dump__1", {
      bindings: {
        lake: { type: "filesystem", config: { root }, secrets: {}, mode: "live" },
      },
      storage_connection: "lake",
    });

    expect(outcome.error?.message).toMatch(/append and cannot store a file/);
    expect(outcome.error?.message).toMatch(/full_refresh/);
  });

  it("exposes the file on ctx.latest so an etag compare can skip the fetch", async () => {
    const root = directory();
    const report = join(root, "report.json");
    const bundle = writeBundle(
      root,
      `export default {
        adapters: {},
        assets: {
          "podcast_index/dump": {
            key: "podcast_index/dump",
            role: "source",
            config: { mode: "full_refresh", output: "file" },
            checks: {},
            run: async (ctx) => {
              const { writeFileSync } = await import("node:fs");
              const latest = ctx.latest;
              writeFileSync(${JSON.stringify(report)}, JSON.stringify({
                etag: latest && latest.meta ? latest.meta.etag : null,
                sha256: latest && latest.sha256 ? latest.sha256 : null,
                bytes: latest && typeof latest.bytes === "number" ? latest.bytes : null,
                contentType: latest && latest.contentType ? latest.contentType : null,
              }));
              if (latest && latest.meta && latest.meta.etag === "v1") return ctx.unchanged();
            },
          },
        },
      };`,
    );

    const outcome = await attempt(bundle, "prod.dump__next", {
      bindings: {
        lake: { type: "filesystem", config: { root }, secrets: {}, mode: "live" },
      },
      storage_connection: "lake",
      latest: {
        materialization_id: "11111111-1111-1111-1111-111111111111",
        storage_ref: "prod.dump__prev",
        file: true,
        sha256: "abc",
        bytes: 12,
        content_type: "application/gzip",
        meta: { etag: "v1" },
      },
    });
    const seen = JSON.parse(
      await import("node:fs").then((fs) => fs.readFileSync(report, "utf8")),
    ) as {
      etag: string | null;
      sha256: string | null;
      bytes: number | null;
      contentType: string | null;
    };

    expect(outcome.error?.message).toBeUndefined();
    expect(outcome.result?.unchanged).toBe(true);
    expect(seen).toEqual({
      etag: "v1",
      sha256: "abc",
      bytes: 12,
      contentType: "application/gzip",
    });
  });

  it("returns a file ref from ctx.input, with stream(), meta, sha256, and bytes", async () => {
    const root = directory();
    const report = join(root, "report.json");
    const bytes = Uint8Array.from([9, 8, 7]);
    const bundle = writeBundle(
      root,
      `export default {
        adapters: { files: filesAdapter() },
        assets: {
          "core/parsed": {
            key: "core/parsed",
            role: "model",
            config: { mode: "table" },
            checks: {},
            run: async (ctx) => {
              const { writeFileSync } = await import("node:fs");
              const file = ctx.input("podcast_index/dump");
              const body = await file.stream();
              const read = await readStream(body);
              writeFileSync(${JSON.stringify(report)}, JSON.stringify({
                bytes: Array.from(read),
                sha256: file.sha256,
                size: file.bytes,
                contentType: file.contentType,
                etag: file.meta.etag,
              }));
              await ctx.emit([{ n: read.byteLength }]);
            },
          },
        },
      };
      function filesAdapter() {
        return {
          type: "files",
          config_schema: {},
          secret_fields: [],
          Client: class {
            async put() { throw new Error("put"); }
            async get(ref) {
              const found = globalThis.__fileStore.objects.get(ref);
              if (!found) throw new Error("nothing at " + ref);
              return streamOf(found.bytes);
            }
            async head() { return null; }
            async drop() {}
            async write() { return { storage_ref: "x", observed_schema: [], stats: { row_count: 0, bytes: 0, content_hash: null } }; }
            async read() { return []; }
            async query() { return []; }
            async close() {}
          },
        };
      }
      function streamOf(bytes) {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
      }
      async function readStream(body) {
        const reader = body.getReader();
        const chunks = [];
        let length = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
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
      }`,
    );

    const store: FileStore = {
      puts: [],
      objects: new Map([["prod.dump__1", { bytes, contentType: "application/gzip" }]]),
      writes: 0,
      dropped: [],
    };
    setSlot(FILE_STORE, store);

    const outcome = await attempt(bundle, "prod.parsed__1", {
      asset_key: "core/parsed",
      inputs: {
        "podcast_index/dump": {
          materialization_id: "22222222-2222-2222-2222-222222222222",
          storage_ref: "prod.dump__1",
          file: true,
          sha256: "def",
          bytes: 3,
          content_type: "application/gzip",
          meta: { etag: "v1" },
          storage_connection: "dumps",
        },
      },
      bindings: {
        warehouse: {
          type: "filesystem",
          config: { root },
          secrets: {},
          mode: "live",
        },
        dumps: { type: "files", config: {}, secrets: {}, mode: "live" },
      },
      storage_connection: "warehouse",
    });

    expect(outcome.error?.message).toBeUndefined();
    const seen = JSON.parse(
      await import("node:fs").then((fs) => fs.readFileSync(report, "utf8")),
    ) as { bytes: number[]; sha256: string; size: number; contentType: string; etag: string };
    expect(seen).toEqual({
      bytes: [9, 8, 7],
      sha256: "def",
      size: 3,
      contentType: "application/gzip",
      etag: "v1",
    });
  });

  it("drops the object when its sha256 matches the latest", async () => {
    const root = directory();
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const body = streamOf(bytes);
    setSlot(BODY, body);
    const ref = "prod.podcast_index_dump__abcd1234_ef567890_e2";
    const store: FileStore = { puts: [], objects: new Map(), writes: 0, dropped: [] };
    setSlot(FILE_STORE, store);

    const outcome = await attempt(
      writeBundle(root, fileBundle()),
      ref,
      {
        latest: fileLatest(hash),
      },
      async () => "rejected",
    );

    expect(outcome.error?.message).toBeUndefined();
    expect(outcome.result?.stats.content_hash).toBe(hash);
    expect(store.puts.map((put) => put.ref)).toEqual([ref]);
    expect(store.dropped).toEqual([ref]);
    expect(store.objects.has(ref)).toBe(false);
  });

  it("logs a warning when dropping the matching object fails, and still returns the result", async () => {
    const root = directory();
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    setSlot(BODY, streamOf(bytes));
    const ref = "prod.podcast_index_dump__abcd1234_ef567890_e3";
    const store: FileStore = {
      puts: [],
      objects: new Map(),
      writes: 0,
      dropped: [],
      failDrop: "bucket refused",
    };
    setSlot(FILE_STORE, store);

    const outcome = await attempt(
      writeBundle(root, fileBundle()),
      ref,
      {
        latest: fileLatest(hash),
      },
      async () => "rejected",
    );

    expect(outcome.error?.message).toBeUndefined();
    expect(outcome.result?.stats.content_hash).toBe(hash);
    expect(outcome.events).toContainEqual({
      event: "log",
      level: "warn",
      message: `podcast_index/dump could not drop ${ref} after a matching sha256: bucket refused`,
    });
  });

  it("keeps the object when the sha256 differs", async () => {
    const root = directory();
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    setSlot(BODY, streamOf(bytes));
    const ref = "prod.podcast_index_dump__abcd1234_ef567890_e4";
    const store: FileStore = { puts: [], objects: new Map(), writes: 0, dropped: [] };
    setSlot(FILE_STORE, store);

    const outcome = await attempt(writeBundle(root, fileBundle()), ref, {
      latest: fileLatest("different"),
    });

    expect(outcome.error?.message).toBeUndefined();
    expect(store.dropped).toEqual([]);
    expect(store.objects.has(ref)).toBe(true);
  });

  it("keeps a model's object when the sha256 matches", async () => {
    const root = directory();
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    setSlot(BODY, streamOf(bytes));
    const ref = "prod.core_parsed__abcd1234_ef567890_e5";
    const store: FileStore = { puts: [], objects: new Map(), writes: 0, dropped: [] };
    setSlot(FILE_STORE, store);

    const outcome = await attempt(writeBundle(root, fileBundle("model", "table")), ref, {
      latest: fileLatest(hash),
    });

    expect(outcome.error?.message).toBeUndefined();
    expect(store.dropped).toEqual([]);
    expect(store.objects.has(ref)).toBe(true);
  });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "puppi-emit-file-"));
  roots.push(root);
  return root;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function writeBundle(root: string, source: string): string {
  const path = join(root, "bundle.mjs");
  writeFileSync(path, bundleCarryingStorage(source));
  return path;
}

function fileLatest(sha256: string): Record<string, unknown> {
  return {
    materialization_id: "11111111-1111-1111-1111-111111111111",
    storage_ref: "prod.dump__prev",
    file: true,
    sha256,
    bytes: 4,
    content_type: "application/gzip",
    meta: { etag: "v1" },
  };
}

/** An asset that emitFiles the bytes parked on `globalThis.__body`. */
function fileBundle(role = "source", mode = "full_refresh"): string {
  return `import { createHash } from "node:crypto";
    export default {
      adapters: { files: filesAdapter() },
      assets: {
        "podcast_index/dump": {
          key: "podcast_index/dump",
          role: ${JSON.stringify(role)},
          config: { mode: ${JSON.stringify(mode)}, output: "file" },
          checks: {},
          run: async (ctx) => {
            await ctx.emitFile(globalThis.__body, { contentType: "application/gzip" });
          },
        },
      },
    };
    function filesAdapter() {
      return {
        type: "files",
        config_schema: {},
        secret_fields: [],
        Client: class {
          async put(ref, body, options) {
            const store = globalThis.__fileStore;
            const bytes = await readStream(body);
            store.puts.push({
              ref,
              bytes,
              contentType: options && options.contentType ? options.contentType : null,
              sameStream: body === globalThis.__body,
            });
            store.objects.set(ref, { bytes, contentType: options ? options.contentType : null });
            return { sha256: sha256(bytes), bytes: bytes.byteLength, contentType: "application/gzip" };
          }
          async get(ref) {
            const found = globalThis.__fileStore.objects.get(ref);
            if (!found) throw new Error("nothing at " + ref);
            return streamOf(found.bytes);
          }
          async head() { return null; }
          async drop(ref) {
            const store = globalThis.__fileStore;
            if (store.failDrop) throw new Error(store.failDrop);
            store.dropped.push(ref);
            store.objects.delete(ref);
          }
          async write() { throw new Error("write"); }
          async read() { return []; }
          async query() { return []; }
          async close() {}
        },
      };
    }
    function streamOf(bytes) {
      return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    }
    async function readStream(body) {
      const reader = body.getReader();
      const chunks = [];
      let length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        length += next.value.byteLength;
      }
      const out = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
      return out;
    }
    function sha256(bytes) {
      return createHash("sha256").update(bytes).digest("hex");
    }`;
}

async function attempt(
  bundle: string,
  ref: string,
  extra: Record<string, unknown>,
  settle?: SettleAttempt,
): Promise<{ error?: Error; result?: ResultEvent; events: ExecutorEvent[] }> {
  const input = {
    bundle_ref: bundle,
    sdk_version: "0.2.0",
    asset_key: "podcast_index/dump",
    partition: "",
    inputs: {},
    checkpoint: null,
    cursor_from: null,
    bindings: {
      dumps: { type: "files", config: {}, secrets: {}, mode: "live" },
    },
    storage_connection: "dumps",
    output_storage_ref: ref,
    connections: {},
    ...extra,
  } as ExecutorInput;

  const events: ExecutorEvent[] = [];

  try {
    const result = await execute(input, (event) => events.push(event), settle);
    return { result, events };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)), events };
  }
}
