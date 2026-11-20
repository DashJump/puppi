import type { Row, WriteResult } from "@puppi/sdk";
import { ParquetWriter } from "hyparquet-writer";
import { describe, expect, it } from "vite-plus/test";

import {
  contentHash,
  deriveSchema,
  ObjectStorageAdapter,
  objectKey,
  pageIndexRef,
  pageKeyFor,
  pageStorageRef,
  parseStorageRef,
} from "../src/index.js";
import { MemoryStore } from "./memory-store.js";

/**
 * What a write reports is computed in the base, over any
 * `ObjectStore`, so a filesystem and an S3 materialization of the same rows
 * report the same schema, the same digest and the same key.
 */
describe("an object storage adapter", () => {
  it("writes one object per storage ref and reads it back", async () => {
    const store = new MemoryStore();
    const adapter = new ObjectStorageAdapter(store, "memory");
    const rows = [
      { id: 1, name: "ada" },
      { id: 2, name: null },
    ];

    const written = await adapter.write("prod.core_x__abc", rows);

    expect(written).toEqual({
      storage_ref: "prod.core_x__abc",
      observed_schema: deriveSchema(rows),
      stats: { row_count: 2, bytes: expect.any(Number), content_hash: contentHash(rows) },
    });
    expect([...store.objects.keys()]).toEqual(["prod/core_x__abc.parquet"]);
    expect(await adapter.read("prod.core_x__abc")).toEqual(rows);
  });

  it("refuses ctx.query() with an error naming the problem", async () => {
    const adapter = new ObjectStorageAdapter(new MemoryStore(), "memory");

    await expect(adapter.query("select 1")).rejects.toThrow(/memory storage runs no queries/);
  });

  it("drops one materialization, or everything under a prefix, and nothing else", async () => {
    const store = new MemoryStore();
    const adapter = new ObjectStorageAdapter(store, "memory");

    await adapter.write("prod.a__1", [{ n: 1 }]);
    await adapter.write("prod.a__2", [{ n: 2 }]);
    await adapter.write("prod_pv.a__1", [{ n: 3 }]);

    await adapter.drop("prod.a__1");
    await adapter.drop("prod.a__1"); // idempotent
    expect([...store.objects.keys()].sort()).toEqual(["prod/a__2.parquet", "prod_pv/a__1.parquet"]);

    await adapter.dropPrefix("prod");
    expect([...store.objects.keys()]).toEqual(["prod_pv/a__1.parquet"]);
  });

  it("keeps an append page when the materialization is replaced, and drop removes both", async () => {
    const store = new MemoryStore();
    const adapter = new ObjectStorageAdapter(store, "memory");

    await adapter.write("prod.a__1__page_00000001", [{ id: 1 }]);
    await adapter.write("prod.a__1__page_00000002", [{ id: 2 }]);
    await adapter.write("prod.a__1", [{ id: 9 }]);
    await adapter.write("prod.a__2", [{ id: 3 }]);

    expect(await adapter.read("prod.a__1__page_00000001")).toEqual([{ id: 1 }]);
    expect(await adapter.read("prod.a__1")).toEqual([{ id: 9 }]);

    await adapter.drop("prod.a__1");

    expect([...store.objects.keys()].sort()).toEqual(["prod/a__2.parquet"]);
    await expect(adapter.read("prod.a__1__page_00000001")).rejects.toThrow(/nothing at/);
  });

  it("writes the output one page at a time, then drops the pages", async () => {
    const store = new MemoryStore();
    const adapter = new ObjectStorageAdapter(store, "memory");
    const pages = [
      [
        { id: 1, created: 10 },
        { id: 2, created: 20 },
      ],
      [
        { id: 3, created: 30 },
        { id: 4, created: 40 },
      ],
      [{ id: 5, created: 50 }],
    ];
    const ref = "prod.a__1";
    const staged: { key: string; rows: Row[] }[] = [];

    for (const [index, rows] of pages.entries()) {
      staged.push({
        key: pageKeyFor(
          staged.map((page) => page.key),
          { page: index },
        ),
        rows,
      });
    }

    await stage(adapter, ref, staged);

    const keys = staged.map((page) => page.key);
    let written: WriteResult | undefined;
    const sizes = await withPageWrites(async () => {
      written = await adapter.write(ref, reread(adapter, ref, keys));
    });
    const all = pages.flat();

    expect(sizes).toEqual([2, 2, 1]);
    expect(written?.stats.content_hash).toBe(contentHash(all));
    expect(await adapter.read(ref)).toEqual(all);

    for (const key of keys) await adapter.drop(pageStorageRef(ref, key));
    await adapter.drop(pageIndexRef(ref));
    expect(pageKeys(store)).toEqual([]);

    const extra = pageKeyFor([], { page: 9 });
    await adapter.write(pageStorageRef(ref, extra), [{ id: 9, created: 90 }]);

    expect(await adapter.read(ref)).toEqual(all);
    expect(await adapter.read(pageStorageRef(ref, extra))).toEqual([{ id: 9, created: 90 }]);
  });

  it("replaces a page when the same checkpoint is stored twice", async () => {
    const store = new MemoryStore();
    const adapter = new ObjectStorageAdapter(store, "memory");
    const ref = "prod.a__1";
    const key = pageKeyFor([], { created: 20, page: "p2" });
    const done = pageKeyFor([key], { created: 50, page: null });

    await adapter.write(pageStorageRef(ref, key), [{ id: 1 }]);
    await adapter.write(pageStorageRef(ref, key), [{ id: 1, created: 20 }]);
    await adapter.write(pageStorageRef(ref, done), [{ id: 5, created: 50 }]);

    expect(pageKeys(store)).toHaveLength(2);

    await adapter.write(pageIndexRef(ref), [{ keys: `${key},${done}` }]);
    await adapter.write(ref, reread(adapter, ref, [key, done]));

    expect(await adapter.read(ref)).toEqual([
      { id: 1, created: 20 },
      { id: 5, created: 50 },
    ]);
  });
});

