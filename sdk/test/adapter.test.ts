import { beforeEach, describe, expect, it } from "vite-plus/test";

import { reset, sdk } from "./support/registry.js";

class AcmeClient {
  constructor(
    readonly config: Record<string, unknown>,
    readonly secrets: Record<string, string>,
  ) {}
}

beforeEach(async () => {
  await reset();
});

describe("adapter()", () => {
  it("collects into the bundle beside the assets, with manifest field names", () => {
    sdk.adapter({
      type: "acme",
      configSchema: { base_url: "string" },
      secretFields: ["api_key"],
      clientModule: "./src/adapters/acme.js",
      Client: AcmeClient,
    });

    expect(sdk.collect().adapters).toEqual({
      acme: {
        type: "acme",
        config_schema: { base_url: "string" },
        secret_fields: ["api_key"],
        client_module: "./src/adapters/acme.js",
        Client: AcmeClient,
      },
    });
  });

  it("defaults the technical fields, so a read-only source adapter is three lines", () => {
    sdk.adapter({ type: "acme", Client: AcmeClient });

    expect(sdk.collect().adapters["acme"]).toMatchObject({
      config_schema: {},
      secret_fields: [],
    });
    expect(sdk.collect().adapters["acme"]).not.toHaveProperty("client_module");
  });

  it("accepts any type name a bundle supplies, including http", () => {
    sdk.adapter({ type: "http", Client: AcmeClient });

    expect(sdk.collect().adapters["http"]).toMatchObject({ type: "http" });
  });

  it("collects postgres, which a project installs", () => {
    sdk.adapter({ type: "postgres", Client: AcmeClient });

    expect(sdk.collect().adapters["postgres"]).toMatchObject({ type: "postgres" });
  });

  it("refuses a type that is not a connection type name", () => {
    expect(() => sdk.adapter({ type: "Acme Corp", Client: AcmeClient })).toThrow(
      /not a connection type name/,
    );
  });

  it("refuses two adapters for one type", () => {
    sdk.adapter({ type: "acme", Client: AcmeClient });

    expect(() => sdk.adapter({ type: "acme", Client: AcmeClient })).toThrow(
      /duplicate adapter type acme/,
    );
  });
});

describe("TerminalError", () => {
  /** A second copy is not `instanceof TerminalError`; the brand still matches. */
  it("is recognised across two copies of the SDK", () => {
    const TERMINAL = Symbol.for("puppi.terminal_error");

    class OtherCopy extends Error {
      readonly [TERMINAL] = true;
    }

    expect(sdk.isTerminal(new sdk.TerminalError("no"))).toBe(true);
    expect(sdk.isTerminal(new OtherCopy("no"))).toBe(true);
    expect(new OtherCopy("no") instanceof sdk.TerminalError).toBe(false);
  });

  it("is not claimed by an ordinary error", () => {
    expect(sdk.isTerminal(new Error("rate limited"))).toBe(false);
    expect(sdk.isTerminal(null)).toBe(false);
    expect(sdk.isTerminal("nope")).toBe(false);
  });
});
