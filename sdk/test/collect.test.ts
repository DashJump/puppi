import { beforeEach, describe, expect, it } from "vite-plus/test";

import { reset, sdk } from "./support/registry.js";

beforeEach(async () => {
  await reset();
});

describe("collect mode", () => {
  it("synthesizes the default group and resolves every asset", () => {
    sdk.model({ key: "core/plain", run: async () => {} });

    expect(sdk.collect().groups).toEqual({
      default: { name: "default", visibility: "project" },
    });
    expect(sdk.collect().assets["core/plain"]).toMatchObject({
      group: "default",
      visibility: "project",
    });
  });

  it("declares groups, configures default, and permits only upward overrides", () => {
    const finance = sdk.group({ name: "finance", visibility: "group" });
    sdk.model({ key: "default/private", run: async () => {} });
    // Configuration applies at collection time even when an ungrouped asset was declared first.
    sdk.group({ name: "default", visibility: "group" });

    sdk.model({ key: "finance/private", group: finance, run: async () => {} });
    sdk.model({
      key: "finance/public",
      group: finance,
      visibility: "public",
      schema: { columns: [{ name: "id", type: "string" }] },
      run: async () => {},
    });

    const registry = sdk.collect();

    expect(registry.groups).toEqual({
      finance: { name: "finance", visibility: "group" },
      default: { name: "default", visibility: "group" },
    });
    expect(registry.assets["finance/private"]?.visibility).toBe("group");
    expect(registry.assets["finance/public"]?.visibility).toBe("public");
    expect(registry.assets["default/private"]?.visibility).toBe("group");
  });

  it("rejects duplicate, unknown, downward, and schemaless public definitions", async () => {
    const finance = sdk.group({ name: "finance", visibility: "project" });
    expect(() => sdk.group({ name: "finance" })).toThrow(/duplicate group name finance/);

    sdk.model({ key: "finance/down", group: finance, visibility: "group", run: async () => {} });
    expect(() => sdk.collect()).toThrow(/cannot lower visibility/);

    await reset();
    const forged = { name: "ghost", visibility: "project" };
    sdk.model({
      key: "ghost/asset",
      group: forged as never,
      run: async () => {},
    });
    expect(() => sdk.collect()).toThrow(/unknown group/);

    await reset();
    sdk.model({ key: "public/no-schema", visibility: "public", run: async () => {} });
    expect(() => sdk.collect()).toThrow(/must declare a schema/);
  });

  it("registers declarations without invoking run", async () => {
    let ran = false;

    sdk.source({
      key: "stripe/customers",
      run: async () => {
        ran = true;
      },
    });

    const registry = sdk.collect();

    expect(Object.keys(registry.assets)).toEqual(["stripe/customers"]);
    expect(registry.assets["stripe/customers"]?.role).toBe("source");
    // The whole point: loading the bundle must not run the pipeline.
    expect(ran).toBe(false);
  });

  it("rejects a duplicate key, because the key is the identity", () => {
    sdk.source({ key: "a", run: async () => {} });

    expect(() => sdk.source({ key: "a", run: async () => {} })).toThrow(/duplicate asset key a/);
  });

  it("keeps only the deps the compiler cannot see", () => {
    sdk.model({
      key: "core/revenue",
      sql: (ctx) => `select * from ${ctx.input("core/invoices")}`,
      // Ordering-only: not read in the SQL, so the compile pass cannot see it.
      deps: ["core/customer"],
    });

    // The compile pass unions ctx.input() literals in later; the registry
    // carries only the explicit edges.
    expect(sdk.collect().assets["core/revenue"]?.deps).toEqual(["core/customer"]);
    expect(sdk.collect().assets["core/revenue"]?.producer).toBe("sql");
  });

  it("keeps only the connections the compiler cannot see, deduplicated", () => {
    sdk.model({
      key: "core/enriched",
      run: async (ctx) => void ctx.input("core/customer"),
      // Reached through a helper, so no `.connection("…")` literal is in
      // the producer's own source for the compile pass to find.
      reads: ["clearbit", "clearbit"],
      writes: ["dump_store", "dump_store"],
    });

    const declaration = sdk.collect().assets["core/enriched"];

    expect(declaration?.reads).toEqual(["clearbit"]);
    expect(declaration?.writes).toEqual(["dump_store"]);
  });

  it("carries empty reads and writes when none are declared", () => {
    sdk.source({ key: "stripe/customers", run: async () => {} });

    const declaration = sdk.collect().assets["stripe/customers"];

    expect(declaration?.reads).toEqual([]);
    expect(declaration?.writes).toEqual([]);
    expect(declaration?.config).not.toHaveProperty("connection");
  });

  it("makes a destination depend on what it delivers", () => {
    sdk.destination({
      key: "warehouse/customer",
      from: "core/customer",
      storage: "clickhouse",
      write: "merge",
    });

    const declaration = sdk.collect().assets["warehouse/customer"];

    expect(declaration?.deps).toEqual(["core/customer"]);
    // `write` is the destination's strategy; `mode` is a binding term and must
    // not appear here.
    expect(declaration?.config).toMatchObject({ write: "merge" });
    expect(declaration?.config).not.toHaveProperty("mode");
  });

  it("requires an incremental model to declare its cursor upstream", () => {
    expect(() =>
      sdk.model({ key: "core/events", mode: "incremental", run: async () => {} }),
    ).toThrow(/cursor/);
  });

  it("requires a model to have exactly one producer", () => {
    expect(() => sdk.model({ key: "core/empty" })).toThrow(/run or sql/);
    expect(() =>
      sdk.model({ key: "core/both", run: async () => {}, sql: () => "select 1" }),
    ).toThrow(/run or sql/);
  });

  it("does not list a destination's `from` twice when deps repeat it", () => {
    sdk.destination({
      key: "warehouse/customer",
      from: "core/customer",
      deps: ["core/customer"],
      storage: "clickhouse",
      write: "merge",
    });

    expect(sdk.collect().assets["warehouse/customer"]?.deps).toEqual(["core/customer"]);
  });

  it("splits a custom check into manifest config and an executor function", async () => {
    let ran = false;

    sdk.model({
      key: "core/customer",
      run: async () => {},
      checks: {
        schema_contract: { severity: "warn" },
        custom: {
          valid_email: {
            run: async () => {
              ran = true;
              return { result: "pass" };
            },
          },
          has_rows: {
            severity: "warn",
            run: ({ rows }) => ({ result: rows.length ? "pass" : "fail" }),
          },
        },
      },
    });

    const declaration = sdk.collect().assets["core/customer"]!;

    // What the manifest sees: config only, so the declaration stays JSON.
    expect(declaration.checks).toEqual({
      schema_contract: { severity: "warn" },
      custom: { valid_email: { severity: "block" }, has_rows: { severity: "warn" } },
    });
    expect(JSON.parse(JSON.stringify(declaration.checks))).toEqual(declaration.checks);

    // What the executor calls, untouched by collect mode.
    expect(Object.keys(declaration.customChecks!)).toEqual(["valid_email", "has_rows"]);
    expect(ran).toBe(false);
    await expect(
      declaration.customChecks!["valid_email"]!({
        rows: [],
        output: "t",
        query: async () => ({ rows: [] }),
        log() {},
      }),
    ).resolves.toEqual({ result: "pass" });
    expect(ran).toBe(true);
  });

  it("carries no customChecks when none are declared", () => {
    sdk.model({ key: "core/plain", run: async () => {}, checks: { volume: {} } });

    const declaration = sdk.collect().assets["core/plain"]!;

    expect(declaration.checks).toEqual({ volume: {} });
    expect(declaration).not.toHaveProperty("customChecks");
  });

  it("defaults a model to table mode and no partitioning", () => {
    sdk.model({ key: "core/thing", run: async () => {} });

    const declaration = sdk.collect().assets["core/thing"];

    expect(declaration?.config).toMatchObject({ mode: "table" });
    expect(declaration?.partitioning).toEqual({ by: "none" });
  });

  it("defaults a source to full_refresh, so mode is not a first decision", () => {
    sdk.source({ key: "stripe/customers", run: async () => {} });

    expect(sdk.collect().assets["stripe/customers"]?.config).toMatchObject({
      mode: "full_refresh",
    });
  });
});
