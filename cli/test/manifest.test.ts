import { beforeEach, describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import {
  buildManifest,
  type DefaultStorage,
  unservableStorageDefaults,
  visibilityViolations,
} from "../src/manifest.js";
import { reset, sdk } from "./support/registry.js";

beforeEach(async () => {
  await reset();
});

const CONNECTIONS = {
  warehouse: {
    type: "postgres",
    config_schema: {},
    secret_fields: ["password"],
  },
};

function build(defaultStorage?: DefaultStorage) {
  const registry = sdk.collect();

  return buildManifest({
    registry,
    compiled: compile(registry, { connections: {} }),
    sdkVersion: "0.2.0",
    lockfileHash: "test",
    connections: CONNECTIONS,
    ...(defaultStorage ? { defaultStorage } : {}),
  });
}

function asset(manifest: ReturnType<typeof build>, key: string) {
  return manifest.assets.find((a) => a.key === key)!;
}

const EMPTY_RUN = async () => {};

describe("deps", () => {
  it("unions compiled edges with explicit ones", () => {
    sdk.source({
      key: "raw/a",
      mode: "full_refresh",
      run: async () => {},
    });
    sdk.source({
      key: "raw/b",
      mode: "full_refresh",
      run: async () => {},
    });
    sdk.model({
      key: "core/x",
      // raw/b is ordering-only: never read, so the compiler cannot see it.
      deps: ["raw/b"],
      run: async (ctx) => void ctx.input("raw/a"),
    });

    expect(asset(build(), "core/x").deps).toEqual(["raw/a", "raw/b"]);
  });

  it("cannot have a compiled edge removed by omitting it", () => {
    sdk.source({
      key: "raw/a",
      mode: "full_refresh",
      run: async () => {},
    });
    sdk.model({ key: "core/x", deps: [], run: async (ctx) => void ctx.input("raw/a") });

    // A read provably happens, so leaving it out of `deps` changes nothing.
    expect(asset(build(), "core/x").deps).toEqual(["raw/a"]);
  });
});

describe("groups and visibility", () => {
  it("emits every group and each asset's resolved policy", () => {
    const finance = sdk.group({ name: "finance", visibility: "group" });
    sdk.model({ key: "finance/private", group: finance, run: async () => {} });
    sdk.model({
      key: "finance/api",
      group: finance,
      visibility: "public",
      schema: { columns: [{ name: "id", type: "string" }] },
      run: async () => {},
    });

    const manifest = build();

    expect(manifest.groups).toEqual([
      { name: "default", visibility: "project" },
      { name: "finance", visibility: "group" },
    ]);
    expect(asset(manifest, "finance/private")).toMatchObject({
      group: "finance",
      visibility: "group",
    });
    expect(asset(manifest, "finance/api")).toMatchObject({
      group: "finance",
      visibility: "public",
    });
  });

  it("excludes group and visibility changes from code_version", async () => {
    const privateGroup = sdk.group({ name: "one", visibility: "group" });
    sdk.model({ key: "core/x", group: privateGroup, schema: { columns: [] }, run: EMPTY_RUN });
    const before = asset(build(), "core/x").code_version;

    await reset();
    const otherGroup = sdk.group({ name: "two", visibility: "project" });
    sdk.model({
      key: "core/x",
      group: otherGroup,
      visibility: "public",
      schema: { columns: [] },
      run: EMPTY_RUN,
    });

    expect(asset(build(), "core/x").code_version).toBe(before);
  });

  it("diagnoses illegal edges after compiled and explicit deps are unioned", () => {
    const finance = sdk.group({ name: "finance", visibility: "group" });
    sdk.model({ key: "finance/private", group: finance, run: EMPTY_RUN });
    sdk.model({
      key: "other/compiled",
      run: async (ctx) => void ctx.input("finance/private"),
    });
    sdk.model({ key: "other/explicit", deps: ["finance/private"], run: EMPTY_RUN });

    expect(visibilityViolations(build())).toEqual([
      expect.objectContaining({ asset: "other/compiled", dep: "finance/private" }),
      expect.objectContaining({ asset: "other/explicit", dep: "finance/private" }),
    ]);
  });
});

describe("connections", () => {
  it("unions compiled reaches with explicit ones, sorted", () => {
    sdk.model({
      key: "core/x",
      // Reached through a helper the compile pass cannot see into.
      reads: ["clearbit"],
      run: async (ctx) => void ctx.connection("stripe"),
    });

    expect(asset(build(), "core/x").connections).toEqual({ clearbit: "read", stripe: "unknown" });
  });

  it("is absent, not empty, when the producer reaches none", () => {
    sdk.model({ key: "core/x", run: async () => {} });

    expect(asset(build(), "core/x")).not.toHaveProperty("connections");
  });
});

describe("schedule", () => {
  it("rides into the manifest as written", () => {
    sdk.source({
      key: "raw/a",
      mode: "full_refresh",
      schedule: { cron: "*/15 * * * *", timezone: "UTC" },
      run: async () => {},
    });

    expect(asset(build(), "raw/a").schedule).toEqual({
      cron: "*/15 * * * *",
      timezone: "UTC",
    });
  });

  it("is absent, not empty, when the asset has none", () => {
    sdk.source({
      key: "raw/a",
      mode: "full_refresh",
      run: async () => {},
    });

    expect(asset(build(), "raw/a")).not.toHaveProperty("schedule");
  });
});

describe("code_version", () => {
  it("changes when the producer reaches a new connection", async () => {
    sdk.model({ key: "core/x", run: async () => {} });
    const before = asset(build(), "core/x").code_version;

    await reset();
    sdk.model({ key: "core/x", reads: ["stripe"], run: async () => {} });

    expect(asset(build(), "core/x").code_version).not.toBe(before);
  });

  it("changes when the cadence changes", async () => {
    sdk.source({
      key: "raw/a",
      mode: "full_refresh",
      schedule: { cron: "*/15 * * * *" },
      run: async () => {},
    });

    const before = asset(build(), "raw/a").code_version;

    await reset();
    sdk.source({
      key: "raw/a",
      mode: "full_refresh",
      schedule: { cron: "0 * * * *" },
      run: async () => {},
    });

    // A cadence change is a behaviour change, so the deploy that carries
    // it makes this asset stale and the next run rebuilds it.
    expect(asset(build(), "raw/a").code_version).not.toBe(before);
  });

  it("changes when the producer's body changes", async () => {
    sdk.source({
      key: "raw/a",
      mode: "full_refresh",
      run: async () => {},
    });
    const before = asset(build(), "raw/a").code_version;

    await reset();
    sdk.source({
      key: "raw/a",
      mode: "full_refresh",
      run: async (ctx) => ctx.log("now it logs"),
    });

    // This is the half the engine cannot compute: it never reads the bundle,
    // so a change confined to a `run` body is invisible to it.
    expect(asset(build(), "raw/a").code_version).not.toBe(before);
  });

  it("changes when the storage connection changes", async () => {
    sdk.model({ key: "core/x", run: async () => {} });
    const before = asset(build("warehouse"), "core/x").code_version;

    await reset();
    sdk.model({ key: "core/x", run: async () => {} });

    expect(asset(build("lake"), "core/x").code_version).not.toBe(before);
  });

  it("changes when the declared contract changes", async () => {
    sdk.model({ key: "core/x", run: async () => {} });
    const before = asset(build(), "core/x").code_version;

    await reset();
    sdk.model({
      key: "core/x",
      schema: { columns: [{ name: "id", type: "string" }] },
      run: async () => {},
    });

    expect(asset(build(), "core/x").code_version).not.toBe(before);
  });

  it("changes when a custom check's body changes", async () => {
    sdk.model({
      key: "core/x",
      run: async () => {},
      checks: { custom: { valid_email: { run: () => ({ result: "pass" }) } } },
    });
    const before = asset(build(), "core/x").code_version;

    await reset();
    sdk.model({
      key: "core/x",
      run: async () => {},
      checks: {
        custom: {
          valid_email: {
            run: ({ rows }) => ({ result: rows.length > 0 ? "pass" : "fail" }),
          },
        },
      },
    });

    // A stricter check changes what this asset's materializations are judged
    // by, which the engine must see as a behaviour change.
    expect(asset(build(), "core/x").code_version).not.toBe(before);
  });

  it("changes when a custom check's severity changes", async () => {
    sdk.model({
      key: "core/x",
      run: async () => {},
      checks: { custom: { valid_email: { run: () => ({ result: "pass" }) } } },
    });
    const before = asset(build(), "core/x");

    await reset();
    sdk.model({
      key: "core/x",
      run: async () => {},
      checks: { custom: { valid_email: { severity: "warn", run: () => ({ result: "pass" }) } } },
    });
    const after = asset(build(), "core/x");

    expect(before.checks).toEqual({ custom: { valid_email: { severity: "block" } } });
    expect(after.checks).toEqual({ custom: { valid_email: { severity: "warn" } } });
    expect(after.code_version).not.toBe(before.code_version);
  });

  it("is per asset, so one change does not touch the others", async () => {
    sdk.source({
      key: "raw/a",
      mode: "full_refresh",
      run: async () => {},
    });
    sdk.model({ key: "core/x", run: async () => {} });
    const before = build();

    await reset();
    sdk.source({
      key: "raw/a",
      mode: "full_refresh",
      run: async () => {},
    });
    sdk.model({ key: "core/x", run: async (ctx) => ctx.log("changed") });
    const after = build();

    // The bundle's own hash would have moved both, which is exactly why this
    // is not the bundle's hash: "deploy a one-line fix, rebuild one asset".
    expect(asset(after, "core/x").code_version).not.toBe(asset(before, "core/x").code_version);
    expect(asset(after, "raw/a").code_version).toBe(asset(before, "raw/a").code_version);
  });
});

describe("storage", () => {
  it("falls back to the project default", () => {
    sdk.model({ key: "core/x", run: async () => {} });

    const built = asset(build("warehouse"), "core/x");

    expect(built.storage).toEqual({ connection: "warehouse" });
    expect(built.config).not.toHaveProperty("connection");
  });

  it("does not treat defaultStorage as a source's system when the source names none", () => {
    sdk.source({ key: "raw/a", mode: "full_refresh", run: async () => {} });

    const built = asset(build("warehouse"), "raw/a");

    expect(built.storage).toEqual({ connection: "warehouse" });
    expect(built.config).not.toHaveProperty("connection");
  });

  it("stores a source in the default storage, not in the system it reads from", () => {
    sdk.source({
      key: "raw/a",
      reads: ["stripe"],
      mode: "full_refresh",
      run: async () => {},
    });
    sdk.model({ key: "core/x", storage: "lake", run: async () => {} });
    sdk.destination({ key: "sheets/x", from: "core/x", storage: "sheets", write: "replace" });

    const built = build("warehouse");

    expect(asset(built, "raw/a").storage).toEqual({ connection: "warehouse" });
    expect(asset(built, "core/x").storage).toEqual({ connection: "lake" });
    expect(asset(built, "sheets/x").storage).toEqual({ connection: "sheets" });
  });

  it("sends each role to its own default when the project maps them", () => {
    sdk.source({ key: "raw/a", reads: ["stripe"], mode: "full_refresh", run: async () => {} });
    sdk.model({ key: "core/x", run: async () => {} });
    sdk.destination({ key: "sheets/x", from: "core/x", storage: "sheets", write: "replace" });

    const built = build({ source: "datalake", model: "warehouse", destination: "warehouse" });

    expect(asset(built, "raw/a").storage).toEqual({ connection: "datalake" });
    expect(asset(built, "core/x").storage).toEqual({ connection: "warehouse" });
    // A destination still stores in the system it delivers to.
    expect(asset(built, "sheets/x").storage).toEqual({ connection: "sheets" });
    expect(asset(built, "raw/a").connections).toEqual({ stripe: "read" });
    expect(asset(built, "raw/a").config).not.toHaveProperty("connection");
  });

  it("does not fall a missing role key back onto another role's default", () => {
    sdk.model({ key: "core/x", run: async () => {} });

    // source is set, model is not: the warehouse must not inherit datalake.
    expect(asset(build({ source: "datalake" }), "core/x").storage).toEqual({});
  });

  it("refuses a sql model that reads a table input in another storage", () => {
    sdk.source({
      key: "core/raw",
      storage: "datalake",
      mode: "full_refresh",
      run: async () => {},
    });
    sdk.model({
      key: "podcasts/mentions",
      storage: "warehouse",
      sql: (ctx) => `select * from ${ctx.input("core/raw")}`,
    });

    expect(() => build()).toThrow(
      "podcasts/mentions (warehouse) reads core/raw (datalake): inputs must be in the same storage",
    );
  });

  it("allows a ts model that reads an input in another storage", () => {
    sdk.source({
      key: "core/raw",
      storage: "datalake",
      mode: "full_refresh",
      run: async () => {},
    });
    sdk.model({
      key: "podcasts/mentions",
      storage: "warehouse",
      run: async (ctx) => {
        const input = ctx.input("core/raw");
        const lake = ctx.connection("datalake") as { read(ref: string): Promise<unknown[]> };

        await lake.read(input);
      },
    });

    const manifest = build();

    expect(asset(manifest, "podcasts/mentions").deps).toEqual(["core/raw"]);
    expect(asset(manifest, "podcasts/mentions").storage).toEqual({ connection: "warehouse" });
    expect(asset(manifest, "core/raw").storage).toEqual({ connection: "datalake" });
  });

  it("allows a model that reads an input in the default storage", () => {
    sdk.source({
      key: "core/raw",
      mode: "full_refresh",
      run: async () => {},
    });
    sdk.model({
      key: "podcasts/mentions",
      run: async (ctx) => {
        ctx.input("core/raw");
      },
    });

    const manifest = build("warehouse");

    expect(asset(manifest, "core/raw").storage).toEqual({ connection: "warehouse" });
    expect(asset(manifest, "podcasts/mentions").storage).toEqual({ connection: "warehouse" });
    expect(asset(manifest, "podcasts/mentions").deps).toEqual(["core/raw"]);
  });

  it("lets an explicit storage on the asset win over the role default", () => {
    sdk.source({
      key: "raw/a",
      reads: ["stripe"],
      storage: "warehouse",
      mode: "full_refresh",
      run: async () => {},
    });
    sdk.model({ key: "core/x", storage: "datalake", run: async () => {} });

    const built = build({ source: "datalake", model: "warehouse" });

    expect(asset(built, "raw/a").storage).toEqual({ connection: "warehouse" });
    expect(asset(built, "core/x").storage).toEqual({ connection: "datalake" });
  });
});

describe("unservableStorageDefaults", () => {
  const connections = {
    datalake: { type: "filesystem", config_schema: { root: "string" } },
    warehouse: { type: "postgres", config_schema: { host: "string" } },
    stripe: { type: "http", config_schema: { base_url: "string" } },
  };
  const adapters = {
    filesystem: { stores: true },
    postgres: { stores: true },
    http: { stores: false },
  };

  it("is silent when every named default holds a materialization", () => {
    expect(
      unservableStorageDefaults({ source: "datalake", model: "warehouse" }, connections, adapters),
    ).toEqual([]);
    expect(unservableStorageDefaults("warehouse", connections, adapters)).toEqual([]);
  });

  it("names the role and the connections that would work", () => {
    expect(unservableStorageDefaults({ source: "stripe" }, connections, adapters)).toEqual([
      'defaultStorage.source is "stripe", which holds no materialization. ' +
        "Connections that would work: datalake, warehouse.",
    ]);
  });

  it("names a default that is not a declared connection", () => {
    expect(unservableStorageDefaults({ source: "lake" }, connections, adapters)).toEqual([
      'defaultStorage.source is "lake", which is not a declared connection. ' +
        "Connections that would work: datalake, warehouse.",
    ]);
  });
});

describe("shape", () => {
  it("carries what the engine validates", () => {
    sdk.source({
      key: "raw/a",
      mode: "append",
      cursor: "updated_at",
      run: async () => {},
    });

    const built = asset(build(), "raw/a");

    expect(built.role).toBe("source");
    expect(built.producer).toBe("ts");
    expect(built.config).toMatchObject({ mode: "append", cursor: "updated_at" });
    expect(built.partitioning).toEqual({ by: "none" });
  });

  it("sorts assets so the manifest is diffable", () => {
    sdk.model({ key: "z/last", run: async () => {} });
    sdk.model({ key: "a/first", run: async () => {} });

    expect(build().assets.map((a) => a.key)).toEqual(["a/first", "z/last"]);
  });
});
