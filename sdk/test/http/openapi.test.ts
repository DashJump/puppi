import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyOperations,
  defineConnector,
  ExpiredPageToken,
  HttpStatusError,
  isTransient,
  OpenApiClient,
  openApiClientOptions,
  type PageArgs,
  type PageRule,
} from "../../src/index.js";

/** Every body in these tests carries an id. */
type IdApi = { responses: Record<string, { id: string }> };

const stripe = {
  paths: {
    "/v1/customers": {
      get: {
        operationId: "GetCustomers",
        parameters: [
          { name: "limit", in: "query" },
          { name: "starting_after", in: "query" },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: { type: "object", properties: { id: { type: "string" } } },
                    },
                    has_more: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/customers/{customer}": {
      get: {
        operationId: "GetCustomersCustomer",
        parameters: [{ name: "customer", in: "path", required: true }],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { type: "object", properties: { id: { type: "string" } } },
              },
            },
          },
        },
      },
    },
  },
};

const customersRule = {
  rows: "data",
  next: { last: "id", while: "has_more" },
  param: "starting_after",
};

function stripeOperations() {
  return classifyOperations(stripe);
}

describe("classifyOperations", () => {
  it("records each GET's path and query parameters", () => {
    const operations = stripeOperations();

    expect(operations["GetCustomers"]).toEqual({
      method: "get",
      path: "/v1/customers",
      query: ["limit", "starting_after"],
    });
    expect(operations["GetCustomersCustomer"]).toEqual({
      method: "get",
      path: "/v1/customers/{customer}",
      query: [],
    });
  });
});

const slackRule = {
  rows: "channels",
  next: "response_metadata.next_cursor",
  param: "cursor",
};

/** The walker is protected. Tests reach it the way a connector method does. */
class Probe extends OpenApiClient<IdApi> {
  walk(operationId: keyof IdApi["responses"], rule: PageRule, args: PageArgs = {}) {
    return this.pages<{ id: string }>(operationId, rule, args);
  }
}

