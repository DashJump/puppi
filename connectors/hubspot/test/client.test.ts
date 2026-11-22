import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const { apiVersions, defaultApiVersion } = connector.default;

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

const contactSchema = spec.components.schemas["SimplePublicObjectWithAssociations"] as object;
const listSchema = spec.paths["/crm/objects/2026-09/contacts"]?.get?.responses["200"]?.content[
  "application/json"
].schema as object;

function contact(overrides: Record<string, unknown> = {}) {
  return body(contactSchema, overrides);
}

function contactList(overrides: Record<string, unknown> = {}) {
  return body(listSchema, overrides);
}

function prefix(version: string): string {
  if (version === "2026-09") return "/crm/objects/2026-09";
  if (version === "v3") return "/crm/v3/objects";

  throw new Error(`unexpected api_version ${version}`);
}

function fake(routes: Record<string, unknown>, config: Record<string, unknown> = {}) {
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
    { base_url: "https://hubspot.test", ...config },
    { access_token: "pat-test" },
    { fetch: fetchImpl },
  );

  return { calls, client };
}

describe("hubspot connector", () => {
  it("is a conformant source", async () => {
    const checks = await runSourceConformance({
      connector,
      operations,
      root: new URL("..", import.meta.url),
      config: { base_url: "https://hubspot.test" },
    });

    assertConformant(checks);
  });

  it("walks two pages, sending paging.next.after back as after", async () => {
    const token = "cursor-token";
    const shapes = [
      { config: {}, prefix: prefix(defaultApiVersion) },
      ...apiVersions.map((api_version) => ({
        config: { api_version },
        prefix: prefix(api_version),
      })),
    ];

    for (const shape of shapes) {
      const { calls, client } = fake(
        {
          [`${shape.prefix}/contacts`]: contactList({
            results: [contact({ id: "1" })],
            paging: { next: { after: token } },
          }),
          [`${shape.prefix}/contacts?after=${token}`]: contactList({
            results: [contact({ id: "2" })],
            paging: {},
          }),
        },
        shape.config,
      );

      const seen: { cursor: string | number | null; ids: string[] }[] = [];

      for await (const page of client.contacts()) {
        seen.push({
          cursor: page.cursor,
          ids: page.data.map((row) => row.id),
        });
      }

      expect(seen).toEqual([
        { cursor: token, ids: ["1"] },
        { cursor: null, ids: ["2"] },
      ]);
      expect(calls[1]?.url).toContain(`after=${token}`);
      expect(calls.map((call) => call.url)).toEqual([
        `https://hubspot.test${shape.prefix}/contacts`,
        `https://hubspot.test${shape.prefix}/contacts?after=${token}`,
      ]);
    }
  });

  it("proves the token with a one-row list", async () => {
    const shapes = [
      { config: {}, prefix: prefix(defaultApiVersion) },
      ...apiVersions.map((api_version) => ({
        config: { api_version },
        prefix: prefix(api_version),
      })),
    ];

    for (const shape of shapes) {
      const { calls, client } = fake(
        {
          [`${shape.prefix}/contacts?limit=1`]: contactList({
            results: [contact({ id: "1" })],
            paging: {},
          }),
        },
        shape.config,
      );

      expect(await client.check()).toEqual({ ok: true });
      expect(calls[0]?.url).toBe(`https://hubspot.test${shape.prefix}/contacts?limit=1`);
      expect(calls[0]?.headers["authorization"]).toBe("Bearer pat-test");
      expect(calls[0]?.url).not.toContain("pat-test");
    }
  });
});
