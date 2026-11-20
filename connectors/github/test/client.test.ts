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
        parameters?: { name: string; in?: string }[];
        responses: Record<
          string,
          {
            headers?: Record<string, unknown>;
            content: {
              "application/json": {
                schema: {
                  type?: string;
                  items?: { $ref?: string };
                  properties?: Record<string, unknown>;
                };
              };
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

const issueSchema = spec.components.schemas["issue"] as object;

function issue(overrides: Record<string, unknown> = {}) {
  return body(issueSchema, overrides);
}

function user(overrides: Record<string, unknown> = {}) {
  return body(spec.components.schemas["user"] as object, overrides);
}

const FIRST = "https://api.github.test/repos/acme/app/issues";
const NEXT = "https://api.github.test/repos/acme/app/issues?page=2";

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

  const client = new Client(
    { base_url: "https://api.github.test" },
    { token: "gho_test" },
    { fetch: fetchImpl },
  );

  return { calls, client };
}

describe("github connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://api.github.test" },
      }),
    );
  });

  it("walks Link headers over the issue array, yielding the next URL as the cursor", async () => {
    const { calls, client } = fake({
      [FIRST]: {
        body: [issue({ id: 1, number: 10, title: "First" })],
        link: `<${NEXT}>; rel="next"`,
      },
      [NEXT]: {
        body: [issue({ id: 2, number: 11, title: "Second" })],
      },
    });

    const seen: { cursor: string | number | null; ids: number[] }[] = [];

    for await (const page of client.issues({ owner: "acme", repo: "app" })) {
      seen.push({
        cursor: page.cursor,
        ids: page.data.map((row) => row.id),
      });
    }

    expect(seen).toEqual([
      { cursor: NEXT, ids: [1] },
      { cursor: null, ids: [2] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([FIRST, NEXT]);
    expect(calls[0]?.url).not.toContain("per_page");
    expect(calls[0]?.url).not.toContain("state=");
    expect(calls[0]?.headers["accept"]).toBe("application/vnd.github+json");
    expect(calls[0]?.headers["x-github-api-version"]).toBe(defaultApiVersion);
    expect(calls[0]?.headers["authorization"]).toBe("Bearer gho_test");
    expect(calls[0]?.url).not.toContain("gho_test");
  });

  it("ends on an empty array", async () => {
    const { calls, client } = fake({ [FIRST]: { body: [] } });
    const seen: unknown[] = [];

    for await (const page of client.issues({ owner: "acme", repo: "app" })) seen.push(page);

    expect(seen).toEqual([]);
    expect(calls.map((call) => call.url)).toEqual([FIRST]);
  });

  it("resumes from the next URL", async () => {
    const { calls, client } = fake({
      [NEXT]: { body: [issue({ id: 2, number: 11, title: "Second" })] },
    });

    const ids: number[] = [];

    for await (const page of client.issues({ owner: "acme", repo: "app", cursor: NEXT })) {
      ids.push(...page.data.map((row) => row.id));
    }

    expect(ids).toEqual([2]);
    expect(calls.map((call) => call.url)).toEqual([NEXT]);
  });

  it("sends per_page, state, and since when the caller passed them", async () => {
    const url =
      "https://api.github.test/repos/acme/app/issues?state=all&since=2020-01-01T00%3A00%3A00Z&per_page=5";
    const { calls, client } = fake({
      [url]: { body: [issue({ id: 1 })] },
    });

    const ids: number[] = [];

    for await (const page of client.issues({
      owner: "acme",
      repo: "app",
      state: "all",
      since: "2020-01-01T00:00:00Z",
      perPage: 5,
    })) {
      ids.push(...page.data.map((row) => row.id));
    }

    expect(ids).toEqual([1]);
    expect(calls.map((call) => call.url)).toEqual([url]);
  });

  it("proves the token against the authenticated user", async () => {
    const { calls, client } = fake({
      "https://api.github.test/user": { body: user({ login: "ada", id: 1 }) },
    });

    expect(await client.check()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://api.github.test/user");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer gho_test");
    expect(calls[0]?.headers["accept"]).toBe("application/vnd.github+json");
    expect(calls[0]?.headers["x-github-api-version"]).toBe("2022-11-28");
  });
});
