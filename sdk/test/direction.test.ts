import { beforeEach, describe, expect, it } from "vitest";

import { reset, sdk } from "./support/registry.js";

beforeEach(async () => {
  await reset();
});

describe("reads and writes", () => {
  it("keeps the directions the compiler cannot see, deduplicated", () => {
    sdk.model({
      key: "core/enriched",
      run: async () => {},
      reads: ["clearbit", "clearbit"],
      writes: ["dump_store", "dump_store"],
    });

    const declaration = sdk.collect().assets["core/enriched"] as {
      reads?: string[];
      writes?: string[];
    };

    expect(declaration.reads).toEqual(["clearbit"]);
    expect(declaration.writes).toEqual(["dump_store"]);
  });
});

describe("the connection field", () => {
  it("does not record a source connection", () => {
    sdk.source({
      key: "stripe/customers",
      connection: "stripe",
      run: async () => {},
    } as Parameters<typeof sdk.source>[0]);

    expect(sdk.collect().assets["stripe/customers"]?.config).not.toHaveProperty("connection");
  });

  it("does not let a model's connection choose storage", () => {
    sdk.model({
      key: "core/x",
      connection: "lake",
      storage: "warehouse",
      run: async () => {},
    } as Parameters<typeof sdk.model>[0]);

    const declaration = sdk.collect().assets["core/x"];

    expect(declaration?.storage).toBe("warehouse");
    expect(declaration?.config).not.toHaveProperty("connection");
  });

  it("stores a destination where its storage field says", () => {
    sdk.model({ key: "core/customer", run: async () => {} });
    sdk.destination({
      key: "warehouse/customer",
      from: "core/customer",
      storage: "sheets",
      write: "replace",
    });

    const declaration = sdk.collect().assets["warehouse/customer"];

    expect(declaration?.storage).toBe("sheets");
    expect(declaration?.config).not.toHaveProperty("connection");
    expect(declaration?.config).toMatchObject({ from: "core/customer", write: "replace" });
  });
});
