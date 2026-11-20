import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vitest";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const { apiVersions } = connector.default;

const NEXT = "https://acme.zendesk.test/api/v2/tickets?page[after]=abc";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, object> };
  paths: Record<
    string,
    {
      get: {
        responses: Record<string, { content: { "application/json": { schema: object } } }>;
      };
    }
  >;
};

/** A response body from the pinned schema, with the fields this case cares about. */
function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

const ticketPage = spec.paths["/tickets"]!.get.responses["200"]!.content["application/json"].schema;
const me = spec.paths["/users/me"]!.get.responses["200"]!.content["application/json"].schema;

function ticket(id: number) {
  return body(spec.components.schemas["ticket"]!, {
    id,
    subject: `ticket ${id}`,
    status: "open",
    updated_at: "2024-01-01T00:00:00Z",
  });
}

function tickets(rows: Record<string, unknown>[], page: Record<string, unknown>) {
  return body(ticketPage, { tickets: rows, ...page });
}

function fake(config: Record<string, unknown>, bodies: unknown[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const payload = bodies.shift();

    if (payload === undefined) return new Response("missing", { status: 404 });

    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;

  const client = new Client(
    { email: "ada@acme.example", ...config },
    { api_token: "zd_token" },
    { fetch: fetchImpl },
  );

  return { calls, client };
}

describe("zendesk-support connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://acme.zendesk.test", subdomain: "acme" },
      }),
    );
  });

  it("follows links.next as an absolute URL, once", async () => {
    const { calls, client } = fake({ base_url: "https://acme.zendesk.test", subdomain: "acme" }, [
      tickets([ticket(1)], {
        meta: { has_more: true, after_cursor: "abc" },
        links: { next: NEXT },
      }),
      tickets([ticket(2)], { meta: { has_more: false }, links: {} }),
    ]);

    const seen: { cursor: string | number | null; ids: number[] }[] = [];

    for await (const page of client.tickets()) {
      seen.push({ cursor: page.cursor, ids: page.data.map((row) => row.id) });
    }

    expect(seen).toEqual([
      { cursor: NEXT, ids: [1] },
      { cursor: null, ids: [2] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://acme.zendesk.test/api/v2/tickets?page%5Bsize%5D=100",
      NEXT,
    ]);
    expect(calls.filter((call) => call.url === NEXT)).toHaveLength(1);
    expect(calls[1]?.url).not.toContain("https://acme.zendesk.test/https://");
  });

  it("sends the caller's page size", async () => {
    const { calls, client } = fake({ base_url: "https://acme.zendesk.test", subdomain: "acme" }, [
      tickets([ticket(1)], { meta: { has_more: false }, links: {} }),
    ]);

    const pages = [];

    for await (const page of client.tickets({ pageSize: 25 })) pages.push(page);

    expect(pages).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get("page[size]")).toBe("25");
    expect(calls[0]?.url).not.toContain("page[after]");
  });

  it("puts the selected api_version in the request path", async () => {
    const paths: string[] = [];

    for (const api_version of apiVersions) {
      const { calls, client } = fake({ subdomain: "acme", api_version }, [
        body(me, {
          user: body(spec.components.schemas["user"]!, { id: 1, email: "ada@acme.example" }),
        }),
      ]);

      expect(await client.check()).toEqual({ ok: true });
      paths.push(new URL(calls[0]!.url).pathname);
    }

    expect(paths).toEqual(apiVersions.map((version) => `/api/${version}/users/me`));
  });

  it("uses subdomain acme as host acme.zendesk.com when base_url is omitted", async () => {
    const { calls, client } = fake({ subdomain: "acme" }, [
      body(me, {
        user: body(spec.components.schemas["user"]!, { id: 1, email: "ada@acme.example" }),
      }),
    ]);

    expect(await client.check()).toEqual({ ok: true });
    expect(new URL(calls[0]!.url).host).toBe("acme.zendesk.com");
    expect(new URL(calls[0]!.url).pathname).toBe("/api/v2/users/me");
    expect(calls[0]?.headers["authorization"]).toBe(
      `Basic ${btoa("ada@acme.example/token:zd_token")}`,
    );
    expect(calls[0]?.url).not.toContain("zd_token");
  });

  it("rejects a missing subdomain", () => {
    expect(() => new Client({ email: "ada@acme.example" }, { api_token: "zd_token" })).toThrow(
      "zendesk-support requires subdomain",
    );
  });
});
