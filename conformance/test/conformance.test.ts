import { contentHash, deriveSchema } from "@puppi/adapter-storage";
import type { Row, WriteResult } from "@puppi/sdk";
import { describe, expect, it } from "vitest";

import { assertConformant, type ConformanceCheck, runStorageConformance } from "../src/index.js";

/**
 * A suite that cannot fail is worth nothing, so each of these adapters lies
 * in one specific way and the suite has to name it. Every lie here is one
 * the contract acts on: the observed schema becomes a `schema_contract`
 * verdict, a non-null digest decides whether a poll cascades a rebuild,
 * two refs of one asset have to coexist so a rollback can repoint, and
 * `drop` is what retention calls when the method exists.
 */
interface Lies {
  /** Combines row hashes with XOR, so two identical rows cancel out. */
  xorDigest?: boolean;
  /** Keeps one materialization per prefix, so the previous one is gone. */
  overwrites?: boolean;
  /** Reports a schema that is not the one the rows have. */
  wrongSchema?: boolean;
  /** Says it dropped, and keeps the data. */
  keepsDropped?: boolean;
  /** Returns no digest, which skips the digest checks. */
  noDigest?: boolean;
  /** Implements neither drop nor dropPrefix. */
  noDropMethods?: boolean;
}

class FakeStorage {
  private readonly objects = new Map<string, Row[]>();

  constructor(private readonly lies: Lies = {}) {}

  async write(storageRef: string, rows: Row[] | AsyncIterable<Row[]>): Promise<WriteResult> {
    if (!Array.isArray(rows)) throw new Error("fake storage expects an array");

    if (this.lies.overwrites) {
      const prefix = `${storageRef.split(".")[0]}.`;

      for (const key of this.objects.keys()) if (key.startsWith(prefix)) this.objects.delete(key);
    }

    this.objects.set(storageRef, rows);

    return {
      storage_ref: storageRef,
      observed_schema: this.lies.wrongSchema ? [{ name: "x", type: "string" }] : deriveSchema(rows),
      stats: {
        row_count: rows.length,
        bytes: null,
        content_hash: this.lies.noDigest
          ? null
          : this.lies.xorDigest
            ? xor(rows)
            : contentHash(rows),
      },
    };
  }

  async read(storageRef: string): Promise<Row[]> {
    const rows = this.objects.get(storageRef);

    if (!rows) throw new Error(`nothing at ${storageRef}`);

    return rows;
  }

  async query(): Promise<Row[]> {
    throw new Error("runs no queries");
  }

  async close(): Promise<void> {}

  async drop(storageRef: string): Promise<void> {
    if (!this.lies.keepsDropped) this.objects.delete(storageRef);
  }

  async dropPrefix(prefix: string): Promise<void> {
    if (this.lies.keepsDropped) return;

    for (const key of this.objects.keys())
      if (key.startsWith(`${prefix}.`)) this.objects.delete(key);
  }
}

/** XOR of per-row hashes is order-insensitive and misses duplicate rows. */
function xor(rows: Row[]): string {
  let accumulator = 0n;

  for (const row of rows) {
    accumulator ^= BigInt(`0x${contentHash([row]).slice(0, 16)}`);
  }

  return accumulator.toString(16);
}

async function checksFor(lies: Lies = {}): Promise<ConformanceCheck[]> {
  const adapter = new FakeStorage(lies) as FakeStorage & Record<string, never>;

  if (lies.noDropMethods) {
    // The methods are on the prototype, so they are shadowed rather than deleted.
    Object.defineProperty(adapter, "drop", { value: undefined });
    Object.defineProperty(adapter, "dropPrefix", { value: undefined });
  }

  return runStorageConformance({
    adapter,
    prefix: "conf",
    sharedDigest: !lies.noDigest,
    run: "t",
  });
}

function failed(checks: ConformanceCheck[]): string[] {
  return checks.filter((check) => check.status === "failed").map((check) => check.name);
}

describe("the conformance suite", () => {
  it("passes an adapter that implements the storage contract", async () => {
    const checks = await checksFor();

    expect(failed(checks)).toEqual([]);
    expect(checks.filter((check) => check.status === "skipped")).toEqual([]);
    expect(() => assertConformant(checks)).not.toThrow();
  });

  it("catches a digest that loses duplicate rows", async () => {
    const checks = await checksFor({ xorDigest: true });

    expect(failed(checks)).toContain("the digest is order-insensitive and duplicate-sensitive");
    expect(() => assertConformant(checks)).toThrow(/identical rows cancel out/);
  });

  it("catches an adapter whose next write destroys the previous ref", async () => {
    // The dangerous one: rollback repoints onto a materialization whose data
    // the next write destroyed.
    expect(failed(await checksFor({ overwrites: true }))).toContain(
      "materializations of one asset coexist",
    );
  });

  it("catches an observed schema that is not the rows'", async () => {
    expect(failed(await checksFor({ wrongSchema: true }))).toEqual([
      "write reports the row count and the observed schema",
    ]);
  });

  it("catches a drop that keeps the data, and skips a drop the client does not implement", async () => {
    expect(failed(await checksFor({ keepsDropped: true }))).toEqual([
      "drop removes one materialization's data",
      "dropPrefix empties the whole prefix",
    ]);

    const missing = await checksFor({ noDropMethods: true });
    expect(missing.find((check) => check.name.startsWith("drop removes"))?.detail).toBe(
      "implements no drop()",
    );
    expect(failed(missing)).toEqual([]);
  });

  it("skips the digest checks when the write returns none", async () => {
    const checks = await checksFor({ noDigest: true });

    expect(failed(checks)).toEqual([]);
    expect(checks.filter((check) => check.status === "skipped").map((check) => check.name)).toEqual(
      [
        "the digest is order-insensitive and duplicate-sensitive",
        "the digest agrees with the storage base",
      ],
    );
  });
});