/** Writes each page, then the index in that order. Slot keys are not sorted. */
async function stage(
  adapter: ObjectStorageAdapter,
  ref: string,
  pages: readonly { key: string; rows: Row[] }[],
): Promise<void> {
  for (const page of pages) await adapter.write(pageStorageRef(ref, page.key), page.rows);

  await adapter.write(pageIndexRef(ref), [{ keys: pages.map((page) => page.key).join(",") }]);
}

/** A restartable read of the staged pages, in index order. `write` walks it twice. */
function reread(
  adapter: ObjectStorageAdapter,
  ref: string,
  keys: readonly string[],
): AsyncIterable<Row[]> {
  return {
    [Symbol.asyncIterator](): AsyncGenerator<Row[]> {
      return (async function* () {
        for (const key of keys) yield await adapter.read(pageStorageRef(ref, key));
      })();
    },
  };
}

function pageKeys(store: MemoryStore): string[] {
  return [...store.objects.keys()].filter((key) => key.includes("__page_")).sort();
}

async function withPageWrites(run: () => Promise<unknown>): Promise<number[]> {
  const sizes: number[] = [];
  // oxlint-disable-next-line typescript/unbound-method -- the spy calls the prototype method with the writer as `this`
  const write = ParquetWriter.prototype.write;

  ParquetWriter.prototype.write = function (options) {
    sizes.push(options.columnData[0]?.data.length ?? 0);
    return write.call(this, options);
  };

  try {
    await run();
    return sizes;
  } finally {
    ParquetWriter.prototype.write = write;
  }
}

describe("a storage ref on an object store", () => {
  it("is <prefix>/<name>.parquet", () => {
    expect(parseStorageRef("prod.core_x__abc")).toEqual({ prefix: "prod", name: "core_x__abc" });
    expect(objectKey("prod.core_x__abc")).toBe("prod/core_x__abc.parquet");
  });

  it("refuses anything but two segments, and a segment that would leave the prefix", () => {
    for (const bad of ["prod", "prod.a.b", ".a", "a.", "../x.a", "a/b.c", "a.."]) {
      expect(() => parseStorageRef(bad)).toThrow(/malformed storage_ref/);
    }
  });
});
