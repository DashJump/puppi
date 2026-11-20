import type { Ctx, Declaration } from "@puppi/sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { compile } from "../src/compile.js";
import { reset, sdk } from "./support/registry.js";

beforeEach(async () => {
  await reset();
});

const context = { connections: {} };

function declareSources(): void {
  sdk.source({ key: "raw/a", mode: "full_refresh", run: async () => {} });
  sdk.source({ key: "raw/b", mode: "full_refresh", run: async () => {} });
}

function declare(run: (ctx: Ctx) => Promise<void>): Declaration {
  declareSources();
  return sdk.model({ key: "core/x", run });
}

describe("compiling a registry", () => {
  it("keeps only literals that name a declared asset", () => {
    declare(async (c) => {
      c.input("raw/a");
      // An `.input()` call on something else entirely: seen, then filtered out.
      ({ input: (_k: string) => "" }).input("not/an/asset");
    });

    const result = compile(sdk.collect(), context);

    expect(result.deps["core/x"]).toEqual(["raw/a"]);
    expect(result.unresolved).toEqual([{ asset: "core/x", key: "not/an/asset" }]);
  });

  it("reports a typo rather than inventing a dependency", () => {
    declare(async (ctx) => void ctx.input("raw/typo"));

    const result = compile(sdk.collect(), context);

    expect(result.deps["core/x"]).toEqual([]);
    expect(result.unresolved).toEqual([{ asset: "core/x", key: "raw/typo" }]);
  });

  it("deduplicates repeated reads", () => {
    declare(async (ctx) => {
      ctx.input("raw/a");
      ctx.input("raw/a");
    });

    expect(compile(sdk.collect(), context).deps["core/x"]).toEqual(["raw/a"]);
  });

  it("collects the connections each producer reaches, deduplicated", () => {
    declare(async (ctx) => {
      ctx.input("raw/a");
      ctx.connection("stripe");
      ctx.connection("stripe");
      ctx.connection("clearbit");
    });

    const result = compile(sdk.collect(), context);

    expect(result.connections["core/x"]).toEqual({ stripe: "unknown", clearbit: "unknown" });
    expect(result.connections["raw/a"]).toEqual({});
    expect(result.deps["core/x"]).toEqual(["raw/a"]);
  });

  it("does not make an asset depend on itself", () => {
    sdk.model({ key: "core/x", run: async (ctx) => void ctx.input("core/x") });

    expect(compile(sdk.collect(), context).deps["core/x"]).toEqual([]);
  });

  it("reads inputs nested in a template literal, and one with no expressions", () => {
    declare(async (ctx) => {
      ctx.input(`raw/a`);
      await ctx.query(`select * from ${ctx.input("raw/b")}`);
    });

    expect(compile(sdk.collect(), context).deps["core/x"]).toEqual(["raw/a", "raw/b"]);
  });

  it("parses a method-shorthand producer", () => {
    declareSources();
    sdk.model({
      key: "core/x",
      async run(ctx) {
        ctx.input("raw/a");
      },
    });

    expect(compile(sdk.collect(), context).deps["core/x"]).toEqual(["raw/a"]);
  });

  it("parses a sql producer", () => {
    declareSources();
    sdk.model({
      key: "core/x",
      sql: (ctx) => `select * from ${ctx.input("raw/a")}`,
    });

    expect(compile(sdk.collect(), context).deps["core/x"]).toEqual(["raw/a"]);
  });

  it("does not see a computed name", () => {
    declare(async (ctx) => {
      const keys = ["raw/a"];
      const names = ["stripe"];

      ctx.input(keys[0]!);
      ctx.connection(names[0]!);
    });

    const result = compile(sdk.collect(), context);

    expect(result.deps["core/x"]).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.connections["core/x"]).toEqual({});
  });
});
