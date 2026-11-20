import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vitest";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const HOST = "https://example.my.salesforce.com";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  info: { version: string };
  components: {
    securitySchemes: Record<string, { scheme?: string }>;
    schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  };
  paths: Record<
    string,
    {
      get?: {
        parameters?: { name: string; required?: boolean }[];
        responses: Record<
          string,
          {
            content: {
              "application/json": {
                schema: { properties?: Record<string, { type?: string }> };
              };
            };
          }
        >;
      };
      post?: unknown;
    }
  >;
};

/** A response body from the pinned schema, with the fields this case cares about. */
function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

const accountSchema = spec.components.schemas["Account"] as object;

function account(overrides: Record<string, unknown> = {}) {
  return body(accountSchema, overrides);
}

const querySchema = spec.paths["/query"]?.get?.responses["200"]?.content["application/json"]
  .schema as object;

function queryPage(overrides: Record<string, unknown> = {}) {
  return body(querySchema, overrides);
}

function fake(routes: Record<string, unknown>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const route = routes[path];

    if (route === undefined) return new Response("missing", { status: 404 });
    if (typeof route === "function") return route();

    return new Response(JSON.stringify(route), { status: 200 });
  }) as typeof fetch;

  const client = new Client({ base_url: HOST }, { access_token: "sf_token" }, { fetch: fetchImpl });

  return { calls, client };
}

describe("salesforce connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://example.my.salesforce.com" },
      }),
    );
  });

  it("follows a nextRecordsUrl path on the same host", async () => {
    const next = "/services/data/v59.0/query/01g";
    const { calls, client } = fake({
      "/services/data/v59.0/query?q=SELECT+Id+FROM+Account": queryPage({
        done: false,
        totalSize: 2,
        records: [account({ Id: "001", Name: "Ada" })],
        nextRecordsUrl: next,
      }),
      [next]: queryPage({
        done: true,
        totalSize: 2,
        records: [account({ Id: "002", Name: "Grace" })],
        nextRecordsUrl: undefined,
      }),
    });

    const seen: { cursor: string | number | null; ids: string[] }[] = [];

    for await (const page of client.accounts({ q: "SELECT Id FROM Account" })) {
      seen.push({
        cursor: page.cursor,
        ids: page.data.map((row) => row.Id),
      });
    }

    expect(seen).toEqual([
      { cursor: next, ids: ["001"] },
      { cursor: null, ids: ["002"] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      `${HOST}/services/data/v59.0/query?q=SELECT+Id+FROM+Account`,
      `${HOST}/services/data/v59.0/query/01g`,
    ]);
  });

  it("proves the token with a one-row query", async () => {
    const path = "/services/data/v59.0/query?q=SELECT+Id+FROM+Account+LIMIT+1";
    const { calls, client } = fake({
      [path]: queryPage({
        done: true,
        totalSize: 1,
        records: [account({ Id: "001", Name: "Ada" })],
        nextRecordsUrl: undefined,
      }),
    });

    expect(await client.check()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`${HOST}${path}`);
    expect(calls[0]?.headers["authorization"]).toBe("Bearer sf_token");
  });

  it("refuses a binding with no base url", () => {
    expect(() => new Client({}, { access_token: "sf_token" })).toThrow(
      "salesforce requires base_url",
    );
  });

  it("puts the selected api_version in the request URL", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(input instanceof Request ? input.url : String(input));

      return new Response(JSON.stringify(account({ Id: "001", Name: "Ada" })), { status: 200 });
    }) as typeof fetch;

    for (const api_version of ["v59.0", "v60.0"]) {
      const client = new Client(
        { base_url: HOST, api_version },
        { access_token: "sf_token" },
        { fetch: fetchImpl },
      );

      await client.read("getAccount", { path: { id: "001" } });
    }

    expect(seen).toEqual([
      `${HOST}/services/data/v59.0/sobjects/Account/001`,
      `${HOST}/services/data/v60.0/sobjects/Account/001`,
    ]);
  });
});
