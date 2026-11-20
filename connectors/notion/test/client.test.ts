import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { HttpStatusError, isTerminal, isTransient, NotFound } from "@puppi/sdk";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const { defaultApiVersion } = connector.default;

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: {
    securitySchemes: Record<string, { scheme?: string }>;
    parameters: Record<string, { name?: string; in?: string; schema?: { enum?: string[] } }>;
    schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  };
  paths: Record<
    string,
    Record<
      string,
      | {
          parameters?: { name?: string; in?: string }[];
          requestBody?: {
            required?: boolean;
            content?: {
              "application/json"?: { schema?: { properties?: Record<string, unknown> } };
            };
          };
          responses?: Record<
            string,
            {
              content?: {
                "application/json"?: { schema?: { properties?: Record<string, unknown> } };
              };
            }
          >;
        }
      | undefined
    >
  >;
};

const validationError = JSON.parse(
  readFileSync(new URL("./fixtures/validation-error.json", import.meta.url), "utf8"),
) as unknown;

function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

const userSchema = spec.components.schemas["userObjectResponse"] as object;
const listSchema = spec.components.schemas["pageOrDataSourceListResponse"] as object;
const pageSchema = spec.components.schemas["pageObjectResponse"] as object;
const userListSchema = spec.paths["/v1/users"]?.["get"]?.responses?.["200"]?.content?.[
  "application/json"
]?.schema as object;

function user(id: string): Record<string, unknown> {
  return body(userSchema, { id, name: "Ada" });
}

function sampledPage(id: string): Record<string, unknown> {
  return body(pageSchema, { id });
}

/** A sampled `request_status` can be `incomplete`, which this client treats as a cap. */
function listed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = body(listSchema, overrides);

  if (!Object.hasOwn(overrides, "request_status")) delete sampled["request_status"];

  return sampled;
}

const HOST = "https://api.notion.test";
const TOKEN = "test-token";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fake(reply: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? "GET";
    const raw = init?.body;
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined;
    const call = { url, method, headers, body: parsed };

    calls.push(call);

    const result = reply(call);

    return new Response(result.body === undefined ? "" : JSON.stringify(result.body), {
      status: result.status ?? 200,
    });
  }) as typeof fetch;

  const client = new Client({ base_url: HOST }, { token: TOKEN }, { fetch: fetchImpl });

  return { calls, client };
}

async function collect(
  pages: AsyncIterable<{ cursor: string | number | null; data: { id?: unknown }[] }>,
) {
  const seen: { cursor: string | number | null; ids: unknown[] }[] = [];

  for await (const item of pages) {
    seen.push({
      cursor: item.cursor,
      ids: item.data.map((row) => row.id),
    });
  }

  return seen;
}