describe("OpenApiClient", () => {
  it("walks a cursor list and reads one record", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);

      if (url.endsWith("/v1/customers/cus_1")) return json({ id: "cus_1" });
      if (url.includes("starting_after=cus_1"))
        return json({ data: [{ id: "cus_2" }], has_more: false });

      return json({ data: [{ id: "cus_1" }], has_more: true });
    }) as typeof fetch;

    const client = new Probe(
      { base_url: "https://stripe.test" },
      { fetch: fetchImpl },
      { api: "stripe", baseUrl: "https://stripe.test" },
      {
        operations: stripeOperations(),
      },
    );

    const seen: { cursor: string | number | null; ids: string[] }[] = [];

    for await (const page of client.walk("GetCustomers", customersRule)) {
      seen.push({
        cursor: page.cursor,
        ids: page.data.map((row) => row.id),
      });
    }

    expect(seen).toEqual([
      { cursor: "cus_1", ids: ["cus_1"] },
      { cursor: null, ids: ["cus_2"] },
    ]);
    expect(await client.read("GetCustomersCustomer", { path: { customer: "cus_1" } })).toEqual({
      id: "cus_1",
    });
    expect(calls[0]).toBe("https://stripe.test/v1/customers");
  });

  it("follows the last id while has_more is true, and throws when that page has no id", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);

      if (url.includes("starting_after=")) return json({ data: [], has_more: true });

      return json({ data: [{ id: "500" }], has_more: true });
    }) as typeof fetch;

    const client = new Probe(
      { base_url: "https://stripe.test" },
      { fetch: fetchImpl },
      { api: "stripe", baseUrl: "https://stripe.test" },
      { operations: stripeOperations() },
    );

    const seen: string[] = [];
    let thrown: unknown;

    try {
      for await (const page of client.walk("GetCustomers", customersRule)) {
        seen.push(...page.data.map((row) => row.id));
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & Record<symbol, unknown>;

    expect(error.message).toMatch(/has_more is true and the page has no id/);
    expect(error.message).toMatch(/starting_after=500/);
    expect(error.name).toBe("TerminalError");
    expect(error[Symbol.for("puppi.terminal_error")]).toBe(true);
    expect(isTransient(error)).toBe(false);
    expect(seen).toEqual(["500"]);
    expect(calls).toEqual([
      "https://stripe.test/v1/customers",
      "https://stripe.test/v1/customers?starting_after=500",
    ]);
  });

  it("ends the walk on an empty page when has_more is false", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.includes("starting_after=")) return json({ data: [], has_more: false });

      return json({ data: [{ id: "cus_1" }], has_more: true });
    }) as typeof fetch;

    const client = new Probe(
      { base_url: "https://stripe.test" },
      { fetch: fetchImpl },
      { api: "stripe", baseUrl: "https://stripe.test" },
      { operations: stripeOperations() },
    );

    const seen: { cursor: string | number | null; ids: string[] }[] = [];

    for await (const page of client.walk("GetCustomers", customersRule)) {
      seen.push({ cursor: page.cursor, ids: page.data.map((row) => row.id) });
    }

    expect(seen).toEqual([{ cursor: "cus_1", ids: ["cus_1"] }]);
  });

  it("rejects an expired page token and leaves a bad query as a status error", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);

      if (url.includes("starting_after=old")) {
        return new Response(JSON.stringify({ error: "invalid page token" }), {
          status: 400,
          statusText: "Bad Request",
        });
      }

      if (url.includes("starting_after=bad")) {
        return new Response("no such field", { status: 400, statusText: "Bad Request" });
      }

      return json({ data: [{ id: "cus_1" }], has_more: false });
    }) as typeof fetch;

    const client = new Probe(
      { base_url: "https://stripe.test" },
      { fetch: fetchImpl },
      { api: "stripe", baseUrl: "https://stripe.test" },
      { operations: stripeOperations() },
    );

    await expect(async () => {
      for await (const page of client.walk("GetCustomers", customersRule, { cursor: "old" })) {
        void page;
      }
    }).rejects.toBeInstanceOf(ExpiredPageToken);

    await expect(async () => {
      for await (const page of client.walk("GetCustomers", customersRule, { cursor: "bad" })) {
        void page;
      }
    }).rejects.toBeInstanceOf(HttpStatusError);
  });

  it("uses the connector classifier instead of the status heuristic", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      return new Response("down", { status: 500, statusText: "Internal Server Error" });
    }) as typeof fetch;

    const client = new Probe(
      { base_url: "https://stripe.test" },
      { fetch: fetchImpl },
      { api: "stripe", baseUrl: "https://stripe.test" },
      {
        operations: stripeOperations(),
        expiredPageToken: (error) => error instanceof HttpStatusError && error.status === 500,
      },
    );

    await expect(async () => {
      for await (const page of client.walk("GetCustomers", customersRule, { cursor: "old" })) {
        void page;
      }
    }).rejects.toBeInstanceOf(ExpiredPageToken);
    expect(calls).toBe(1);
  });

  it("sends the query the method passed, whatever the parameter is named", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(input instanceof Request ? input.url : String(input));
      return json({ data: [{ id: "cus_1" }], has_more: false });
    }) as typeof fetch;

    const client = new Probe(
      { base_url: "https://stripe.test" },
      { fetch: fetchImpl },
      { api: "stripe", baseUrl: "https://stripe.test" },
      { operations: stripeOperations() },
    );

    const pages = [];

    for await (const page of client.walk("GetCustomers", customersRule, { query: { limit: 25 } })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    expect(calls[0]).toBe("https://stripe.test/v1/customers?limit=25");

    calls.length = 0;

    for await (const page of client.walk("GetCustomers", customersRule, {
      query: { per_page: 50 },
    })) {
      pages.push(page);
    }

    expect(calls[0]).toBe("https://stripe.test/v1/customers?per_page=50");
  });

  it("walks a field path declared on the operation", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);

      if (url.includes("cursor=abc")) {
        return json({
          ok: true,
          channels: [{ id: "C2" }],
          response_metadata: { next_cursor: "" },
        });
      }

      return json({
        ok: true,
        channels: [{ id: "C1" }],
        response_metadata: { next_cursor: "abc" },
      });
    }) as typeof fetch;

    const client = new Probe(
      { base_url: "https://slack.test" },
      { fetch: fetchImpl },
      { api: "slack", baseUrl: "https://slack.test" },
      {
        operations: {
          conversationsList: {
            method: "get",
            path: "/conversations.list",
            query: ["limit", "cursor"],
          },
        },
      },
    );

    const seen: { cursor: string | number | null; ids: string[] }[] = [];

    for await (const page of client.walk("conversationsList", slackRule, { query: { limit: 2 } })) {
      seen.push({
        cursor: page.cursor,
        ids: page.data.map((row) => row.id),
      });
    }

    expect(seen).toEqual([
      { cursor: "abc", ids: ["C1"] },
      { cursor: null, ids: ["C2"] },
    ]);
    expect(calls[1]).toBe("https://slack.test/conversations.list?limit=2&cursor=abc");
  });

  it("refuses a next page on another origin, so the credential stays home", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(input instanceof Request ? input.url : String(input));

      return json({ results: [{ id: 1 }], next: "https://elsewhere.test/items?page=2" });
    }) as typeof fetch;

    const client = new Probe(
      { base_url: "https://api.test" },
      { fetch: fetchImpl },
      { api: "example", baseUrl: "https://api.test", headers: { authorization: "Bearer k" } },
      {
        operations: {
          items: {
            method: "get",
            path: "/items",
            query: [],
          },
        },
      },
    );

    const pages = client.walk("items", { rows: "results", next: "next" });

    await expect(pages.next()).resolves.toMatchObject({ value: { data: [{ id: 1 }] } });
    await expect(pages.next()).rejects.toThrow(
      /https:\/\/elsewhere\.test, not https:\/\/api\.test/,
    );
    expect(calls).toEqual(["https://api.test/items"]);
  });

  it("lets the connector replace the page rule for one operation", async () => {
    const client = new Probe(
      { base_url: "https://example.test" },
      {
        fetch: async () => json({ ignored: true }),
      },
      { api: "example", baseUrl: "https://example.test" },
      {
        operations: {
          items: {
            method: "get",
            path: "/items",
            query: [],
          },
        },
        extract: () => ({ data: [{ id: "from-hook" }], next: null }),
      },
    );

    const pages = [];

    for await (const page of client.walk("items", { rows: "items", next: "next" })) {
      pages.push(page);
    }

    expect(pages).toEqual([{ cursor: null, data: [{ id: "from-hook" }] }]);
  });

  it("throws when the rows field is not an array", async () => {
    const client = new Probe(
      { base_url: "https://stripe.test" },
      {
        fetch: async () => json({ customers: [{ id: "cus_1" }], has_more: false }),
      },
      { api: "stripe", baseUrl: "https://stripe.test" },
      { operations: stripeOperations() },
    );

    await expect(
      client.walk("GetCustomers", { ...customersRule, rows: "data" }).next(),
    ).rejects.toThrow(/rows "data" is not an array/);
  });
});

