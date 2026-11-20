import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { HttpStatusError, isTerminal, isTransient, NotFound } from "@puppi/sdk";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vite-plus/test";

import * as connector from "../src/index.js";
import {
  Client,
  CompaniesScopeError,
  MissingScrollParamError,
  ScrollExpiredError,
} from "../src/index.js";
import { operations } from "../src/operations.js";

const { defaultApiVersion } = connector.default;

const TOKEN = "intercom-test-token";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  info: { version: string };
  components: {
    securitySchemes: Record<string, { scheme?: string }>;
    schemas: Record<string, object>;
  };
  paths: Record<
    string,
    Record<
      string,
      { description?: string; parameters?: { name: string; in?: string }[] } | undefined
    >
  >;
};

function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

const schemas = spec.components.schemas;

function contact(overrides: Record<string, unknown> = {}) {
  return body(schemas["contact"] as object, overrides);
}

function contactList(overrides: Record<string, unknown> = {}) {
  return body(schemas["contact_list"] as object, overrides);
}

function conversation(overrides: Record<string, unknown> = {}) {
  return body(schemas["conversation_list_item"] as object, overrides);
}

function conversationList(overrides: Record<string, unknown> = {}) {
  return body(schemas["conversation_list"] as object, overrides);
}

function company(overrides: Record<string, unknown> = {}) {
  return body(schemas["company"] as object, overrides);
}

function companyScroll(overrides: Record<string, unknown> = {}) {
  return body(schemas["company_scroll"] as object, overrides);
}

function errorList(code: string) {
  return body(schemas["error"] as object, {
    type: "error.list",
    errors: [{ code, message: "rejected" }],
  });
}

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

type Route = Record<string, unknown> | (() => Response);

function fake(
  routes: Record<string, Route>,
  config: Record<string, unknown> = { base_url: "https://intercom.test" },
) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;

    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    const route = routes[url];

    if (route === undefined) return new Response("missing", { status: 404 });
    if (typeof route === "function") return route();

    return new Response(JSON.stringify(route), { status: 200 });
  }) as typeof fetch;

  const client = new Client(config, { access_token: TOKEN }, { fetch: fetchImpl });

  return { calls, client };
}

function status(statusCode: number, statusText: string, code: string): () => Response {
  return () =>
    new Response(JSON.stringify({ type: "error.list", errors: [{ code, message: "rejected" }] }), {
      status: statusCode,
      statusText,
    });
}

/** The `code` field starts after the 200 characters `HttpStatusError` keeps. */
function hiddenCode(code: string): string {
  return JSON.stringify({
    type: "error.list",
    errors: [{ message: "x".repeat(200), code }],
  });
}

async function failure(result: Promise<unknown>): Promise<Error> {
  try {
    await result;
  } catch (error) {
    if (error instanceof Error) return error;

    throw error;
  }

  throw new Error("expected a rejection");
}

