import type { StandardSchemaV1 } from "./standard-schema.js";
import type { AssetSchema, ColumnSchema, Row } from "./types.js";

/**
 * `{ columns }`, or a Standard Schema whose output is an object.
 * A Standard Schema is reduced to `{ columns }` for the manifest.
 * Declare integer columns as integers: `number` becomes `float`.
 */
export type SchemaInput = AssetSchema | StandardSchemaV1<unknown, Row>;

/** The row type a declared schema implies; `Row` when it implies nothing. */
export type InferRow<S> =
  S extends StandardSchemaV1<unknown, infer Output extends Row> ? Output : Row;

function isStandardSchema(value: unknown): value is StandardSchemaV1<unknown, Row> {
  return typeof value === "object" && value !== null && "~standard" in value;
}

/**
 * The column list stored for `schema`.
 * A Standard Schema that cannot emit JSON Schema is rejected here.
 */
export function columnsOf(key: string, schema: SchemaInput): AssetSchema {
  if (!isStandardSchema(schema)) return schema;

  const props = schema["~standard"];

  if (!props.jsonSchema) {
    throw new Error(
      `${key}: the schema from ${props.vendor} implements Standard Schema but not ` +
        `Standard JSON Schema, so its columns cannot be derived. Use a version ` +
        `that does, or declare { columns: [{ name, type }] }.`,
    );
  }

  const json = props.jsonSchema.output({ target: "draft-2020-12" });
  const properties = json["properties"];

  if (json["type"] !== "object" || !properties || typeof properties !== "object") {
    throw new Error(
      `${key}: a declared schema must describe a row — an object with one ` +
        `field per column — but this one describes ${JSON.stringify(json["type"]) ?? "something else"}`,
    );
  }

  const required = new Set(Array.isArray(json["required"]) ? (json["required"] as string[]) : []);

  const columns: ColumnSchema[] = Object.entries(properties as Record<string, unknown>).map(
    ([name, field]) => ({
      name,
      // A field a row may omit is observed as null on the rows that omit it.
      type: required.has(name) ? typeOf(field) : nullable(typeOf(field)),
    }),
  );

  return { columns };
}

/** Maps a JSON Schema node onto `string`, `integer`, `float`, `boolean`, `json`, or `|null`. */
function typeOf(node: unknown): string {
  if (!node || typeof node !== "object") return "json";

  const field = node as Record<string, unknown>;
  const variants = field["anyOf"] ?? field["oneOf"];

  if (Array.isArray(variants)) return union(variants.map(typeOf));
  if (Array.isArray(field["type"])) return union((field["type"] as unknown[]).map(scalar));
  if (typeof field["type"] === "string") return scalar(field["type"]);
  if ("const" in field) return scalar(jsonType(field["const"]));
  if (Array.isArray(field["enum"]))
    return union((field["enum"] as unknown[]).map(jsonType).map(scalar));

  return "json";
}

function scalar(jsonSchemaType: unknown): string {
  switch (jsonSchemaType) {
    case "string":
    case "integer":
    case "boolean":
    case "null":
      return jsonSchemaType;
    case "number":
      return "float";
    default:
      return "json";
  }
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string" || typeof value === "boolean") return typeof value;

  return "json";
}

/** Collapses variants the way the adapter does: one base type, plus `|null`. */
function union(types: string[]): string {
  const flat = new Set(types.flatMap((type) => type.split("|")));
  const isNullable = flat.delete("null");

  if (flat.has("integer") && flat.has("float")) {
    flat.delete("integer");
  }

  const base = flat.size === 1 ? [...flat][0]! : flat.size === 0 ? "null" : "json";

  return isNullable && base !== "null" ? nullable(base) : base;
}

function nullable(type: string): string {
  return type.split("|").includes("null") ? type : `${type}|null`;
}
