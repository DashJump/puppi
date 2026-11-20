/**
 * What a write reports, computed once here so every storage
 * adapter reports the same observed schema and the same digest for the same
 * rows. Moving an asset between storages must not change its
 * `schema_contract` verdicts or its skip behaviour.
 */

import { createHash } from "node:crypto";

import type { Column, Row } from "@puppi/sdk";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function hashRow(row: Row): string {
  const entries = Object.keys(row)
    .sort()
    .map((key) => [key, row[key]]);

  return sha256(JSON.stringify(entries));
}

/**
 * Schema and digest built a batch at a time. `contentHash` and `deriveSchema`
 * are this over the whole array, so a paged commit reports the same values
 * without holding every row.
 */
export class RowDigest {
  private readonly hashes: string[] = [];
  private readonly columns = new Map<string, { types: Set<string>; nullable: boolean }>();
  count = 0;

  add(rows: readonly Row[]): void {
    const known = new Set(this.columns.keys());

    for (const row of rows) {
      this.hashes.push(hashRow(row));

      for (const name of Object.keys(row)) {
        if (!this.columns.has(name)) this.columns.set(name, { types: new Set(), nullable: false });
      }
    }

    if (this.count > 0) {
      for (const [name, column] of this.columns) {
        if (!known.has(name)) column.nullable = true;
      }
    }

    for (const row of rows) {
      for (const [name, column] of this.columns) {
        const value = row[name];

        if (value === null || value === undefined) column.nullable = true;
        else column.types.add(jsType(value));
      }
    }

    this.count += rows.length;
  }

  schema(): Column[] {
    return [...this.columns].map(([name, { types, nullable }]) => ({
      name,
      type: columnType(types, nullable),
    }));
  }

  /** Order-insensitive and duplicate-sensitive: sorted per-row hashes, hashed again. */
  hash(): string {
    return sha256([...this.hashes].sort().join(""));
  }
}

/** Order-insensitive and duplicate-sensitive: sorted per-row hashes, hashed again. */
export function contentHash(rows: Row[]): string {
  const digest = new RowDigest();
  digest.add(rows);
  return digest.hash();
}

function jsType(value: unknown): string {
  switch (typeof value) {
    case "number":
      return Number.isInteger(value) ? "integer" : "float";
    case "boolean":
      return "boolean";
    case "string":
      return "string";
    default:
      return "json";
  }
}

/** Narrow on purpose: `schema_contract` compares against this, so it must be predictable. */
function columnType(types: Set<string>, nullable: boolean): string {
  if (types.size === 0) return "null";

  const [only] = types;
  const mixedNumbers = types.size === 2 && types.has("integer") && types.has("float");
  const base = types.size === 1 && only ? only : mixedNumbers ? "float" : "json";

  return nullable ? `${base}|null` : base;
}

export function deriveSchema(rows: Row[]): Column[] {
  const digest = new RowDigest();
  digest.add(rows);
  return digest.schema();
}

/** The observed type without its `|null` suffix: what decides a physical type. */
export function baseType(declared: string): string {
  return declared.replace("|null", "");
}