function expectAuthorized(calls: Call[]) {
  for (const call of calls) {
    expect(call.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(call.headers["Intercom-Version"]).toBe(defaultApiVersion);
    expect(call.url).not.toContain(TOKEN);
  }
}

describe("intercom connector", () => {
  it("is a conformant source", async () => {
    const checks = await runSourceConformance({
      connector,
      operations,
      root: new URL("..", import.meta.url),
      config: { base_url: "https://intercom.test" },
    });

    assertConformant(checks);
  });

  it("sends the bearer token and Intercom-Version to the default host", async () => {
    const { calls, client } = fake(
      {
        "https://api.intercom.io/contacts?per_page=1": contactList({
          data: [contact({ id: "c1" })],
          pages: { type: "pages", next: null },
        }),
      },
      {},
    );

    expect(await client.check()).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      url: "https://api.intercom.io/contacts?per_page=1",
      method: "GET",
    });
    expectAuthorized(calls);
  });

  it("walks contact pages with starting_after and resumes from that cursor", async () => {
    const cursor = "cursor-1";
    const first = `https://intercom.test/contacts`;
    const second = `https://intercom.test/contacts?starting_after=${cursor}`;
    const routes = {
      [first]: contactList({
        data: [contact({ id: "c1" })],
        pages: { type: "pages", next: { starting_after: cursor } },
      }),
      [second]: contactList({
        data: [contact({ id: "c2" })],
        pages: { type: "pages", next: null },
      }),
    };
    const walked = fake(routes);
    const seen: { cursor: string | number | null; ids: unknown[] }[] = [];

    for await (const page of walked.client.contacts()) {
      seen.push({ cursor: page.cursor, ids: page.data.map((row) => row.id) });
    }

    expect(seen).toEqual([
      { cursor, ids: ["c1"] },
      { cursor: null, ids: ["c2"] },
    ]);
    expect(walked.calls.map((call) => call.url)).toEqual([first, second]);
    expect(walked.calls.every((call) => call.method === "GET")).toBe(true);
    expectAuthorized(walked.calls);

    const resumed = fake(routes);
    const again: unknown[] = [];

    for await (const page of resumed.client.contacts({ cursor })) {
      again.push(...page.data.map((row) => row.id));
    }

    expect(again).toEqual(["c2"]);
    expect(resumed.calls.map((call) => call.url)).toEqual([second]);
  });

  it("walks conversations from the conversations array and sends per_page", async () => {
    const cursor = "cursor-1";
    const first = "https://intercom.test/conversations?per_page=20";
    const second = `https://intercom.test/conversations?per_page=20&starting_after=${cursor}`;
    const { calls, client } = fake({
      [first]: conversationList({
        conversations: [conversation({ id: "v1" })],
        pages: { type: "pages", next: { starting_after: cursor } },
      }),
      [second]: conversationList({
        conversations: [conversation({ id: "v2" })],
        pages: { type: "pages", next: null },
      }),
    });
    const seen: { cursor: string | number | null; ids: unknown[] }[] = [];

    for await (const page of client.conversations({ perPage: 20 })) {
      seen.push({ cursor: page.cursor, ids: page.data.map((row) => row.id) });
    }

    expect(seen).toEqual([
      { cursor, ids: ["v1"] },
      { cursor: null, ids: ["v2"] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([first, second]);
    expectAuthorized(calls);
  });

  it("walks a companies scroll and resumes from scroll_param", async () => {
    const scroll = "scroll-1";
    const next = "scroll-2";
    const first = "https://intercom.test/companies/scroll";
    const second = `https://intercom.test/companies/scroll?scroll_param=${scroll}`;
    const third = `https://intercom.test/companies/scroll?scroll_param=${next}`;
    const routes = {
      [first]: companyScroll({
        type: "list",
        data: [company({ id: "co1" })],
        pages: null,
        total_count: null,
        scroll_param: scroll,
      }),
      [second]: companyScroll({
        type: "list",
        data: [company({ id: "co2" })],
        pages: null,
        total_count: null,
        scroll_param: next,
      }),
      [third]: companyScroll({
        type: "list",
        data: [],
        pages: null,
        total_count: null,
        scroll_param: "expired-after-this-page",
      }),
    };
    const walked = fake(routes);
    const seen: { cursor: string | number | null; ids: unknown[] }[] = [];

    for await (const page of walked.client.companies()) {
      seen.push({ cursor: page.cursor, ids: page.data.map((row) => row.id) });
    }

    expect(seen).toEqual([
      { cursor: scroll, ids: ["co1"] },
      { cursor: next, ids: ["co2"] },
    ]);
    expect(walked.calls.map((call) => ({ url: call.url, method: call.method }))).toEqual([
      { url: first, method: "GET" },
      { url: second, method: "GET" },
      { url: third, method: "GET" },
    ]);
    expectAuthorized(walked.calls);

    const resumed = fake(routes);
    const again: unknown[] = [];

    for await (const page of resumed.client.companies({ cursor: next })) {
      again.push(...page.data.map((row) => row.id));
    }

    expect(again).toEqual([]);
    expect(resumed.calls.map((call) => call.url)).toEqual([third]);
  });

  it("rejects a companies page that has rows and no scroll_param", async () => {
    const { client } = fake({
      "https://intercom.test/companies/scroll": companyScroll({
        data: [company({ id: "co1" })],
        scroll_param: "",
      }),
    });
    const error = await failure(client.companies().next());

    expect(error).toBeInstanceOf(MissingScrollParamError);
    expect(error).toMatchObject({ code: "missing_scroll_param" });
    expect(error.cause).toBeUndefined();
    expect(isTerminal(error)).toBe(true);
    expect(isTransient(error)).toBe(false);
  });

  it("names read_users_companies only when the companies scroll is token_unauthorized", async () => {
    const missing = fake({
      "https://intercom.test/companies/scroll": status(401, "Unauthorized", "token_unauthorized"),
    });
    const error = await failure(missing.client.companies().next());

    expect(error).toBeInstanceOf(CompaniesScopeError);
    expect(error).toMatchObject({
      code: "token_unauthorized",
      message:
        "intercom authorization failed for access_token (token_unauthorized: read_users_companies)",
    });
    expect(error.cause).toBeInstanceOf(HttpStatusError);
    expect(error.cause).toMatchObject({ status: 401 });
    expect(isTerminal(error)).toBe(true);
    expect(isTransient(error)).toBe(false);
    expect(String(error)).not.toContain(TOKEN);

    const invalid = fake({
      "https://intercom.test/companies/scroll": status(401, "Unauthorized", "unauthorized"),
    });
    const rejected = await failure(invalid.client.companies().next());

    expect(rejected).toBeInstanceOf(HttpStatusError);
    expect(rejected).toMatchObject({ status: 401 });
    expect(isTerminal(rejected)).toBe(false);
    expect(isTransient(rejected)).toBe(false);

    const hidden = fake({
      "https://intercom.test/companies/scroll": () =>
        new Response(hiddenCode("token_unauthorized"), { status: 401, statusText: "Unauthorized" }),
    });
    const unread = await failure(hidden.client.companies().next());

    expect(unread).toBeInstanceOf(HttpStatusError);
    expect(unread).not.toBeInstanceOf(CompaniesScopeError);
    expect(isTransient(unread)).toBe(false);
  });

  it("treats a contacts token_unauthorized as authorization and leaves the companies scope unnamed", async () => {
    const invalid = fake({
      "https://intercom.test/contacts?per_page=1": status(401, "Unauthorized", "unauthorized"),
    });

    await expect(invalid.client.check()).resolves.toEqual({
      ok: false,
      reason: "authentication",
      message: "intercom authentication failed for access_token (401 Unauthorized)",
    });

    const scope = fake({
      "https://intercom.test/contacts?per_page=1": status(
        401,
        "Unauthorized",
        "token_unauthorized",
      ),
    });

    await expect(scope.client.check()).resolves.toEqual({
      ok: false,
      reason: "authorization",
      message: "intercom authorization failed for access_token (401 Unauthorized)",
    });

    const forbidden = fake({
      "https://intercom.test/contacts?per_page=1": status(403, "Forbidden", "token_unauthorized"),
    });

    await expect(forbidden.client.check()).resolves.toEqual({
      ok: false,
      reason: "authorization",
      message: "intercom authorization failed for access_token (403 Forbidden)",
    });
  });

  it("classifies an expired scroll, a second scroll, and an unrelated 404", async () => {
    const occupied = fake({
      "https://intercom.test/companies/scroll": status(400, "Bad Request", "scroll_exists"),
    });
    const conflict = await failure(occupied.client.companies().next());

    expect(conflict).toBeInstanceOf(HttpStatusError);
    expect(conflict).toMatchObject({ status: 400 });
    expect(isTerminal(conflict)).toBe(false);
    expect(isTransient(conflict)).toBe(false);

    const expired = fake({
      "https://intercom.test/companies/scroll?scroll_param=gone": status(
        404,
        "Not Found",
        "not_found",
      ),
    });
    const stale = await failure(expired.client.companies({ cursor: "gone" }).next());

    expect(stale).toBeInstanceOf(ScrollExpiredError);
    expect(stale).toMatchObject({
      code: "scroll_expired",
      message:
        "intercom companies scroll expired; start the companies sync again without this cursor",
    });
    expect(stale.cause).toBeInstanceOf(NotFound);
    expect(isTerminal(stale)).toBe(true);
    expect(isTransient(stale)).toBe(false);

    const otherCode = fake({
      "https://intercom.test/companies/scroll?scroll_param=gone": status(
        400,
        "Bad Request",
        "not_found",
      ),
    });
    const refused = await failure(otherCode.client.companies({ cursor: "gone" }).next());

    expect(refused).toBeInstanceOf(HttpStatusError);
    expect(refused).not.toBeInstanceOf(ScrollExpiredError);

    const first = fake({
      "https://intercom.test/companies/scroll": status(404, "Not Found", "not_found"),
    });

    await expect(first.client.companies().next()).rejects.toBeInstanceOf(NotFound);

    const contacts = fake({
      "https://intercom.test/contacts": status(404, "Not Found", "not_found"),
    });

    await expect(contacts.client.contacts().next()).rejects.toBeInstanceOf(NotFound);

    const down = fake({
      "https://intercom.test/companies/scroll": status(
        503,
        "Service Unavailable",
        "service_unavailable",
      ),
    });
    const fault = await failure(down.client.companies().next());

    expect(fault).toBeInstanceOf(HttpStatusError);
    expect(fault).toMatchObject({ status: 503 });
    expect(isTerminal(fault)).toBe(false);
    expect(isTransient(fault)).toBe(true);
  });

  it("names the status when a list is refused", async () => {
    const refused = fake({
      "https://intercom.test/contacts": () =>
        new Response(JSON.stringify(errorList("unauthorized")), {
          status: 401,
          statusText: "Unauthorized",
        }),
    });

    await expect(refused.client.contacts().next()).rejects.toThrow(/intercom answered 401/);

    const invalid = fake({
      "https://intercom.test/contacts": contactList({
        data: [contact({ id: "c1" })],
        pages: { type: "pages", next: { starting_after: "cursor-1" } },
      }),
      "https://intercom.test/contacts?starting_after=cursor-1": () =>
        new Response(JSON.stringify(errorList("client_error")), {
          status: 400,
          statusText: "Bad Request",
        }),
    });

    const yielded: (string | number | null)[] = [];

    await expect(async () => {
      for await (const page of invalid.client.contacts()) yielded.push(page.cursor);
    }).rejects.toThrow(/intercom answered 400/);
    expect(yielded).toEqual(["cursor-1"]);
  });
});
