import { describe, expect, it } from "vitest";

import { Client } from "../src/index.js";

function fake(handler: (url: URL, init: RequestInit) => unknown) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const body = handler(url, init ?? {});

    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  return { calls, fetchImpl };
}

describe("the generic http client", () => {
  it("has nothing to check, so check succeeds without a request", async () => {
    const { calls, fetchImpl } = fake(() => []);
    const client = new Client({ base_url: "https://api.test" }, {}, { fetch: fetchImpl });

    expect(await client.check()).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });

  it("sends a bearer token from the secrets and query params from the call", async () => {
    const { calls, fetchImpl } = fake(() => []);
    const client = new Client(
      { base_url: "https://api.test/v1/", headers: { "x-tenant": "t1" } },
      { bearer_token: "s3cret" },
      { fetch: fetchImpl },
    );

    await client.get("/things", { limit: 5, q: undefined });

    expect(calls[0]?.url.href).toBe("https://api.test/v1/things?limit=5");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer s3cret");
    expect(calls[0]?.headers["x-tenant"]).toBe("t1");
  });

  it("sends an api key as a header by default, or as a query parameter when asked", async () => {
    const header = fake(() => []);
    await new Client(
      { base_url: "https://a.test" },
      { api_key: "k" },
      { fetch: header.fetchImpl },
    ).get("/x");
    expect(header.calls[0]?.headers["x-api-key"]).toBe("k");

    const param = fake(() => []);
    await new Client(
      { base_url: "https://a.test", api_key_query: "api_key" },
      { api_key: "k" },
      { fetch: param.fetchImpl },
    ).get("/x");
    expect(param.calls[0]?.url.search).toBe("?api_key=k");
    expect(param.calls[0]?.headers["x-api-key"]).toBeUndefined();

    const empty = fake(() => []);
    await new Client(
      { base_url: "https://a.test", api_key_query: "api_key" },
      { api_key: "" },
      { fetch: empty.fetchImpl },
    ).get("/x", { limit: 5 });
    expect(empty.calls[0]?.url.search).toBe("?limit=5");
  });
});
