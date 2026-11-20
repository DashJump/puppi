import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { isTerminal, isTransient } from "@puppi/sdk";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vitest";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const HOST = "https://sentry.test";
const TOKEN = "test-token";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: { securitySchemes: Record<string, { type?: string; scheme?: string }> };
  paths: Record<
    string,
    {
      get?: {
        operationId?: string;
        security?: { auth_token?: string[] }[];
        parameters?: {
          name: string;
          in?: string;
          schema?: { default?: unknown; enum?: string[] };
        }[];
        responses: Record<string, { headers?: Record<string, unknown> }>;
      };
      post?: unknown;
      put?: unknown;
      delete?: unknown;
    }
  >;
};

const PROJECTS = "/api/0/organizations/{organization_id_or_slug}/projects/";
const ISSUES = "/api/0/organizations/{organization_id_or_slug}/issues/";
const EVENTS = "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/events/";

function row(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const schema = spec.paths[path]?.get?.responses["200"] as {
    content: { "application/json": { schema: { items: object } } };
  };
  const sampled = sample(
    schema.content["application/json"].schema.items,
    { skipNonRequired: true },
    spec,
  );

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

function link(rel: "next" | "previous", url: string, results: boolean, cursor: string): string {
  return `<${url}>; rel="${rel}"; results="${results ? "true" : "false"}"; cursor="${cursor}"`;
}

function page(previous: string, next: string): string {
  return `${previous}, ${next}`;
}

function causeOf(error: unknown): unknown {
  return error !== null && typeof error === "object" && "cause" in error ? error.cause : undefined;
}

async function walk(client: Client, organization: string) {
  const pages = [];

  for await (const projectPage of client.projects({ organization })) pages.push(projectPage);

  return pages;
}

function fake(
  routes: Record<string, { body?: unknown; link?: string; status?: number; text?: string }>,
  secrets: Record<string, string> = { token: TOKEN },
) {
  const calls: { url: string; headers: Record<string, string> }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, headers: Object.fromEntries(headers.entries()) });
    const route = routes[url];

    if (route === undefined) return new Response("missing", { status: 404 });

    const responseHeaders = new Headers();

    if (route.link) responseHeaders.set("link", route.link);

    if (route.status && route.status !== 200) {
      return new Response(route.text ?? "nope", {
        status: route.status,
        statusText: route.status === 400 ? "Bad Request" : "Error",
        headers: responseHeaders,
      });
    }

    return new Response(JSON.stringify(route.body ?? []), {
      status: 200,
      headers: responseHeaders,
    });
  }) as typeof fetch;

  const client = new Client({ base_url: HOST }, secrets, { fetch: fetchImpl });

  return { calls, client };
}

const PROJECTS_FIRST = `${HOST}/api/0/organizations/acme/projects/`;
const PROJECTS_NEXT = `${HOST}/api/0/organizations/acme/projects/?&cursor=100:0:0`;
const PROJECTS_LAST = `${HOST}/api/0/organizations/acme/projects/?&cursor=200:0:0`;