const arrayRule = {
  rows: "$",
  next: { header: "link", rel: "next" },
} as const satisfies PageRule;

function listProbe(
  fetchImpl: typeof fetch,
  operations: Record<string, { method: "get"; path: string; query: string[] }>,
) {
  return new Probe(
    { base_url: "https://api.test" },
    { fetch: fetchImpl },
    { api: "example", baseUrl: "https://api.test" },
    { operations },
  );
}

describe("bare array rows", () => {
  const operations = {
    items: { method: "get" as const, path: "/items", query: [] },
  };
  const next = "https://api.test/items?page=2";

  it("walks a JSON array and stops on the page with no next link", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);

      if (url === next) return json([{ id: "b" }]);

      return json([{ id: "a" }], { link: `<${next}>; rel="next"` });
    }) as typeof fetch;

    const seen: { cursor: string | number | null; ids: string[] }[] = [];

    for await (const page of listProbe(fetchImpl, operations).walk("items", arrayRule)) {
      seen.push({ cursor: page.cursor, ids: page.data.map((row) => row.id) });
    }

    expect(seen).toEqual([
      { cursor: next, ids: ["a"] },
      { cursor: null, ids: ["b"] },
    ]);
    expect(calls).toEqual(["https://api.test/items", next]);
  });

  it("ends on an empty array", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(input instanceof Request ? input.url : String(input));

      return json([]);
    }) as typeof fetch;

    const seen: unknown[] = [];

    for await (const page of listProbe(fetchImpl, operations).walk("items", arrayRule)) {
      seen.push(page);
    }

    expect(seen).toEqual([]);
    expect(calls).toEqual(["https://api.test/items"]);
  });

  it("throws when the body is not an array", async () => {
    const fetchImpl = (async () => json({ items: [{ id: "a" }] })) as typeof fetch;

    await expect(listProbe(fetchImpl, operations).walk("items", arrayRule).next()).rejects.toThrow(
      /rows "\$" is not an array/,
    );
  });
});

