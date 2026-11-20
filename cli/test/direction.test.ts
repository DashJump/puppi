import type { Registry } from "@puppi/sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { buildManifest, type Manifest } from "../src/manifest.js";
import { reset, sdk } from "./support/registry.js";

const DIRECTION = Symbol.for("puppi.direction");

beforeEach(async () => {
  await reset();
});

function mark(proto: object, name: string, direction: "read" | "write"): void {
  const fn = (proto as unknown as Record<string, unknown>)[name];

  Object.defineProperty(fn as object, DIRECTION, { value: direction });
}

class Stripe {
  customers(): void {}
  /** A POST in the HTTP sense. Direction is the annotation, which is read. */
  runReport(): void {}
  /** The name is a verb. Nothing here treats that as a write. */
  post(): void {}
}

class Store {
  head(): void {}
  get(): void {}
  put(): void {}
  putStream(): void {}
  drop(): void {}
}

mark(Stripe.prototype, "customers", "read");
mark(Stripe.prototype, "runReport", "read");
mark(Store.prototype, "head", "read");
mark(Store.prototype, "get", "read");
mark(Store.prototype, "put", "write");
mark(Store.prototype, "putStream", "write");
mark(Store.prototype, "drop", "write");

interface CompileContext {
  connections?: Record<string, { type: string }>;
  adapters?: Record<string, { Client?: unknown }>;
}

interface DirectionalCompile {
  connections: Record<string, Record<string, "read" | "write" | "read_write" | "unknown">>;
  warnings: string[];
}

function compileDirections(context: CompileContext = {}): DirectionalCompile {
  const compileWith = compile as unknown as (
    registry: Registry,
    context?: CompileContext,
  ) => DirectionalCompile;

  return compileWith(sdk.collect(), context);
}

const ADAPTERS = {
  connections: {
    stripe: { type: "stripe" },
    ga4: { type: "ga4" },
    api: { type: "http" },
    dump_store: { type: "s3" },
    clearbit: { type: "clearbit" },
  },
  adapters: {
    stripe: { Client: Stripe },
    ga4: { Client: Stripe },
    http: { Client: Stripe },
    s3: { Client: Store },
  },
};