describe("sentry connector", () => {
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

  it("walks projects until Link results is false, and sends the bearer token", async () => {
    const first = row(PROJECTS, { id: "3", slug: "prime-mover" });
    const second = row(PROJECTS, { id: "4", slug: "pump-station" });
    const { calls, client } = fake({
      [PROJECTS_FIRST]: {
        body: [first],
        link: page(
          link("previous", `${PROJECTS_FIRST}?&cursor=0:0:1`, false, "0:0:1"),
          link("next", PROJECTS_NEXT, true, "100:0:0"),
        ),
      },
      [PROJECTS_NEXT]: {
        body: [second],
        link: page(
          link("previous", PROJECTS_FIRST, true, "0:0:1"),
          link("next", PROJECTS_LAST, false, "200:0:0"),
        ),
      },
    });

    const seen: { cursor: string | number | null; ids: unknown[] }[] = [];

    for await (const projectPage of client.projects({ organization: "acme" })) {
      seen.push({ cursor: projectPage.cursor, ids: projectPage.data.map((project) => project.id) });
    }

    expect(seen).toEqual([
      { cursor: PROJECTS_NEXT, ids: ["3"] },
      { cursor: null, ids: ["4"] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([PROJECTS_FIRST, PROJECTS_NEXT]);
    expect(new URL(calls[0]?.url ?? "").searchParams.has("cursor")).toBe(false);
    expect(new URL(calls[0]?.url ?? "").searchParams.has("per_page")).toBe(false);
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[1]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(calls[1]?.url).not.toContain(TOKEN);
  });

  it("resumes a project walk from the next URL", async () => {
    const { calls, client } = fake({
      [PROJECTS_NEXT]: { body: [row(PROJECTS, { id: "4" })] },
    });
    const ids: string[] = [];

    for await (const projectPage of client.projects({
      organization: "acme",
      cursor: PROJECTS_NEXT,
    })) {
      ids.push(...projectPage.data.map((project) => project.id));
    }

    expect(ids).toEqual(["4"]);
    expect(calls.map((call) => call.url)).toEqual([PROJECTS_NEXT]);
  });

  it("follows an empty page while results is true", async () => {
    const { calls, client } = fake({
      [PROJECTS_FIRST]: {
        body: [],
        link: link("next", PROJECTS_NEXT, true, "100:0:0"),
      },
      [PROJECTS_NEXT]: {
        body: [row(PROJECTS, { id: "4" })],
        link: link("next", PROJECTS_LAST, false, "200:0:0"),
      },
    });
    const ids: string[] = [];

    for await (const projectPage of client.projects({ organization: "acme" })) {
      ids.push(...projectPage.data.map((project) => project.id));
    }

    expect(ids).toEqual(["4"]);
    expect(calls.map((call) => call.url)).toEqual([PROJECTS_FIRST, PROJECTS_NEXT]);
  });

  it("sends project filters only when the caller passed them", async () => {
    const filtered = `${HOST}/api/0/organizations/acme/projects/?per_page=5&query=web`;
    const { calls, client } = fake({
      [PROJECTS_FIRST]: { body: [] },
      [filtered]: { body: [row(PROJECTS, { id: "9" })] },
    });

    const plain: unknown[] = [];

    for await (const projectPage of client.projects({ organization: "acme" }))
      plain.push(projectPage);

    const ids: string[] = [];

    for await (const projectPage of client.projects({
      organization: "acme",
      perPage: 5,
      query: "web",
    })) {
      ids.push(...projectPage.data.map((project) => project.id));
    }

    expect(plain).toEqual([]);
    expect(ids).toEqual(["9"]);
    expect(calls.map((call) => call.url)).toEqual([PROJECTS_FIRST, filtered]);
  });

  it("sends issue filters as one value each and omits query unless asked", async () => {
    const plainUrl = `${HOST}/api/0/organizations/acme/issues/`;
    const filtered = new URL(plainUrl);
    filtered.searchParams.set("query", "");
    filtered.searchParams.set("limit", "25");
    filtered.searchParams.set("sort", "freq");
    filtered.searchParams.set("project", "pump-station");
    filtered.searchParams.set("environment", "production");
    filtered.searchParams.set("statsPeriod", "24h");
    filtered.searchParams.set("start", "2020-01-01T00:00:00.000Z");
    filtered.searchParams.set("end", "2020-01-02T00:00:00.000Z");
    const { calls, client } = fake({
      [plainUrl]: { body: [row(ISSUES, { id: "1" })] },
      [filtered.toString()]: { body: [row(ISSUES, { id: "2" })] },
    });

    const plain: string[] = [];

    for await (const issuePage of client.issues({ organization: "acme" })) {
      plain.push(...issuePage.data.map((issue) => issue.id));
    }

    const filteredIds: string[] = [];

    for await (const issuePage of client.issues({
      organization: "acme",
      query: "",
      limit: 25,
      sort: "freq",
      project: "pump-station",
      environment: "production",
      statsPeriod: "24h",
      start: "2020-01-01T00:00:00.000Z",
      end: "2020-01-02T00:00:00.000Z",
    })) {
      filteredIds.push(...issuePage.data.map((issue) => issue.id));
    }

    expect(plain).toEqual(["1"]);
    expect(filteredIds).toEqual(["2"]);
    expect(calls.map((call) => call.url)).toEqual([plainUrl, filtered.toString()]);
    expect([...filtered.searchParams.keys()]).toEqual([
      "query",
      "limit",
      "sort",
      "project",
      "environment",
      "statsPeriod",
      "start",
      "end",
    ]);
  });

  it("sends one project's event query", async () => {
    const url = new URL(`${HOST}/api/0/projects/acme/pump-station/events/`);
    url.searchParams.set("statsPeriod", "24h");
    url.searchParams.set("start", "2020-01-01T00:00:00.000Z");
    url.searchParams.set("end", "2020-01-02T00:00:00.000Z");
    url.searchParams.set("full", "true");
    url.searchParams.set("sample", "false");
    const { calls, client } = fake({
      [url.toString()]: {
        body: [row(EVENTS, { id: "evt", eventID: "9fac2ceed9344f2bbfdd1fdacb0ed9b1" })],
      },
    });
    const ids: { id: string; eventID: string }[] = [];

    for await (const eventPage of client.events({
      organization: "acme",
      project: "pump-station",
      statsPeriod: "24h",
      start: "2020-01-01T00:00:00.000Z",
      end: "2020-01-02T00:00:00.000Z",
      full: true,
      sample: false,
    })) {
      ids.push(...eventPage.data.map((event) => ({ id: event.id, eventID: event.eventID })));
    }

    expect(ids).toEqual([{ id: "evt", eventID: "9fac2ceed9344f2bbfdd1fdacb0ed9b1" }]);
    expect(calls.map((call) => call.url)).toEqual([url.toString()]);
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("refuses a next URL on another origin", async () => {
    const { calls, client } = fake({
      [PROJECTS_FIRST]: {
        body: [row(PROJECTS, { id: "3" })],
        link: link(
          "next",
          "https://evil.example/api/0/organizations/acme/projects/?&cursor=1:0:0",
          true,
          "1:0:0",
        ),
      },
    });

    await expect(walk(client, "acme")).rejects.toThrow(/evil\.example/);
    expect(calls.map((call) => call.url)).toEqual([PROJECTS_FIRST]);
  });

  it("throws on a bad cursor and on an unknown organization", async () => {
    const bad = fake({
      [PROJECTS_FIRST]: { status: 400, text: "Invalid cursor" },
    });

    const caught = await walk(bad.client, "acme").then(
      () => null,
      (error: unknown) => error,
    );

    expect(caught).toMatchObject({ name: "HttpStatusError", status: 400 });
    expect(String(caught)).toContain("400");
    expect(String(caught)).not.toContain(TOKEN);
    expect(bad.calls).toHaveLength(1);

    const missing = fake({});

    await expect(walk(missing.client, "missing")).rejects.toMatchObject({ name: "NotFound" });
    expect(missing.calls).toHaveLength(1);
  });

  it("names org:read when check is forbidden and not when the token is rejected", async () => {
    const url = `${HOST}/api/0/organizations/`;
    const forbidden = fake({ [url]: { status: 403, text: "forbidden" } });
    const denied = await forbidden.client.check();

    expect(denied).toMatchObject({ ok: false, reason: "authorization" });
    expect(denied.ok ? "" : denied.message).toContain("org:read");
    expect(denied.ok ? "" : denied.message).toContain("token");
    expect(JSON.stringify(denied)).not.toContain(TOKEN);
    expect(forbidden.calls).toHaveLength(1);
    expect(forbidden.calls[0]?.url).toBe(url);

    const rejected = fake({ [url]: { status: 401, text: "no" } });
    const unauthenticated = await rejected.client.check();

    expect(unauthenticated).toMatchObject({ ok: false, reason: "authentication" });
    expect(unauthenticated.ok ? "" : unauthenticated.message).not.toContain("org:read");
    expect(unauthenticated.ok ? "" : unauthenticated.message).toContain("token");
    expect(JSON.stringify(unauthenticated)).not.toContain(TOKEN);
  });

  it("rejects a list body that is not an array without retrying on its text", async () => {
    const { calls, client } = fake({
      [PROJECTS_FIRST]: { body: { detail: "503 timeout" } },
    });
    const caught = await walk(client, "acme").then(
      () => null,
      (error: unknown) => error,
    );

    expect(String(caught)).toContain("expected a JSON array");
    expect(String(caught)).toContain("503");
    expect(isTransient(caught)).toBe(false);
    expect(isTerminal(caught) || isTerminal(causeOf(caught))).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
