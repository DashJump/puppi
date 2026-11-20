import { beforeEach, describe, expect, it } from "vite-plus/test";

import { reset, sdk } from "./support/registry.js";

class AcmeClient {
  constructor(
    readonly config: Record<string, unknown>,
    readonly secrets: Record<string, string>,
  ) {}
}

class OtherClient {
  constructor(
    readonly config: Record<string, unknown>,
    readonly secrets: Record<string, string>,
  ) {}
}

const acme = {
  default: {
    type: "acme",
    configSchema: { base_url: "string", region: "string" },
    secretFields: ["api_key"],
  },
  Client: AcmeClient,
};

beforeEach(async () => {
  await reset();
});

describe("defineConfig()", () => {
  it("refuses { type } and names the import to add", () => {
    expect(() =>
      sdk.defineConfig({
        entry: "src/pipeline.ts",
        out: ".",
        defaultStorage: "warehouse",
        connections: { api: { type: "http" } },
      }),
    ).toThrow(/import \* as http from "@puppi\/adapter-http"/);
  });

  it("reads type, configSchema, and secretFields from a catalog module's default export", () => {
    const config = sdk.defineConfig({
      connections: {
        frankfurter: {
          default: {
            type: "acme",
            configSchema: { base_url: "string", region: "string" },
            secretFields: ["api_key"],
          },
          Client: AcmeClient,
        },
      },
    });

    expect(config.connections).toEqual({ frankfurter: { type: "acme" } });
    expect(sdk.collect().adapters).toEqual({
      acme: {
        type: "acme",
        config_schema: { base_url: "string", region: "string" },
        secret_fields: ["api_key"],
        client_module: "@puppi/adapter-acme",
        Client: AcmeClient,
      },
    });
  });

  it("registers a catalog module once, with @puppi/adapter-<type> as its clientModule", () => {
    const config = sdk.defineConfig({
      connections: { frankfurter: acme, fx: acme },
    });

    expect(config.connections).toEqual({
      frankfurter: { type: "acme" },
      fx: { type: "acme" },
    });
    expect(sdk.collect().adapters).toEqual({
      acme: {
        type: "acme",
        config_schema: { base_url: "string", region: "string" },
        secret_fields: ["api_key"],
        client_module: "@puppi/adapter-acme",
        Client: AcmeClient,
      },
    });
  });

  it("keeps a project-local clientModule, and a narrower binding on the connection", () => {
    const config = sdk.defineConfig({
      connections: {
        enrichment: {
          type: "acme",
          configSchema: { base_url: "string", region: "string" },
          secretFields: ["api_key"],
          clientModule: "./src/acme.js",
          Client: AcmeClient,
          config_schema: { base_url: "string" },
          secret_fields: [],
        },
      },
    });

    expect(config.connections["enrichment"]).toEqual({
      type: "acme",
      config_schema: { base_url: "string" },
      secret_fields: [],
    });
    expect(sdk.collect().adapters["acme"]).toMatchObject({
      config_schema: { base_url: "string", region: "string" },
      secret_fields: ["api_key"],
      client_module: "./src/acme.js",
      Client: AcmeClient,
    });
  });

  it("refuses a type and a Client with no clientModule", () => {
    expect(() =>
      sdk.defineConfig({ connections: { api: { type: "http", Client: AcmeClient } } }),
    ).toThrow(
      'connection "api" passes a Client but no clientModule. ' +
        'Set clientModule to the file that exports it, such as "./src/api.js".',
    );
  });

  it("keeps the registration when a second defineConfig passes the same Client", () => {
    sdk.defineConfig({ connections: { a: acme } });
    const again = sdk.defineConfig({ connections: { b: acme } });

    expect(again.connections["b"]).toEqual({ type: "acme" });
    expect(sdk.collect().adapters["acme"]?.Client).toBe(AcmeClient);
  });

  it("reads a connector module's default export", () => {
    const config = sdk.defineConfig({
      connections: {
        warehouse: {
          default: {
            type: "postgres",
            configSchema: { host: "string", database: "string" },
            secretFields: ["password"],
          },
          Client: AcmeClient,
        },
      },
    });

    expect(config.connections).toEqual({ warehouse: { type: "postgres" } });
    expect(sdk.collect().adapters["postgres"]).toMatchObject({
      config_schema: { host: "string", database: "string" },
      secret_fields: ["password"],
      client_module: "@puppi/adapter-postgres",
      Client: AcmeClient,
    });
  });

  it("refuses two Clients for one type", () => {
    expect(() =>
      sdk.defineConfig({
        connections: {
          a: acme,
          b: { ...acme, Client: OtherClient },
        },
      }),
    ).toThrow(/different Client/);
  });

  it("refuses a connection that names neither a type nor a module", () => {
    expect(() => sdk.defineConfig({ connections: { warehouse: {} } })).toThrow(/connector module/);
  });
});
