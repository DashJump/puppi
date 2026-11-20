import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const { apiVersions, defaultApiVersion } = connector.default;

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  info: { version: string };
  components: {
    securitySchemes: Record<string, { name?: string; in?: string }>;
    schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  };
  paths: Record<
    string,
    {
      get: {
        responses: Record<
          string,
          {
            headers?: Record<string, unknown>;
            content: { "application/json": { schema: { $ref?: string } } };
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

function customer(overrides: Record<string, unknown> = {}) {
  return body(spec.components.schemas["customer"] as object, overrides);
}

function customerList(overrides: Record<string, unknown> = {}) {
  return body(spec.components.schemas["customer_list"] as object, overrides);
}

function customerEnvelope(overrides: Record<string, unknown> = {}) {
  const schema = spec.paths["/customers/{customer_id}.json"]?.get?.responses["200"]?.content[
    "application/json"
  ].schema as object;

  return body(schema, overrides);
}

function nextPage(version: string): string {
  return `https://ada.myshopify.com/admin/api/${version}/customers.json?limit=50&page_info=abc`;
}

function fake(routes: Record<string, { body: unknown; link?: string } | (() => Response)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[url];

    if (route === undefined) return new Response("missing", { status: 404 });
    if (typeof route === "function") return route();

    const headers = new Headers();

    if (route.link) headers.set("link", route.link);

    return new Response(JSON.stringify(route.body), { status: 200, headers });
  }) as typeof fetch;

  const client = new Client({ shop: "ada" }, { access_token: "shpat_test" }, { fetch: fetchImpl });

  return { calls, client };
}

describe("shopify connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { shop: "ada" },
      }),
    );
  });

  it("sends the access token as a header and versions the path from the shop", async () => {
    const base = `https://ada.myshopify.com/admin/api/${defaultApiVersion}`;
    const { calls, client } = fake({
      [`${base}/customers/1.json`]: {
        body: customerEnvelope({ customer: customer({ id: 1, email: "ada@shop.test" }) }),
      },
    });

    const row = await client.read("getCustomer", { path: { customer_id: 1 } });

    expect(row.email).toBe("ada@shop.test");
    expect(calls[0]?.headers["x-shopify-access-token"]).toBe("shpat_test");
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
    expect(calls[0]?.url).toBe(`${base}/customers/1.json`);
    expect(calls[0]?.url).not.toContain("shpat_test");
  });

  it("walks Link headers, yielding the next URL as the cursor", async () => {
    const base = `https://ada.myshopify.com/admin/api/${defaultApiVersion}`;
    const next = nextPage(defaultApiVersion);
    const { calls, client } = fake({
      [`${base}/customers.json`]: {
        body: customerList({ customers: [customer({ id: 1 })] }),
        link: `<${next}>; rel="next"`,
      },
      [next]: { body: customerList({ customers: [customer({ id: 2 })] }) },
    });

    const seen: { cursor: string | number | null; ids: number[] }[] = [];

    for await (const page of client.customers()) {
      seen.push({
        cursor: page.cursor,
        ids: page.data.map((row) => row.id),
      });
    }

    expect(seen).toEqual([
      { cursor: next, ids: [1] },
      { cursor: null, ids: [2] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([`${base}/customers.json`, next]);
  });

  it("puts each supported api_version in the path", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(input instanceof Request ? input.url : String(input));

      return new Response(JSON.stringify(customerEnvelope({ customer: customer({ id: 1 }) })), {
        status: 200,
      });
    }) as typeof fetch;

    for (const api_version of apiVersions) {
      const client = new Client(
        { shop: "ada", api_version },
        { access_token: "shpat_test" },
        { fetch: fetchImpl },
      );

      await client.read("getCustomer", { path: { customer_id: 1 } });
    }

    expect(seen).toEqual(
      apiVersions.map(
        (version) => `https://ada.myshopify.com/admin/api/${version}/customers/1.json`,
      ),
    );
  });

  it("prefers base_url over shop", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(input instanceof Request ? input.url : String(input));

      return new Response(JSON.stringify(customerEnvelope({ customer: customer({ id: 1 }) })), {
        status: 200,
      });
    }) as typeof fetch;
    const client = new Client(
      { shop: "ignored", base_url: "https://override.test/admin/api/2026-10" },
      { access_token: "shpat_test" },
      { fetch: fetchImpl },
    );

    await expect(client.read("getCustomer", { path: { customer_id: 1 } })).resolves.toMatchObject({
      id: 1,
    });
    expect(urls).toEqual(["https://override.test/admin/api/2026-10/customers/1.json"]);
  });

  it("refuses a binding with no shop and no base url", () => {
    expect(() => new Client({}, { access_token: "shpat_test" })).toThrow(/shop/);
  });
});
