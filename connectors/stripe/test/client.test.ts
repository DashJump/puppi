import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const { defaultApiVersion } = connector.default;

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: {
    securitySchemes: Record<string, { scheme?: string }>;
    schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  };
  paths: Record<
    string,
    {
      get: {
        parameters?: { name: string }[];
        responses: Record<
          string,
          {
            content: {
              "application/json": { schema: { properties: Record<string, { type?: string }> } };
            };
          }
        >;
      };
    }
  >;
};

/** A response body from the pinned schema, with the fields this case cares about. */
function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

const customerSchema = spec.components.schemas["customer"] as object;
const listSchema = spec.paths["/v1/customers"]?.get?.responses["200"]?.content["application/json"]
  .schema as object;

function customer(overrides: Record<string, unknown> = {}) {
  return body(customerSchema, overrides);
}

function customerList(overrides: Record<string, unknown> = {}) {
  return body(listSchema, overrides);
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

  const client = new Client(
    { base_url: "https://stripe.test" },
    { api_key: "sk_test" },
    { fetch: fetchImpl },
  );

  return { calls, client };
}

describe("stripe connector", () => {
  it("is a conformant source", async () => {
    const checks = await runSourceConformance({
      connector,
      operations,
      root: new URL("..", import.meta.url),
      config: { base_url: "https://stripe.test" },
    });

    assertConformant(checks);
  });

  it("sends the key as a bearer token and pins the API version", async () => {
    const { calls, client } = fake({
      "/v1/customers/cus_1": customer({ id: "cus_1", email: "ada@example.com" }),
    });

    await client.read("GetCustomersCustomer", { path: { customer: "cus_1" } });

    expect(calls[0]?.headers["authorization"]).toBe("Bearer sk_test");
    expect(calls[0]?.headers["stripe-version"]).toBe(defaultApiVersion);
    expect(calls[0]?.url).not.toContain("sk_test");
  });

  it("walks cursor pages, yielding the cursor of the following page", async () => {
    const { calls, client } = fake({
      "/v1/customers": customerList({
        has_more: true,
        data: [customer({ id: "cus_1" })],
      }),
      "/v1/customers?starting_after=cus_1": customerList({
        has_more: false,
        data: [customer({ id: "cus_2", currency: null })],
      }),
    });

    const seen: { cursor: string | number | null; ids: string[] }[] = [];

    for await (const page of client.customers()) {
      seen.push({
        cursor: page.cursor,
        ids: page.data.map((row) => row.id),
      });
    }

    expect(seen).toEqual([
      { cursor: "cus_1", ids: ["cus_1"] },
      { cursor: null, ids: ["cus_2"] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://stripe.test/v1/customers",
      "https://stripe.test/v1/customers?starting_after=cus_1",
    ]);
  });

  it("proves the key with a one-row list", async () => {
    const { calls, client } = fake({
      "/v1/customers?limit=1": customerList({ has_more: false, data: [customer({ id: "cus_1" })] }),
    });

    expect(await client.check()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://stripe.test/v1/customers?limit=1");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer sk_test");
  });
});
