import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client as Filesystem } from "@puppi/adapter-filesystem";
import type { Row } from "@puppi/sdk";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { execute } from "../src/execute.js";
import type { ExecutorEvent, ExecutorInput } from "../src/protocol.js";
import { Spool } from "../src/shim/spool.js";
import { bundleCarryingStorage } from "./support/storage-adapters.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function collect(batches: AsyncIterable<Row[]>): Promise<Row[]> {
  const rows: Row[] = [];

  for await (const batch of batches) rows.push(...batch);

  return rows;
}

describe("Spool", () => {
  it("keeps a small output in memory", async () => {
    const spool = new Spool(3);

    await spool.add([{ id: 1 }, { id: 2 }]);

    expect(spool.onDisk).toBe(false);
    expect(spool.inMemory()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await collect(spool.batches())).toEqual([{ id: 1 }, { id: 2 }]);
    await spool.close();
  });

  it("spills past the limit, keeps order and values, and reads back more than once", async () => {
    const spool = new Spool(2);
    const when = new Date("2026-10-23T12:00:00Z");
    const rows = [
      { id: 1, at: when, big: 2n ** 70n, tags: ["a"], none: null },
      { id: 2, nested: { x: 1 } },
      { id: 3 },
      { id: 4 },
      { id: 5 },
    ];

    await spool.add(rows.slice(0, 3));
    await spool.add(rows.slice(3));

    expect(spool.onDisk).toBe(true);
    expect(spool.inMemory()).toEqual([{ id: 5 }]);

    const first = await collect(spool.batches());
    const second = await collect(spool.batches());

    expect(first).toEqual(rows);
    expect(second).toEqual(rows);
    expect(first[0]?.["at"]).toBeInstanceOf(Date);
    expect(typeof first[0]?.["big"]).toBe("bigint");
    await spool.close();
  });

  it("removes its file on close", async () => {
    const spool = new Spool(1);

    await spool.add([{ id: 1 }, { id: 2 }]);
    const dir = (spool as unknown as { dir: string }).dir;

    expect(existsSync(dir)).toBe(true);
    await spool.close();
    expect(existsSync(dir)).toBe(false);
  });
});

describe("a full-refresh source past the spool limit", () => {
  it("streams every row to storage and checks still see them", async () => {
    const root = mkdtempSync(join(tmpdir(), "puppi-spool-test-"));
    roots.push(root);
    const bundle = join(root, "bundle.mjs");
    const count = 25_000;

    writeFileSync(bundle, bundleCarryingStorage(fullRefreshBundle(count)));

    const events: ExecutorEvent[] = [];
    const ref = "run.things__full";
    const result = await execute(input(bundle, root, ref), (event) => events.push(event));

    expect(result.stats.row_count).toBe(count);
    expect(result.check_results).toEqual([
      expect.objectContaining({ name: "every_row", result: "pass", detail: `${count} rows` }),
    ]);

    const storage = new Filesystem({ root }, {});

    try {
      const stored = await storage.read(ref);
      expect(stored).toHaveLength(count);
      expect(stored.slice(0, 2)).toEqual([
        { id: 0, name: "row 0" },
        { id: 1, name: "row 1" },
      ]);
      expect(stored.at(-1)).toEqual({ id: count - 1, name: `row ${count - 1}` });
    } finally {
      await storage.close();
    }
  });
});

function input(bundle: string, root: string, ref: string): ExecutorInput {
  return {
    bundle_ref: bundle,
    sdk_version: "0.2.0",
    asset_key: "source/things",
    partition: "",
    inputs: {},
    checkpoint: null,
    cursor_from: null,
    bindings: { lake: { type: "filesystem", config: { root }, secrets: {}, mode: "live" } },
    storage_connection: "lake",
    output_storage_ref: ref,
    connections: {},
  };
}

function fullRefreshBundle(count: number): string {
  return `
    export default {
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
          customChecks: {
            every_row: ({ rows }) => ({
              result: rows.length === ${count} ? "pass" : "fail",
              detail: rows.length + " rows",
            }),
          },
          config: {},
          run: async (ctx) => {
            for (let start = 0; start < ${count}; start += 1000) {
              const batch = [];
              for (let id = start; id < Math.min(start + 1000, ${count}); id++) {
                batch.push({ id, name: "row " + id });
              }
              await ctx.emit(batch);
            }
          },
        },
      },
      adapters: {},
    };
  `;
}