describe("connection direction", () => {
  it("records the annotated method on a direct call", () => {
    sdk.model({
      key: "core/x",
      run: async (ctx) => {
        await (ctx.connection("stripe") as { customers(): Promise<void> }).customers();
      },
    });

    expect(compileDirections(ADAPTERS).connections["core/x"]).toEqual({ stripe: "read" });
  });

  it("follows a simple alias", () => {
    sdk.model({
      key: "core/x",
      run: async (ctx) => {
        const api = ctx.connection("stripe") as { customers(): Promise<void> };
        await api.customers();
      },
    });

    expect(compileDirections(ADAPTERS).connections["core/x"]).toEqual({ stripe: "read" });
  });

  it("records a method tagged read and write as read_write", () => {
    class Sql {
      query(): void {}
    }

    Object.defineProperty(
      (Sql.prototype as unknown as Record<string, unknown>)["query"] as object,
      DIRECTION,
      { value: "read_write" },
    );

    sdk.model({
      key: "core/x",
      run: async (ctx) => {
        await (ctx.connection("warehouse") as { query(): Promise<void> }).query();
      },
    });

    expect(
      compileDirections({
        connections: { warehouse: { type: "postgres" } },
        adapters: { postgres: { Client: Sql } },
      }).connections["core/x"],
    ).toEqual({ warehouse: "read_write" });
  });

  it("does not infer a write from the method name", () => {
    sdk.model({
      key: "core/x",
      run: async (ctx) => {
        const ga4 = ctx.connection("ga4") as { runReport(): Promise<void> };
        const api = ctx.connection("api") as { post(): Promise<void> };
        await ga4.runReport();
        await api.post();
      },
    });

    const result = compileDirections(ADAPTERS);

    expect(result.connections["core/x"]).toEqual({ ga4: "read", api: "unknown" });
    expect(result.warnings).toContain(
      'core/x calls post() on connection "api" (http), which has no direction annotation',
    );
  });

  it("unions a read and a write on the same connection", () => {
    sdk.model({
      key: "core/x",
      run: async (ctx) => {
        const store = ctx.connection("dump_store") as {
          head(): Promise<void>;
          get(): Promise<void>;
          put(): Promise<void>;
        };
        await store.head();
        await store.get();
        await store.put();
      },
    });

    expect(compileDirections(ADAPTERS).connections["core/x"]).toEqual({ dump_store: "read_write" });
  });

  it("unions declared reads and writes with what the parser saw", () => {
    sdk.model({
      key: "core/x",
      run: async (ctx) => {
        const api = ctx.connection("stripe") as { customers(): Promise<void> };
        await api.customers();
      },
      reads: ["clearbit"],
      writes: ["dump_store"],
    });

    expect(compileDirections(ADAPTERS).connections["core/x"]).toEqual({
      stripe: "read",
      clearbit: "read",
      dump_store: "write",
    });
  });

  it("warns when a declared read was seen writing, or a declared write was only seen reading", () => {
    sdk.model({
      key: "core/x",
      run: async (ctx) => {
        const store = ctx.connection("dump_store") as { put(): Promise<void> };
        await store.put();
        const api = ctx.connection("stripe") as { customers(): Promise<void> };
        await api.customers();
      },
      reads: ["dump_store"],
      writes: ["stripe"],
    });

    expect(compileDirections(ADAPTERS).warnings).toEqual([
      'core/x declares reads: ["dump_store"] but the build saw a write on "dump_store" (s3.put())',
      'core/x declares writes: ["stripe"] but the build saw only reads on "stripe"',
    ]);
  });

  it("warns when reads or writes names a connection the project does not declare", () => {
    sdk.model({
      key: "core/x",
      run: async () => {},
      reads: ["missing"],
      writes: ["also_missing"],
    });

    expect(compileDirections(ADAPTERS).warnings).toEqual([
      'core/x names "missing" in reads, which is not a declared connection',
      'core/x names "also_missing" in writes, which is not a declared connection',
    ]);
  });
});

describe("manifest connections", () => {
  it("is a direction map and does not copy connection into config", () => {
    sdk.source({
      key: "raw/a",
      connection: "stripe",
      mode: "full_refresh",
      run: async (ctx) => {
        await (ctx.connection("stripe") as { customers(): Promise<void> }).customers();
      },
    } as Parameters<typeof sdk.source>[0]);
    sdk.model({
      key: "core/x",
      connection: "lake",
      run: async () => {},
    } as Parameters<typeof sdk.model>[0]);
    sdk.destination({
      key: "out/x",
      from: "core/x",
      connection: "sheets",
      storage: "sheets",
      write: "replace",
    } as Parameters<typeof sdk.destination>[0]);

    const registry = sdk.collect();
    const compiled = compileDirections(ADAPTERS);
    const manifest: Manifest = buildManifest({
      registry,
      compiled: compiled as unknown as Parameters<typeof buildManifest>[0]["compiled"],
      sdkVersion: "0.2.0",
      lockfileHash: "test",
      connections: {
        stripe: { type: "stripe", config_schema: {}, secret_fields: [] },
        warehouse: { type: "postgres", config_schema: {}, secret_fields: [] },
        sheets: { type: "http", config_schema: {}, secret_fields: [] },
      },
      defaultStorage: "warehouse",
    });
    const asset = (key: string) => manifest.assets.find((item) => item.key === key)!;

    expect(asset("raw/a").connections).toEqual({ stripe: "read" });
    expect(asset("raw/a").config).not.toHaveProperty("connection");
    expect(asset("raw/a").storage).toEqual({ connection: "warehouse" });
    expect(asset("core/x").storage).toEqual({ connection: "warehouse" });
    expect(asset("core/x").config).not.toHaveProperty("connection");
    expect(asset("out/x").storage).toEqual({ connection: "sheets" });
    expect(asset("out/x").config).not.toHaveProperty("connection");
  });
});
