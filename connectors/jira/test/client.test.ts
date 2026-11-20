import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, object> };
};

/** A response body from the pinned schema, with the fields this case cares about. */
function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

function issue(id: string) {
  return body(spec.components.schemas["Issue"]!, {
    id,
    key: `DEMO-${id}`,
    fields: body(spec.components.schemas["IssueFields"]!, {
      summary: `Issue ${id}`,
      updated: "2024-01-01T00:00:00.000+0000",
    }),
  });
}

function search(nextPageToken: string | null) {
  return body(spec.components.schemas["SearchResults"]!, {
    isLast: nextPageToken === null,
    nextPageToken,
    issues: [issue(nextPageToken === null ? "2" : "1")],
  });
}

function user() {
  return body(spec.components.schemas["User"]!, {
    accountId: "1",
    emailAddress: "ada@acme.com",
  });
}

describe("jira connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://acme.atlassian.net" },
      }),
    );
  });

  it("sends the email and API token as Basic", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });

      return new Response(JSON.stringify(user()), { status: 200 });
    }) as typeof fetch;

    const client = new Client(
      { base_url: "https://acme.atlassian.net", email: "ada@acme.com" },
      { api_token: "tok-1" },
      { fetch: fetchImpl },
    );

    expect(await client.check()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://acme.atlassian.net/rest/api/3/myself");
    expect(calls[0]?.headers["authorization"]).toBe(`Basic ${btoa("ada@acme.com:tok-1")}`);
    expect(calls[0]?.url).not.toContain("tok-1");
    expect(calls[0]?.url).not.toContain("ada@acme.com");
  });

  it("walks two pages of one issue each and stops before a third request", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      const token = new URL(url).searchParams.get("nextPageToken");

      return new Response(JSON.stringify(search(token === null ? "token-2" : null)), {
        status: 200,
      });
    }) as typeof fetch;

    const client = new Client(
      { base_url: "https://acme.atlassian.net", email: "ada@acme.com" },
      { api_token: "tok-1" },
      { fetch: fetchImpl },
    );

    const seen: { cursor: string | number | null; ids: string[] }[] = [];

    for await (const page of client.issues({ jql: "project = DEMO", maxResults: 1 })) {
      seen.push({ cursor: page.cursor, ids: page.data.map((row) => row.id) });
    }

    expect(seen).toEqual([
      { cursor: "token-2", ids: ["1"] },
      { cursor: null, ids: ["2"] },
    ]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!).pathname).toBe("/rest/api/3/search/jql");
    expect(new URL(calls[0]!).searchParams.get("nextPageToken")).toBeNull();
    expect(new URL(calls[0]!).searchParams.get("jql")).toBe("project = DEMO");
    expect(new URL(calls[0]!).searchParams.get("maxResults")).toBe("1");
    expect(new URL(calls[0]!).searchParams.get("fields")).toBe("summary,updated");
    expect(new URL(calls[1]!).searchParams.get("nextPageToken")).toBe("token-2");
    expect(new URL(calls[1]!).searchParams.get("maxResults")).toBe("1");
    expect(new URL(calls[1]!).searchParams.get("fields")).toBe("summary,updated");
  });

  it("resolves the site from domain and rejects a missing one", async () => {
    const hosts: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      hosts.push(new URL(input instanceof Request ? input.url : String(input)).origin);

      return new Response(JSON.stringify(user()), { status: 200 });
    }) as typeof fetch;

    const cases: { config: Record<string, unknown>; origin: string }[] = [
      { config: { domain: "acme" }, origin: "https://acme.atlassian.net" },
      { config: { domain: "jira.example.com" }, origin: "https://jira.example.com" },
      { config: { domain: "https://custom.example" }, origin: "https://custom.example" },
      {
        config: { domain: "ignored", base_url: "https://override.example" },
        origin: "https://override.example",
      },
    ];

    for (const { config, origin } of cases) {
      hosts.length = 0;
      const client = new Client(
        { ...config, email: "ada@acme.com" },
        { api_token: "tok-1" },
        { fetch: fetchImpl },
      );

      expect(await client.check()).toEqual({ ok: true });
      expect(hosts).toEqual([origin]);
    }

    expect(() => new Client({}, { api_token: "tok-1" })).toThrow("jira requires domain");
  });
});
