/**
 * One materialization as one Parquet file. The observed schema travels in
 * the footer's key-value metadata, which is what makes a read
 * self-describing: it tells the decoder that a column of strings was json,
 * or that an integer column comes back as numbers.
 */

import type { Column, Row } from "@puppi/sdk";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import {
  ByteWriter,
  type BasicType,
  ParquetWriter,
  parquetWriteBuffer,
  schemaFromColumnData,
} from "hyparquet-writer";

import { baseType } from "./contract.js";

/** The footer key the observed schema is written under. */
export const SCHEMA_KEY = "puppi.observed_schema";

/**
 * Parquet cannot describe a file of no columns, so an empty schema writes
 * this placeholder, all null, one per row; the postgres adapter creates
 * `_empty boolean` for the same reason. Dropped again on read.
 */
const PLACEHOLDER = "_empty";

/** Physical types follow the observed schema, mirroring the postgres adapter's `sqlType`. */
function parquetType(declared: string): BasicType {
  switch (baseType(declared)) {
    case "integer":
      return "INT64";
    case "float":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    case "json":
      return "JSON";
    default:
      return "STRING";
  }
}

/** `INT64` demands a BigInt; json is stored as its text. */
function toCell(column: Column, value: unknown): unknown {
  if (value === null || value === undefined) return null;

  switch (baseType(column.type)) {
    case "integer":
      return BigInt(value as number);
    case "json":
      return JSON.stringify(value);
    default:
      return value;
  }
}

/** Back to a number while it is safe, to a string beyond that, exactly as the postgres adapter reads `bigint`. */
function fromCell(column: Column, value: unknown): unknown {
  if (value === null || value === undefined) return null;

  switch (baseType(column.type)) {
    case "integer": {
      if (typeof value !== "bigint") return value;

      const asNumber = Number(value);

      return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
    }
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value;
    default:
      return value;
  }
}

/** hyparquet reads an `ArrayBuffer`; a view's buffer may be shared or larger than the view. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);

  new Uint8Array(copy).set(bytes);

  return copy;
}

function columnData(schema: Column[], rows: readonly Row[]) {
  return schema.length > 0
    ? schema.map((column) => ({
        name: column.name,
        type: parquetType(column.type),
        data: rows.map((row) => toCell(column, row[column.name])),
      }))
    : [{ name: PLACEHOLDER, type: "BOOLEAN" as const, data: rows.map(() => null) }];
}

export function encodeParquet(rows: Row[], schema: Column[]): Uint8Array {
  const buffer = parquetWriteBuffer({
    columnData: columnData(schema, rows),
    kvMetadata: [{ key: SCHEMA_KEY, value: JSON.stringify(schema) }],
  });

  return new Uint8Array(buffer);
}

/**
 * A parquet file written one page at a time. The schema is fixed up front;
 * each `add` is one row group and is not retained.
 */
export function openParquet(schema: Column[]): { writer: ByteWriter; parquet: ParquetWriter } {
  const writer = new ByteWriter();
  const parquet = new ParquetWriter({
    writer,
    schema: schemaFromColumnData({ columnData: columnData(schema, []) }),
  });

  return { writer, parquet };
}

export async function writeParquetRows(
  parquet: ParquetWriter,
  schema: Column[],
  rows: readonly Row[],
): Promise<void> {
  if (rows.length === 0) return;

  await parquet.write({ columnData: columnData(schema, rows) });
}

export async function finishParquet(
  parquet: ParquetWriter,
  writer: ByteWriter,
  schema: Column[],
): Promise<Uint8Array> {
  parquet.kvMetadata = [{ key: SCHEMA_KEY, value: JSON.stringify(schema) }];
  await parquet.finish();

  return new Uint8Array(writer.getBuffer());
}

export async function decodeParquet(bytes: Uint8Array): Promise<{ rows: Row[]; schema: Column[] }> {
  const file = toArrayBuffer(bytes);
  const metadata = parquetMetadata(file);
  const entry = metadata.key_value_metadata?.find((kv) => kv.key === SCHEMA_KEY);

  if (!entry?.value) {
    throw new Error(
      `parquet file carries no ${SCHEMA_KEY} in its footer; not a puppi materialization`,
    );
  }

  const schema = JSON.parse(entry.value) as Column[];
  const raw = await parquetReadObjects({ file, metadata });
  const rows = raw.map((decoded) => {
    const row: Row = {};

    for (const column of schema) row[column.name] = fromCell(column, decoded[column.name]);

    return row;
  });

  return { rows, schema };
}
