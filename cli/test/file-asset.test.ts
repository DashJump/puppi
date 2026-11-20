/**
 * A file asset stores one object per materialization. The compile pass
 * records it, the manifest marks it, and the build refuses the shapes that
 * cannot hold one object.
 */

import type { Ctx } from "@puppi/sdk";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { compile } from "../src/compile.js";
import { buildManifest, type DefaultStorage, storesFiles, storesRows } from "../src/manifest.js";
import { declarationFile } from "../src/typegen.js";
import { reset, sdk } from "./support/registry.js";

beforeEach(async () => {
  await reset();
});

interface FileCtx extends Ctx {
  emitFile(
    body: ReadableStream<Uint8Array>,
    options?: { contentType?: string | null; meta?: Record<string, unknown> },
  ): Promise<void>;
}

const CONNECTIONS = {
  warehouse: { type: "postgres", config_schema: {}, secret_fields: ["password"] },
  dump_store: { type: "dumps", config_schema: {}, secret_fields: [] },
};

class DumpStore {
  async put(): Promise<{ sha256: string; bytes: number; contentType: string | null }> {
    return { sha256: "abc", bytes: 1, contentType: "application/gzip" };
  }
  async get(): Promise<ReadableStream<Uint8Array>> {
    return new ReadableStream();
  }
  async head(): Promise<null> {
    return null;
  }
  async drop(): Promise<void> {}
  async close(): Promise<void> {}
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function declareDump(options: { mode?: "append" | "full_refresh"; storage?: string } = {}): void {
  sdk.adapter({ type: "dumps", Client: DumpStore });
  sdk.source({
    key: "podcast_index/dump",
    storage: options.storage ?? "dump_store",
    mode: options.mode ?? "full_refresh",
    ...(options.mode === "append" ? { cursor: "downloaded_at" } : {}),
    run: async (ctx) => {
      await (ctx as FileCtx).emitFile(emptyStream(), {
        contentType: "application/gzip",
        meta: { etag: "abc" },
      });
    },
  });
}

function build(defaultStorage?: DefaultStorage) {
  const registry = sdk.collect();

  return buildManifest({
    registry,
    compiled: compile(registry, { connections: {} }),
    sdkVersion: "0.2.0",
    lockfileHash: "test",
    connections: CONNECTIONS,
    ...(defaultStorage ? { defaultStorage } : {}),
  });
}

describe("a file asset", () => {
  it("records a producer that calls ctx.emitFile", () => {
    declareDump();

    expect(compile(sdk.collect(), { connections: {} }).files).toEqual({
      "podcast_index/dump": true,
    });
  });

  it("marks the manifest asset as a file and types ctx.input as a file", () => {
    declareDump();
    sdk.model({
      key: "core/parsed",
      run: async (ctx) => {
        ctx.input("podcast_index/dump");
      },
    });

    const manifest = build();
    const dump = manifest.assets.find((asset) => asset.key === "podcast_index/dump");

    expect(dump?.config["output"]).toBe("file");
    expect(declarationFile(manifest.assets)).toContain(
      '"podcast_index/dump": import("@puppi/sdk").FileAsset;',
    );
    expect(manifest.assets.find((asset) => asset.key === "core/parsed")?.deps).toEqual([
      "podcast_index/dump",
    ]);
  });

  it("refuses append: a file asset is full_refresh", () => {
    declareDump({ mode: "append" });

    expect(() => build()).toThrow(
      /podcast_index\/dump stores a file and is append\. A file asset is full_refresh\./,
    );
  });

  it("refuses incremental: a file asset is full_refresh", () => {
    sdk.adapter({ type: "dumps", Client: DumpStore });
    sdk.source({
      key: "podcast_index/dump",
      storage: "dump_store",
      run: async () => {},
    });
    sdk.model({
      key: "core/parsed",
      mode: "incremental",
      cursor: "podcast_index/dump",
      storage: "dump_store",
      run: async (ctx) => {
        await (ctx as FileCtx).emitFile(emptyStream(), {});
      },
    });

    expect(() => build()).toThrow(
      /core\/parsed stores a file and is incremental\. A file asset is full_refresh\./,
    );
  });

  it("refuses view: a file asset is full_refresh", () => {
    sdk.adapter({ type: "dumps", Client: DumpStore });
    sdk.model({
      key: "core/parsed",
      mode: "view",
      storage: "dump_store",
      run: async (ctx) => {
        await (ctx as FileCtx).emitFile(emptyStream(), {});
      },
    });

    expect(() => build()).toThrow(
      /core\/parsed stores a file and is view\. A file asset is full_refresh\./,
    );
  });

  it("refuses a destination that calls emitFile", () => {
    sdk.adapter({ type: "dumps", Client: DumpStore });
    sdk.source({
      key: "podcast_index/dump",
      storage: "dump_store",
      run: async () => {},
    });
    sdk.register({
      key: "app/publish",
      role: "destination",
      producer: "ts",
      deps: ["podcast_index/dump"],
      reads: [],
      writes: [],
      partitioning: { by: "none" },
      checks: {},
      config: {
        from: "podcast_index/dump",
        write: "replace",
      },
      run: async (ctx) => {
        await (ctx as FileCtx).emitFile(emptyStream(), {});
      },
    });

    expect(() => build()).toThrow(
      /app\/publish stores a file and is a destination\. A file asset is full_refresh\./,
    );
  });

  it("refuses a storage adapter that has no put, get, head, and drop", () => {
    declareDump({ storage: "warehouse" });

    expect(() => build()).toThrow(
      /podcast_index\/dump stores a file through "warehouse", which does not implement put, get, head, and drop\./,
    );
  });

  it("refuses a table asset whose storage has no write, read, query, and drop", () => {
    sdk.adapter({ type: "dumps", Client: DumpStore });
    sdk.source({
      key: "podcast_index/dump",
      storage: "dump_store",
      run: async () => {},
    });

    expect(() => build()).toThrow(
      /podcast_index\/dump stores a table through "dump_store", which does not implement write, read, query, and drop\./,
    );
  });

  it("does not treat write, read, and query without drop as a table store", () => {
    class Rows {
      async write(): Promise<void> {}
      async read(): Promise<unknown[]> {
        return [];
      }
      async query(): Promise<unknown[]> {
        return [];
      }
      async close(): Promise<void> {}
    }

    expect(storesRows(Rows)).toBe(false);
    expect(storesFiles(Rows)).toBe(false);
    expect(storesRows(DumpStore)).toBe(false);
    expect(storesFiles(DumpStore)).toBe(true);
  });

  it("refuses a sql model that reads a file", () => {
    declareDump();
    sdk.model({
      key: "core/parsed",
      sql: (ctx) => `select 1 from ${ctx.input("podcast_index/dump")}`,
    });

    expect(() => build()).toThrow(
      /core\/parsed is a sql model and reads podcast_index\/dump, a file\. Only a TS producer can read a file\./,
    );
  });
});
