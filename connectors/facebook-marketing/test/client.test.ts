import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const token = "EAA-test-token";
const FIELDS = "fields=id%2Cname%2Cstatus%2Cupdated_time";

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

const campaignPage =
  spec.paths["/{account}/campaigns"]!.get.responses["200"]!.content["application/json"].schema;
const accountSchema =
  spec.paths["/{account}"]!.get.responses["200"]!.content["application/json"].schema;

function campaign(overrides: Record<string, unknown> = {}) {
  return body(spec.components.schemas["Campaign"]!, {
    id: "1",
    name: "Spring",
    status: "ACTIVE",
    updated_time: "2024-01-01T00:00:00+0000",
    ...overrides,
  });
}

function campaigns(overrides: Record<string, unknown> = {}) {
  return body(campaignPage, overrides);
}

function fake(
  routes: Record<string, unknown>,
  config: Record<string, unknown> = {
    base_url: "https://graph.facebook.test",
    ad_account_id: "123",
  },
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const route = routes[path];

    if (route === undefined) return new Response("missing", { status: 404 });

    return new Response(JSON.stringify(route), { status: 200 });
  }) as typeof fetch;

  const client = new Client(config, { access_token: token }, { fetch: fetchImpl });

  return { calls, client };
}

describe("facebook-marketing connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://graph.facebook.test", ad_account_id: "123" },
      }),
    );
  });

  it("walks cursor pages while paging.next is present", async () => {
    const { calls, client } = fake({
      [`/v26.0/act_123/campaigns?${FIELDS}`]: campaigns({
        data: [campaign({ id: "1" })],
        paging: {
          cursors: { after: "abc" },
          next: "https://graph.facebook.test/v26.0/act_123/campaigns?after=abc&access_token=EAA-test-token",
        },
      }),
      [`/v26.0/act_123/campaigns?${FIELDS}&after=abc`]: campaigns({
        data: [campaign({ id: "2", name: "Summer", status: "PAUSED" })],
        paging: { cursors: { after: "def" } },
      }),
    });

    const seen: { cursor: string | number | null; ids: string[] }[] = [];

    for await (const page of client.campaigns()) {
      seen.push({
        cursor: page.cursor,
        ids: page.data.map((row) => row.id),
      });
    }

    expect(seen).toEqual([
      { cursor: "abc", ids: ["1"] },
      { cursor: null, ids: ["2"] },
    ]);
    expect(calls[1]?.url).toContain("after=abc");
    expect(calls[1]?.url).toContain("act_123");
    expect(calls.map((call) => call.url)).toEqual([
      `https://graph.facebook.test/v26.0/act_123/campaigns?${FIELDS}`,
      `https://graph.facebook.test/v26.0/act_123/campaigns?${FIELDS}&after=abc`,
    ]);
    expect(calls[1]?.url).not.toContain("access_token");

    for (const call of calls) {
      expect(call.headers["authorization"]).toBe(`Bearer ${token}`);
      expect(call.url).not.toContain(token);
      expect(call.url).not.toContain("access_token");
    }
  });

  it("stops on a last page that still carries cursors.after", async () => {
    const { calls, client } = fake({
      [`/v26.0/act_123/campaigns?${FIELDS}`]: campaigns({
        data: [campaign({ id: "1" })],
        paging: { cursors: { after: "still-there" } },
      }),
      [`/v26.0/act_123/campaigns?${FIELDS}&after=still-there`]: campaigns({
        data: [campaign({ id: "should-not-be-read" })],
        paging: { cursors: { after: "another" } },
      }),
    });

    const seen: { cursor: string | number | null; ids: string[] }[] = [];

    for await (const page of client.campaigns()) {
      seen.push({ cursor: page.cursor, ids: page.data.map((row) => row.id) });
    }

    expect(seen).toEqual([{ cursor: null, ids: ["1"] }]);
    expect(calls).toHaveLength(1);
  });

  it("reads after from paging.next when the cursors object is missing", async () => {
    const { calls, client } = fake({
      [`/v26.0/act_123/campaigns?${FIELDS}`]: campaigns({
        data: [campaign({ id: "1" })],
        paging: {
          next: "https://graph.facebook.test/v26.0/act_123/campaigns?limit=25&after=from-url",
        },
      }),
      [`/v26.0/act_123/campaigns?${FIELDS}&after=from-url`]: campaigns({
        data: [campaign({ id: "2" })],
        paging: {},
      }),
    });

    const ids: string[] = [];

    for await (const page of client.campaigns()) {
      ids.push(...page.data.map((row) => row.id));
    }

    expect(ids).toEqual(["1", "2"]);
    expect(calls.map((call) => call.url)).toEqual([
      `https://graph.facebook.test/v26.0/act_123/campaigns?${FIELDS}`,
      `https://graph.facebook.test/v26.0/act_123/campaigns?${FIELDS}&after=from-url`,
    ]);
  });

  it("prefixes ad_account_id with act_ once", async () => {
    const prefixed = fake(
      {
        [`/v26.0/act_123/campaigns?${FIELDS}`]: campaigns({
          data: [campaign()],
          paging: { cursors: {} },
        }),
      },
      { base_url: "https://graph.facebook.test", ad_account_id: "act_123" },
    );

    const seen = [];

    for await (const page of prefixed.client.campaigns()) seen.push(page.cursor);

    expect(seen).toEqual([null]);
    expect(prefixed.calls[0]?.url).toBe(
      `https://graph.facebook.test/v26.0/act_123/campaigns?${FIELDS}`,
    );
    expect(prefixed.calls[0]?.url).not.toContain("act_act_");
  });

  it("puts the selected api_version in the request URL", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(input instanceof Request ? input.url : String(input));

      return new Response(JSON.stringify({ id: "act_123", name: "Ada" }), { status: 200 });
    }) as typeof fetch;

    for (const api_version of ["v25.0", "v26.0"]) {
      const client = new Client(
        { base_url: "https://graph.facebook.test", ad_account_id: "123", api_version },
        { access_token: token },
        { fetch: fetchImpl },
      );

      await client.read("getAccount", { path: { account: "act_123" } });
    }

    expect(seen).toEqual([
      "https://graph.facebook.test/v25.0/act_123",
      "https://graph.facebook.test/v26.0/act_123",
    ]);
  });

  it("requires ad_account_id", () => {
    expect(
      () => new Client({ base_url: "https://graph.facebook.test" }, { access_token: token }),
    ).toThrow("facebook-marketing requires ad_account_id");
  });

  it("proves the token against the ad account and keeps it out of the url", async () => {
    const { calls, client } = fake({
      "/v26.0/act_123?fields=id": body(accountSchema, { id: "act_123", name: "Ada" }),
    });

    expect(await client.check()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://graph.facebook.test/v26.0/act_123?fields=id");
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${token}`);
    expect(calls[0]?.url).not.toContain(token);
    expect(calls[0]?.url).not.toContain("access_token");
  });
});
