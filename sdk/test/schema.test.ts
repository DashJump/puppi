import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { SchemaInput } from "../src/index.js";
import { reset, sdk } from "./support/registry.js";

function declaredSchema(key: string, schema: SchemaInput) {
  sdk.source({ key, schema, run: async () => {} });

  return sdk.collect().assets[key]?.schema;
}

beforeEach(async () => {
  await reset();
});

/** A Standard Schema becomes `{ columns }` in the adapter's type vocabulary. */
describe("deriving columns from a Standard Schema", () => {
  it("maps each field to a column in the adapter's type vocabulary", () => {
    const Customer = z.object({
      customer_id: z.string(),
      age: z.int(),
      score: z.number(),
      active: z.boolean(),
      company: z.string().nullable(),
      plan: z.enum(["pro", "free"]),
      address: z.object({ city: z.string() }),
      tags: z.array(z.string()),
    });

    expect(declaredSchema("core/customer", Customer)).toEqual({
      columns: [
        { name: "customer_id", type: "string" },
        { name: "age", type: "integer" },
        { name: "score", type: "float" },
        { name: "active", type: "boolean" },
        // Nullability is part of the contract: `string|null` is not `string`.
        { name: "company", type: "string|null" },
        { name: "plan", type: "string" },
        { name: "address", type: "json" },
        { name: "tags", type: "json" },
      ],
    });
  });

  it("treats an optional field as nullable, since a missing key is observed as null", () => {
    expect(declaredSchema("x", z.object({ note: z.string().optional() }))).toEqual({
      columns: [{ name: "note", type: "string|null" }],
    });
  });

  it("collapses a union of unlike types to json, keeping nullability", () => {
    const Mixed = z.object({
      id: z.union([z.string(), z.number()]),
      maybe: z.union([z.string(), z.number(), z.null()]),
      num: z.union([z.int(), z.number()]),
    });

    expect(declaredSchema("x", Mixed)?.columns).toEqual([
      { name: "id", type: "json" },
      { name: "maybe", type: "json|null" },
      // Integers and floats together are a float column, as the adapter sees it.
      { name: "num", type: "float" },
    ]);
  });

  it("passes the column-list form through untouched", () => {
    const columns = { columns: [{ name: "id", type: "string" }] };

    expect(declaredSchema("x", columns)).toBe(columns);
  });

  it("rejects a schema that is not an object, because a row is an object", () => {
    expect(() => declaredSchema("x", z.any())).toThrow(/must describe a row/);
  });

  it("rejects a Standard Schema that cannot produce a JSON Schema", () => {
    const opaque = {
      "~standard": {
        version: 1 as const,
        vendor: "opaque",
        validate: (value: unknown) => ({ value: value as Record<string, unknown> }),
      },
    };

    expect(() => declaredSchema("x", opaque)).toThrow(/Standard JSON Schema/);
  });
});

describe("declaring with a Standard Schema", () => {
  it("registers the derived column list, never the validator", () => {
    const Customer = z.object({ id: z.string(), company: z.string().nullable() });

    sdk.source({ key: "raw/a", schema: Customer, run: async () => {} });
    sdk.model({ key: "core/x", schema: Customer, run: async () => {} });

    const registry = sdk.collect();
    const expected = {
      columns: [
        { name: "id", type: "string" },
        { name: "company", type: "string|null" },
      ],
    };

    // The manifest, and `code_version`, see only that column list.
    expect(registry.assets["raw/a"]?.schema).toEqual(expected);
    expect(registry.assets["core/x"]?.schema).toEqual(expected);
    expect(registry.assets["core/x"]).not.toHaveProperty("~standard");
  });

  it("still accepts the column-list form", () => {
    sdk.model({
      key: "core/x",
      schema: { columns: [{ name: "id", type: "string" }] },
      run: async () => {},
    });

    expect(sdk.collect().assets["core/x"]?.schema).toEqual({
      columns: [{ name: "id", type: "string" }],
    });
  });
});
