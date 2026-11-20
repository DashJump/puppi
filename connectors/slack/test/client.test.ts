import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it, vi } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

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

function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

const channelSchema = spec.components.schemas["channel"] as object;
const listSchema = spec.paths["/conversations.list"]?.get?.responses["200"]?.content[
  "application/json"
].schema as object;
const infoSchema = spec.paths["/conversations.info"]?.get?.responses["200"]?.content[
  "application/json"
].schema as object;

function channel(overrides: Record<string, unknown> = {}) {
  return body(channelSchema, overrides);
}

function channelList(overrides: Record<string, unknown> = {}) {
  return body(listSchema, { ok: true, ...overrides });
}

function channelInfo(overrides: Record<string, unknown> = {}) {
  return body(infoSchema, { ok: true, ...overrides });
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
    { base_url: "https://slack.test" },
    { bot_token: "xoxb-test" },
    { fetch: fetchImpl },
  );

  return { calls, client };
}

describe("slack connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://slack.test" },
      }),
    );
  });

  it("walks cursor pages from response_metadata.next_cursor", async () => {
    const { calls, client } = fake({
      "/conversations.list": channelList({
        channels: [channel({ id: "C1" })],
        response_metadata: { next_cursor: "abc" },
      }),
      "/conversations.list?cursor=abc": channelList({
        channels: [channel({ id: "C2" })],
        response_metadata: { next_cursor: "" },
      }),
    });

    const seen: { cursor: string | number | null; ids: string[] }[] = [];

    for await (const page of client.conversations()) {
      seen.push({
        cursor: page.cursor,
        ids: page.data.map((row) => row.id),
      });
    }

    expect(seen).toEqual([
      { cursor: "abc", ids: ["C1"] },
      { cursor: null, ids: ["C2"] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://slack.test/conversations.list",
      "https://slack.test/conversations.list?cursor=abc",
    ]);
  });

  it("keeps walking past an empty page that still has a cursor", async () => {
    const { calls, client } = fake({
      "/conversations.list": channelList({
        channels: [],
        response_metadata: { next_cursor: "abc" },
      }),
      "/conversations.list?cursor=abc": channelList({
        channels: [channel({ id: "C2" })],
        response_metadata: { next_cursor: "" },
      }),
    });

    const ids: string[] = [];

    for await (const page of client.conversations()) {
      ids.push(...page.data.map((row) => row.id));
    }

    expect(ids).toEqual(["C2"]);
    expect(calls).toHaveLength(2);
  });

  it("unwraps a single channel", async () => {
    const { client } = fake({
      "/conversations.info?channel=C1": channelInfo({
        channel: channel({ id: "C1", name: "general" }),
      }),
    });

    expect(await client.read("conversationsInfo", { query: { channel: "C1" } })).toMatchObject({
      id: "C1",
      name: "general",
    });
  });

  it("proves the token with a one-row list", async () => {
    const { calls, client } = fake({
      "/conversations.list?limit=1": channelList({
        channels: [channel({ id: "C1" })],
        response_metadata: { next_cursor: "" },
      }),
    });

    expect(await client.check()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://slack.test/conversations.list?limit=1");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer xoxb-test");
  });

  it("reads invalid_auth and missing_scope out of a 200 body", async () => {
    const rejected = fake({
      "/conversations.list?limit=1": channelList({ ok: false, error: "invalid_auth" }),
    });
    const refused = fake({
      "/conversations.list?limit=1": channelList({ ok: false, error: "missing_scope" }),
    });

    const authentication = await rejected.client.check();
    const authorization = await refused.client.check();

    expect(authentication).toEqual({
      ok: false,
      reason: "authentication",
      message: "slack authentication failed for bot_token (invalid_auth)",
    });
    expect(authorization).toEqual({
      ok: false,
      reason: "authorization",
      message: "slack authorization failed for bot_token (missing_scope)",
    });
    expect(JSON.stringify(authentication)).not.toContain("xoxb-test");
  });

  it("waits out ratelimited, then throws it so the executor can classify it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { calls, client } = fake({
      "/conversations.list?limit=1": channelList({ ok: false, error: "ratelimited" }),
    });
    const caught: unknown[] = [];
    const pending = client.check().catch((error: unknown) => {
      caught.push(error);
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(caught).toHaveLength(1);
    expect(() => {
      throw caught[0];
    }).toThrow("slack answered /conversations.list?limit=1 with ratelimited");
    expect(calls.length).toBeGreaterThan(1);
    vi.useRealTimers();
  });

  it("does not yield an empty page when the list body is ok: false", async () => {
    const { client } = fake({
      "/conversations.list": channelList({ ok: false, error: "invalid_auth" }),
    });

    await expect(client.conversations().next()).rejects.toThrow(/invalid_auth/);
  });
});