function refusingClient(body: unknown) {
  const fetchImpl = (async () => json(body)) as typeof fetch;

  return new (class extends Probe {
    constructor() {
      super(
        { base_url: "https://api.test" },
        { fetch: fetchImpl },
        { api: "example", baseUrl: "https://api.test" },
        {
          operations: {
            items: {
              method: "get",
              path: "/items",
              query: ["limit", "cursor"],
            },
            item: { method: "get", path: "/item", query: [] },
          },
          responseError: (answer) => {
            const { ok, error } = answer as { ok?: boolean; error?: string };

            if (ok !== false) return undefined;
            if (error === "bad_token") return { code: error, reason: "authentication" };

            return { code: error ?? "unknown" };
          },
        },
      );
    }

    override check() {
      return this.prove("/items?limit=1", "token");
    }
  })();
}

/** Fake timers cover the clock the client sleeps on, and leave the socket clock alone. */
function useWaitTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}

/** Records how `pending` settles, so a retry can fail before the test awaits it. */
function watch<T>(pending: Promise<T>): {
  outcome?: { ok: true; value: T } | { ok: false; error: unknown };
} {
  const box: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};

  void pending.then(
    (value) => {
      box.outcome = { ok: true, value };
    },
    (error: unknown) => {
      box.outcome = { ok: false, error };
    },
  );

  return box;
}

function take<T>(box: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } }): T {
  if (!box.outcome) throw new Error("the call did not finish");
  if (!box.outcome.ok) throw box.outcome.error;

  return box.outcome.value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("responseError", () => {
  it("throws from read and pages when a 200 body is a refusal", async () => {
    useWaitTimers();
    const client = refusingClient({ ok: false, error: "rate_limited" });
    const read = watch(client.read("item"));
    const page = watch(
      client.walk("items", { rows: "items", next: "next", param: "cursor" }).next(),
    );

    await vi.advanceTimersByTimeAsync(15_000);
    expect(() => take(read)).toThrow("example answered /item with rate_limited");
    expect(() => take(page)).toThrow(/with rate_limited/);
  });

  it("fails check with the reason the hook names", async () => {
    await expect(refusingClient({ ok: false, error: "bad_token" }).check()).resolves.toEqual({
      ok: false,
      reason: "authentication",
      message: "example authentication failed for token (bad_token)",
    });
  });

  it("waits out a rate limit reported in a 200 body, using Retry-After", async () => {
    useWaitTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      if (calls === 1) {
        return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), {
          status: 200,
          headers: { "retry-after": "2" },
        });
      }

      return json({ ok: true, id: "a" });
    }) as typeof fetch;

    const client = new (class extends Probe {
      constructor() {
        super(
          { base_url: "https://api.test" },
          { fetch: fetchImpl },
          { api: "example", baseUrl: "https://api.test" },
          {
            operations: {
              item: { method: "get", path: "/item", query: [] },
            },
            responseError: (answer) => {
              const { ok, error } = answer as { ok?: boolean; error?: string };

              if (ok !== false) return undefined;

              return { code: error ?? "unknown" };
            },
          },
        );
      }
    })();

    const pending = watch(client.read("item"));

    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(take(pending)).toMatchObject({ id: "a" });
    expect(calls).toBe(2);
  });

  it("retries a 429 in the middle of a page walk", async () => {
    useWaitTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      if (calls === 1) {
        return new Response("slow", { status: 429, statusText: "Too Many Requests" });
      }

      return json({ items: [{ id: "a" }], next: null });
    }) as typeof fetch;

    const client = new Probe(
      { base_url: "https://api.test" },
      { fetch: fetchImpl },
      { api: "example", baseUrl: "https://api.test" },
      {
        operations: {
          items: { method: "get", path: "/items", query: [] },
        },
      },
    );

    const pending = watch(
      (async () => {
        const pages = [];

        for await (const page of client.walk("items", {
          rows: "items",
          next: "next",
          param: "cursor",
        })) {
          pages.push(page);
        }

        return pages;
      })(),
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(take(pending)).toEqual([{ cursor: null, data: [{ id: "a" }] }]);
    expect(calls).toBe(2);
  });

  it("throws from check on a refusal with no reason", async () => {
    useWaitTimers();
    const pending = watch(refusingClient({ ok: false, error: "rate_limited" }).check());

    await vi.advanceTimersByTimeAsync(15_000);
    expect(() => take(pending)).toThrow("example answered /items?limit=1 with rate_limited");
  });

  it("passes check and reads when the hook finds nothing", async () => {
    const client = refusingClient({ ok: true, id: "a", items: [] });

    await expect(client.check()).resolves.toEqual({ ok: true });
    await expect(client.read("item")).resolves.toMatchObject({ id: "a" });
  });
});