describe("notion connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: HOST },
      }),
    );
  });

  it("walks users with the bearer token and Notion-Version, and resumes from start_cursor", async () => {
    const first = `${HOST}/v1/users`;
    const second = `${HOST}/v1/users?start_cursor=page-2`;
    const { calls, client } = fake((call) => {
      if (call.url === first) {
        return {
          body: body(userListSchema, {
            results: [user("u1")],
            next_cursor: "page-2",
            has_more: true,
          }),
        };
      }

      if (call.url === second) {
        return {
          body: body(userListSchema, { results: [user("u2")], next_cursor: null, has_more: false }),
        };
      }

      return { status: 404 };
    });

    const seen = await collect(client.users());

    expect(seen).toEqual([
      { cursor: "page-2", ids: ["u1"] },
      { cursor: null, ids: ["u2"] },
    ]);
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(calls.map((call) => call.url)).toEqual([first, second]);
    expect(calls[0]?.url).not.toContain("page_size");
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers["Notion-Version"]).toBe(defaultApiVersion);
    expect(calls[0]?.body).toBeUndefined();

    const resumedUrl = `${HOST}/v1/users?page_size=25&start_cursor=page-2`;
    const resumed = fake((call) => {
      if (call.url === resumedUrl) {
        return {
          body: body(userListSchema, { results: [user("u2")], next_cursor: null, has_more: false }),
        };
      }

      return { status: 404 };
    });
    const tail = await collect(resumed.client.users({ cursor: "page-2", pageSize: 25 }));

    expect(tail).toEqual([{ cursor: null, ids: ["u2"] }]);
    expect(resumed.calls.map((call) => call.url)).toEqual([resumedUrl]);
  });

  it("ends a user list on an empty page", async () => {
    const { calls, client } = fake(() => ({
      body: body(userListSchema, { results: [], next_cursor: null, has_more: false }),
    }));

    expect(await collect(client.users())).toEqual([]);
    expect(calls.map((call) => call.url)).toEqual([`${HOST}/v1/users`]);
  });

  it("posts search with the cursor in the JSON body", async () => {
    const filter = { property: "object" as const, value: "page" as const };
    let n = 0;
    const { calls, client } = fake(() => {
      n += 1;

      if (n === 1) {
        return {
          body: listed({ results: [sampledPage("p1")], next_cursor: "page-2", has_more: true }),
        };
      }

      return { body: listed({ results: [sampledPage("p2")], next_cursor: null, has_more: false }) };
    });

    const seen = await collect(client.search({ body: { query: "launch", filter } }));

    expect(seen).toEqual([
      { cursor: "page-2", ids: ["p1"] },
      { cursor: null, ids: ["p2"] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([`${HOST}/v1/search`, `${HOST}/v1/search`]);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({ query: "launch", filter });
    expect(calls[1]?.body).toEqual({ query: "launch", filter, start_cursor: "page-2" });
    expect(calls[0]?.url).not.toContain("start_cursor");
    expect(calls[0]?.url).not.toContain(TOKEN);

    const resumed = fake(() => ({
      body: listed({ results: [sampledPage("p2")], next_cursor: null, has_more: false }),
    }));

    expect(
      await collect(
        resumed.client.search({ body: { query: "launch" }, cursor: "page-2", pageSize: 10 }),
      ),
    ).toEqual([{ cursor: null, ids: ["p2"] }]);
    expect(resumed.calls[0]?.body).toEqual({
      query: "launch",
      page_size: 10,
      start_cursor: "page-2",
    });
    expect(resumed.calls[0]?.url).toBe(`${HOST}/v1/search`);
  });

  it("posts a data source query and resumes from start_cursor in the body", async () => {
    const dataSourceId = "b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0";
    const filter = { property: "Done", checkbox: { equals: true } };
    const sorts = [{ timestamp: "created_time" as const, direction: "ascending" as const }];
    const url = `${HOST}/v1/data_sources/${dataSourceId}/query`;
    let n = 0;
    const { calls, client } = fake((call) => {
      expect(call.url).toBe(url);
      n += 1;

      if (n === 1) {
        return {
          body: listed({ results: [sampledPage("p1")], next_cursor: "page-2", has_more: true }),
        };
      }

      return { body: listed({ results: [sampledPage("p2")], next_cursor: null, has_more: false }) };
    });

    const seen = await collect(
      client.queryDataSource({ dataSourceId, body: { filter, sorts }, pageSize: 50 }),
    );

    expect(seen).toEqual([
      { cursor: "page-2", ids: ["p1"] },
      { cursor: null, ids: ["p2"] },
    ]);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ filter, sorts, page_size: 50 });
    expect(calls[1]?.body).toEqual({ filter, sorts, page_size: 50, start_cursor: "page-2" });
    expect(calls[0]?.headers["Notion-Version"]).toBe(defaultApiVersion);
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("throws when a data source query is capped and does not follow next_cursor", async () => {
    const { calls, client } = fake(() => ({
      body: listed({
        results: [sampledPage("p1")],
        next_cursor: "page-2",
        has_more: false,
        request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
        message: "please retry later",
      }),
    }));
    const seen: unknown[] = [];

    let thrown: unknown;

    try {
      for await (const page of client.queryDataSource({ dataSourceId: "ds" })) seen.push(page);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(Object.hasOwn(error, "code")).toBe(false);
    expect(isTerminal(error)).toBe(false);
    expect(error.cause).toBeInstanceOf(Error);
    const cause = error.cause as Error & { code?: unknown };
    expect(cause.code).toBe("query_result_limit_reached");
    expect(isTerminal(cause)).toBe(true);
    expect(error.message).toContain("Narrow the filter");
    expect(error.message).not.toContain("please retry later");
    expect(isTransient(thrown)).toBe(false);
    expect(seen).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${HOST}/v1/data_sources/ds/query`);
  });

  it("reports a 400 by status and a missing data source as not found", async () => {
    const denied = fake(() => ({ status: 400, body: validationError }));

    const rejected = await collect(denied.client.queryDataSource({ dataSourceId: "ds" })).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(rejected).toBeInstanceOf(HttpStatusError);
    expect(rejected).toMatchObject({ status: 400 });
    expect(denied.calls[0]?.url).not.toContain(TOKEN);

    const missing = fake(() => ({
      status: 404,
      body: { object: "error", status: 404, code: "object_not_found" },
    }));

    await expect(async () => {
      for await (const page of missing.client.queryDataSource({ dataSourceId: "missing" }))
        void page;
    }).rejects.toBeInstanceOf(NotFound);
  });

  it("proves the token against the bot user", async () => {
    const { calls, client } = fake((call) => {
      expect(call.url).toBe(`${HOST}/v1/users/me`);

      return { body: user("bot") };
    });

    expect(await client.check()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.headers["Notion-Version"]).toBe(defaultApiVersion);
    expect(calls[0]?.url).not.toContain(TOKEN);
  });
});
