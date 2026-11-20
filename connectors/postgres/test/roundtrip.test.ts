import { contentHash, pageIndexRef, pageKeyFor, pageStorageRef } from "@puppi/adapter-storage";
import type { Row, WriteResult } from "@puppi/sdk";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresAdapter } from "../src/index.js";

/**
 * A materialization read back must be the rows that were written, type for
 * type: a destination re-emits its upstream and a model selects from it, so
 * a `bigint` coming back as a string would turn an integer column into a
 * string one downstream. Integration test against the local postgres.
 */
const config = {
  host: process.env["PGHOST"] ?? "127.0.0.1",
  port: Number(process.env["PGPORT"] ?? 5432),
  database: process.env["PGDATABASE"] ?? "postgres",
  user: process.env["PGUSER"] ?? "postgres",
};
const secrets = { password: process.env["PGPASSWORD"] ?? "postgres" };

const SCHEMA = "rt_test";
const adapter = new PostgresAdapter(config, secrets);

afterAll(async () => {
  try {
    await adapter.query(`drop schema if exists ${SCHEMA} cascade`);
  } finally {
    await adapter.close();
  }
});

describe("reading a materialization back", () => {
  it("returns every column with the type it was written as", async () => {
    const rows = [
      { id: "a", n: 7, big: 9_007_199_254_740_991, f: 1.5, ok: true, tags: ["x"], nothing: null },
      { id: "b", n: 8, big: 2, f: 2, ok: false, tags: { k: 1 }, nothing: 3 },
    ];

    const written = await adapter.write(`${SCHEMA}.roundtrip`, rows);
    const read = await adapter.read(written.storage_ref);

    expect(read.sort((x, y) => String(x["id"]).localeCompare(String(y["id"])))).toEqual(rows);
  });

  it("observes the written types, which is what the read must reproduce", async () => {
    const written = await adapter.write(`${SCHEMA}.observed`, [{ n: 1, f: 0.5, s: "x" }]);

    expect(written.observed_schema).toEqual([
      { name: "n", type: "integer" },
      { name: "f", type: "float" },
      { name: "s", type: "string" },
    ]);

    const [row] = await adapter.query(`select count(*) as c from ${written.storage_ref}`);
    // count(*) is a bigint: a number, not "1".
    expect(row).toEqual({ c: 1 });
  });

  it("leaves a sibling page table in place when write drops and recreates the main table", async () => {
    const page = `${SCHEMA}.roundtrip__page_00000001`;

    await adapter.write(page, [{ id: 1, created: 10 }]);
    await adapter.write(`${SCHEMA}.roundtrip_main`, [{ id: 9 }]);

    expect(await adapter.read(page)).toEqual([{ id: 1, created: 10 }]);
    expect(await adapter.read(`${SCHEMA}.roundtrip_main`)).toEqual([{ id: 9 }]);
  });

  it("assembles staged pages and leaves an unlisted page in place", async () => {
    const ref = `${SCHEMA}.commit_main`;
    const rows = [
      { id: 1, created: 10 },
      { id: 2, created: 20 },
      { id: 3, created: 30 },
      { id: 4, created: 40 },
      { id: 5, created: 50 },
    ];
    const { keys, written } = await assemble(adapter, ref, [rows.slice(0, 3), rows.slice(3)]);

    expect(written.stats).toMatchObject({ row_count: 5, content_hash: contentHash(rows) });
    expect(written.observed_schema).toEqual([
      { name: "id", type: "integer" },
      { name: "created", type: "integer" },
    ]);
    expect(await adapter.read(ref)).toEqual(rows);

    for (const key of keys) await adapter.drop(pageStorageRef(ref, key));
    await adapter.drop(pageIndexRef(ref));

    const extra = pageKeyFor([], { page: "c" });
    await adapter.write(pageStorageRef(ref, extra), [{ id: 9, created: 90 }]);

    expect(await adapter.read(ref)).toEqual(rows);
    expect(await pageNames(adapter, "commit_main")).toEqual([`commit_main__page_${extra}`]);
  });

  it("copies a bigint column into json with to_jsonb", async () => {
    const ref = `${SCHEMA}.json_bigint`;
    const numberPage = { payload: 1 };
    const objectPage = { payload: { a: true } };
    const { written } = await assemble(adapter, ref, [[numberPage], [objectPage]]);
    const read = await adapter.read(ref);

    expect(read).toEqual([numberPage, objectPage]);
    expect(written.stats.content_hash).toBe(contentHash(read));
  });

  it("reads a jsonb string back without added quotes", async () => {
    const ref = `${SCHEMA}.json_date`;
    const when = new Date("2020-01-01T00:00:00.000Z");
    const { written } = await assemble(adapter, ref, [[{ note: when }]]);
    const read = await adapter.read(ref);

    expect(read).toEqual([{ note: when.toISOString() }]);
    expect(written.stats.content_hash).toBe(contentHash(read));
  });

  it("inserts each page on its own so a deep union does not blow the stack", async () => {
    const ref = `${SCHEMA}.deep_union`;
    const count = 400;

    await adapter.query(`alter role current_user set max_stack_depth = '100kB'`);
    const local = new PostgresAdapter(config, secrets);

    try {
      const pages = Array.from({ length: count }, (_, index) => [{ id: index }]);
      const { keys, written } = await assemble(local, ref, pages);

      expect(written.stats.row_count).toBe(count);

      for (const key of keys) await local.drop(pageStorageRef(ref, key));
      await local.drop(pageIndexRef(ref));

      expect(await pageNames(adapter, "deep_union")).toEqual([]);
      expect(await local.read(ref)).toHaveLength(count);
    } finally {
      await local.close();
      await adapter.query(`alter role current_user reset max_stack_depth`);
    }
  }, 30_000);
});

/** Writes each page, then the index, then streams them through `write` in that order. */
async function assemble(
  storage: PostgresAdapter,
  ref: string,
  pages: readonly Row[][],
): Promise<{ keys: string[]; written: WriteResult }> {
  const keys: string[] = [];

  for (const rows of pages) {
    const key = pageKeyFor(keys, { page: keys.length });
    keys.push(key);
    await storage.write(pageStorageRef(ref, key), rows);
  }

  await storage.write(pageIndexRef(ref), [{ keys: keys.join(",") }]);

  return { keys, written: await storage.write(ref, reread(storage, ref, keys)) };
}

/** A restartable read of staged pages. `write` walks the iterable twice. */
function reread(
  storage: PostgresAdapter,
  ref: string,
  keys: readonly string[],
): AsyncIterable<Row[]> {
  return {
    [Symbol.asyncIterator](): AsyncGenerator<Row[]> {
      return (async function* () {
        for (const key of keys) yield await storage.read(pageStorageRef(ref, key));
      })();
    },
  };
}

async function pageNames(storage: PostgresAdapter, table: string): Promise<string[]> {
  const prefix = `${table}__page_`;
  const found = await storage.query(`select tablename from pg_tables where schemaname = $1`, [
    SCHEMA,
  ]);

  return found
    .map((row) => String(row["tablename"]))
    .filter((name) => name.startsWith(prefix))
    .sort();
}
