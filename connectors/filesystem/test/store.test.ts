import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client, FileStore } from "../src/index.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "puppi-fs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the filesystem adapter", () => {
  it("writes <root>/<prefix>/<name>.parquet and reads it back", async () => {
    const adapter = new Client({ root });
    const rows = [
      { id: 1, name: "ada", tags: ["x"] },
      { id: 2, name: null, tags: null },
    ];

    const written = await adapter.write("prod.core_x__abc", rows);

    expect(written.stats.row_count).toBe(2);
    expect(await readdir(join(root, "prod"))).toEqual(["core_x__abc.parquet"]);
    expect(await adapter.read("prod.core_x__abc")).toEqual(rows);
    await adapter.close();
  });

  it("drops one materialization, or a whole prefix, leaving the rest", async () => {
    const adapter = new Client({ root });

    await adapter.write("prod.a__1", [{ n: 1 }]);
    await adapter.write("prod.a__2", [{ n: 2 }]);
    await adapter.write("pv_x.a__1", [{ n: 3 }]);

    await adapter.drop("prod.a__1");
    await adapter.drop("prod.a__1");
    expect(await readdir(join(root, "prod"))).toEqual(["a__2.parquet"]);

    await adapter.dropPrefix("prod");
    await adapter.dropPrefix("never_written");
    expect(await readdir(join(root, "prod"))).toEqual([]);
    expect(await adapter.read("pv_x.a__1")).toEqual([{ n: 3 }]);
  });

  it("names the ref when nothing was written to it, and refuses ctx.query()", async () => {
    const adapter = new Client({ root });

    await expect(adapter.read("prod.missing")).rejects.toThrow(/nothing at prod\/missing.parquet/);
    await expect(adapter.query("select 1")).rejects.toThrow(/filesystem storage runs no queries/);
  });

  it("lets two attempts write to one prefix at once, and to one key at once", async () => {
    // A fresh environment's first run has every source creating the prefix
    // directory together; a retry may race the attempt it replaces.
    const adapter = new Client({ root });
    const big = Array.from({ length: 5_000 }, (_, i) => ({ i, text: "x".repeat(50) }));

    await Promise.all([
      adapter.write("prod.a__1", [{ n: 1 }]),
      adapter.write("prod.b__1", [{ n: 2 }]),
      adapter.write("prod.c__1", big),
      adapter.write("prod.c__1", big),
    ]);

    expect(await adapter.read("prod.a__1")).toEqual([{ n: 1 }]);
    expect(await adapter.read("prod.b__1")).toEqual([{ n: 2 }]);
    expect(await adapter.read("prod.c__1")).toEqual(big);
    // No staging file survives a finished write.
    expect((await readdir(join(root, "prod"))).sort()).toEqual([
      "a__1.parquet",
      "b__1.parquet",
      "c__1.parquet",
    ]);
  });

  it("needs a root", () => {
    expect(() => new Client({})).toThrow(/needs "root"/);
  });
});

describe("FileStore.list", () => {
  it("lists only the keys under a prefix, and nothing for a prefix that does not exist", async () => {
    const store = new FileStore(root);

    await store.put("prod/a.parquet", new Uint8Array([1]));
    await store.put("prod/b.parquet", new Uint8Array([2]));
    await store.put("prod_pv/a.parquet", new Uint8Array([3]));

    expect((await store.list("prod/")).sort()).toEqual(["prod/a.parquet", "prod/b.parquet"]);
    expect((await store.list("prod")).sort()).toEqual([
      "prod/a.parquet",
      "prod/b.parquet",
      "prod_pv/a.parquet",
    ]);
    expect(await store.list("nope/")).toEqual([]);
  });
});