const passThrough = (_operationId: string, body: unknown) => body;

describe("openApiClientOptions", () => {
  const operations = { ping: { method: "get" as const, path: "/ping", query: [] } };
  const pinned = defineConnector({
    type: "stripe",
    docs: "https://docs.stripe.com/api",
    configSchema: { base_url: "string", api_version: "string" },
    secretFields: ["api_key"],
    auth: { scheme: "bearer", secret: "api_key" },
    apiVersions: ["2024-06-20"],
    defaultApiVersion: "2024-06-20",
    defaultBaseUrl: "https://api.stripe.com",
  });

  it("checks the version, then sets auth headers and any extra header", () => {
    const [defaults, connector] = openApiClientOptions(
      pinned,
      {},
      { api_key: "sk_test" },
      operations,
      { headers: (version) => ({ "stripe-version": version }) },
    );

    expect(defaults).toEqual({
      api: "stripe",
      baseUrl: "https://api.stripe.com",
      headers: { authorization: "Bearer sk_test", "stripe-version": "2024-06-20" },
    });
    expect(connector).toEqual({ operations });
  });

  it("refuses an unlisted version before a base URL function runs", () => {
    expect(() =>
      openApiClientOptions(pinned, { api_version: "nope" }, {}, operations, {
        baseUrl: () => {
          throw new Error("base url ran");
        },
      }),
    ).toThrow(/not supported/);
  });

  it("uses a base URL function's version and appends a basic suffix once", () => {
    const zendesk = defineConnector({
      type: "zendesk-support",
      docs: "https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/",
      configSchema: { email: "string" },
      secretFields: ["api_token"],
      auth: { scheme: "basic", username: "email", secret: "api_token", usernameSuffix: "/token" },
      apiVersions: ["v2"],
      defaultApiVersion: "v2",
    });
    const [defaults, connector] = openApiClientOptions(
      zendesk,
      { email: "ada@acme.example" },
      { api_token: "zd" },
      operations,
      {
        baseUrl: (version) => `https://acme.zendesk.com/api/${version}`,
        reshape: passThrough,
      },
    );
    const [again] = openApiClientOptions(
      zendesk,
      { email: "ada@acme.example/token" },
      { api_token: "zd" },
      operations,
      { baseUrl: "https://acme.zendesk.com/api/v2" },
    );

    expect(defaults).toEqual({
      api: "zendesk-support",
      baseUrl: "https://acme.zendesk.com/api/v2",
      headers: { authorization: `Basic ${btoa("ada@acme.example/token:zd")}` },
    });
    expect(again.headers?.["authorization"]).toBe(`Basic ${btoa("ada@acme.example/token:zd")}`);
    expect(connector.reshape).toBe(passThrough);
  });

  it("sends no auth header for a public API", () => {
    const frankfurter = defineConnector({
      type: "frankfurter",
      docs: "https://www.frankfurter.app/docs/",
      configSchema: { base_url: "string" },
      secretFields: [],
      auth: { scheme: "none" },
      apiVersions: ["unversioned"],
      defaultApiVersion: "unversioned",
      defaultBaseUrl: "https://api.frankfurter.dev/v1",
    });

    const [defaults, connector] = openApiClientOptions(frankfurter, {}, {}, operations, {
      headers: { accept: "application/json" },
    });

    expect(defaults).toEqual({
      api: "frankfurter",
      baseUrl: "https://api.frankfurter.dev/v1",
      headers: { accept: "application/json" },
    });
    expect(connector).toEqual({ operations });
  });
});

function json(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}
