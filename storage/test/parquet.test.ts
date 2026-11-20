import { parquetMetadata } from "hyparquet";
import { describe, expect, it } from "vitest";

import {
  decodeParquet,
  deriveSchema,
  encodeParquet,
  SCHEMA_KEY,
  toArrayBuffer,
} from "../src/index.js";

/**
 * A materialization read back must be the rows that were written, type for
 * type, which is what the observed schema in the footer makes possible: it
 * is what tells the decoder a string column was json, or that an INT64
 * column comes back as numbers.
 */
describe("the Parquet round-trip", () => {
  it("reproduces every type exactly", async () => {
    const rows = [
      { id: "a", n: 7, big: 9_007_199_254_740_991, f: 1.5, ok: true, tags: ["x"], nothing: null },
      { id: "b", n: 8, big: 2, f: 2, ok: false, tags: { k: 1 }, nothing: 3 },
      { id: "c", n: null, big: null, f: null, ok: null, tags: null, nothing: null },
    ];
    const schema = deriveSchema(rows);
    const decoded = await decodeParquet(encodeParquet(rows, schema));

    expect(decoded.rows).toEqual(rows);
    expect(decoded.schema).toEqual(schema);
  });

  it("keeps an all-null column, and a json column of mixed scalars", async () => {
    const rows = [
      { a: null, mixed: "x" },
      { a: null, mixed: 1 },
      { a: null, mixed: false },
    ];

    expect((await decodeParquet(encodeParquet(rows, deriveSchema(rows)))).rows).toEqual(rows);
  });

  it("returns an integer beyond the safe range as a string, never as a rounded number", async () => {
    // Mirrors what the postgres adapter does with `bigint`: an integer
    // column stays numeric while the value is safe, and becomes text
    // beyond that rather than silently losing precision.
    const schema = [{ name: "n", type: "integer" }];
    const decoded = await decodeParquet(encodeParquet([{ n: 1 }, { n: 2n ** 60n }], schema));

    expect(decoded.rows).toEqual([{ n: 1 }, { n: "1152921504606846976" }]);
  });

  it("writes an empty row set as a placeholder column, and reads it back empty", async () => {
    const decoded = await decodeParquet(encodeParquet([], []));

    expect(decoded).toEqual({ rows: [], schema: [] });
  });

  it("keeps the row count of rows without columns", async () => {
    const decoded = await decodeParquet(encodeParquet([{}, {}], []));

    expect(decoded.rows).toEqual([{}, {}]);
  });

  it("carries the observed schema in the footer, and refuses a file without one", async () => {
    const bytes = encodeParquet([{ n: 1 }], [{ name: "n", type: "integer" }]);
    const metadata = parquetMetadata(toArrayBuffer(bytes));

    expect(metadata.key_value_metadata).toEqual([
      { key: SCHEMA_KEY, value: JSON.stringify([{ name: "n", type: "integer" }]) },
    ]);
    expect(metadata.schema.map((element) => [element.name, element.type])).toEqual([
      ["root", undefined],
      ["n", "INT64"],
    ]);

    const { parquetWriteBuffer } = await import("hyparquet-writer");
    const foreign = new Uint8Array(
      parquetWriteBuffer({ columnData: [{ name: "n", data: [1], type: "INT32" }] }),
    );

    await expect(decodeParquet(foreign)).rejects.toThrow(/no puppi.observed_schema/);
  });
});
