import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const { auth, docs } = connector.default;

const KEY = "cb-test-key";
const OFFSET = '["1700000000","row-1"]';

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, object> };
};

function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

const RESOURCES = [
  {
    name: "customers",
    path: "/customers",
    entity: "customer",
    schema: "Customer",
    sibling: "card",
  },
  {
    name: "subscriptions",
    path: "/subscriptions",
    entity: "subscription",
    schema: "Subscription",
    sibling: "customer",
  },
  {
    name: "invoices",
    path: "/invoices",
    entity: "invoice",
    schema: "Invoice",
  },
  {
    name: "items",
    path: "/items",
    entity: "item",
    schema: "Item",
  },
] as const;

type Resource = (typeof RESOURCES)[number];

function entity(schema: string, id: string): Record<string, unknown> {
  return body(spec.components.schemas[schema]!, { id });
}

function page(resource: Resource, id: string, next: string | undefined): Record<string, unknown> {
  const row: Record<string, unknown> = { [resource.entity]: entity(resource.schema, id) };

  if ("sibling" in resource) row[resource.sibling] = { id: `${resource.sibling}-for-${id}` };

  const payload: Record<string, unknown> = { list: [row] };

  if (next !== undefined) payload["next_offset"] = next;

  return payload;
}

function harness(
  pages: Record<string, unknown>[],
  config: Record<string, unknown> = { site: "acme" },
  secrets: Record<string, string> = { api_key: KEY },
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const payload = pages.shift();

    if (payload === undefined) return new Response("missing", { status: 404 });

    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;

  return { calls, client: new Client(config, secrets, { fetch: fetchImpl }) };
}

function list(client: Client, name: Resource["name"], args: { limit?: number; cursor?: string }) {
  switch (name) {
    case "customers":
      return client.customers(args);
    case "subscriptions":
      return client.subscriptions(args);
    case "invoices":
      return client.invoices(args);
    case "items":
      return client.items(args);
  }
}

describe("chargebee connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { site: "acme", base_url: "https://acme.chargebee.test" },
      }),
    );
  });

  it("declares basic auth and the list operations", () => {
    expect(auth).toEqual({ scheme: "basic", username: "api_key" });
    expect(docs).toBe("https://apidocs.chargebee.com/docs/api/customers#list_customers");

    for (const resource of RESOURCES) {
      const operation = operations[`list_${resource.name}`];

      expect(operation).toMatchObject({ method: "get", path: resource.path });
      expect(operation?.query).toEqual(expect.arrayContaining(["limit", "offset"]));
    }
  });

  it("sends the API key as the basic username and an empty password", async () => {
    const { calls, client } = harness([page(RESOURCES[0], "cust-1", undefined)]);

    expect(await client.check()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://acme.chargebee.com/api/v2/customers?limit=1");
    expect(calls[0]?.headers["authorization"]).toBe(`Basic ${btoa(`${KEY}:`)}`);
    expect(calls[0]?.url).not.toContain(KEY);
    expect(calls[0]?.url).not.toContain(btoa(`${KEY}:`));
  });

  it("sends no authorization header when the API key is empty", async () => {
    const { calls, client } = harness([{}], { site: "acme" }, { api_key: "" });

    expect(await client.check()).toEqual({ ok: true });
    expect(calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("resolves the site and a base_url override", async () => {
    const hosts: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      hosts.push(input instanceof Request ? input.url : String(input));

      return new Response(JSON.stringify(page(RESOURCES[0], "cust-1", undefined)), { status: 200 });
    }) as typeof fetch;

    const cases: { config: Record<string, unknown>; url: string }[] = [
      { config: { site: "acme" }, url: "https://acme.chargebee.com/api/v2/customers?limit=1" },
      {
        config: { site: "acme-test" },
        url: "https://acme-test.chargebee.com/api/v2/customers?limit=1",
      },
      {
        config: { site: "ignored", base_url: "https://override.example/" },
        url: "https://override.example/api/v2/customers?limit=1",
      },
      {
        config: { site: "evil.example#", base_url: "https://override.example" },
        url: "https://override.example/api/v2/customers?limit=1",
      },
    ];

    for (const { config, url } of cases) {
      hosts.length = 0;
      const chargebee = new Client(config, { api_key: KEY }, { fetch: fetchImpl });

      expect(await chargebee.check()).toEqual({ ok: true });
      expect(hosts).toEqual([url]);
    }

    expect(() => new Client({}, { api_key: KEY })).toThrow("chargebee requires site");
  });

  it("rejects a site that is not one DNS label before any request", () => {
    const fetchImpl = (() => {
      throw new Error("request");
    }) as typeof fetch;

    expect(
      () => new Client({ site: "evil.example#" }, { api_key: KEY }, { fetch: fetchImpl }),
    ).toThrow("chargebee site must be one DNS label");
  });

  it("omits limit when the caller does not pass one", async () => {
    const { calls, client } = harness([page(RESOURCES[0], "cust-1", undefined)]);
    const seen = [];

    for await (const result of client.customers()) {
      seen.push(result.data.map((row) => row.id));
    }

    expect(seen).toEqual([["cust-1"]]);
    expect(new URL(calls[0]!.url).searchParams.has("limit")).toBe(false);
    expect(new URL(calls[0]!.url).searchParams.has("offset")).toBe(false);
  });

  describe.each(RESOURCES)("$name", (resource) => {
    it("unwraps two pages and resumes from the cursor", async () => {
      const { calls, client } = harness([
        page(resource, "row-1", OFFSET),
        page(resource, "row-2", undefined),
      ]);
      const seen: { cursor: string | number | null; ids: (string | undefined)[] }[] = [];

      for await (const result of list(client, resource.name, { limit: 1 })) {
        seen.push({ cursor: result.cursor, ids: result.data.map((row) => row.id) });
      }

      expect(seen).toEqual([
        { cursor: OFFSET, ids: ["row-1"] },
        { cursor: null, ids: ["row-2"] },
      ]);
      expect(calls).toHaveLength(2);
      expect(new URL(calls[0]!.url).pathname).toBe(`/api/v2${resource.path}`);
      expect(new URL(calls[0]!.url).searchParams.get("limit")).toBe("1");
      expect(new URL(calls[0]!.url).searchParams.get("offset")).toBeNull();
      expect(new URL(calls[1]!.url).searchParams.get("offset")).toBe(OFFSET);
      expect(new URL(calls[1]!.url).searchParams.get("limit")).toBe("1");
      expect(calls[1]?.headers["authorization"]).toBe(`Basic ${btoa(`${KEY}:`)}`);

      const resume = harness([page(resource, "row-2", undefined)]);
      const again = [];

      for await (const result of list(resume.client, resource.name, { limit: 1, cursor: OFFSET })) {
        again.push(result.data.map((row) => row.id));
      }

      expect(again).toEqual([["row-2"]]);
      expect(resume.calls).toHaveLength(1);
      expect(new URL(resume.calls[0]!.url).searchParams.get("offset")).toBe(OFFSET);
    });
  });
});
