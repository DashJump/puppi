import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { describe, expect, it } from "vitest";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const { defaultApiVersion } = connector.default;

const HOST = "https://connect.square.test";
const TOKEN = "sq0atp-test-token";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

const locations = fixture("locations");
const paymentsPage1 = fixture("payments-page-1");
const paymentsPage2 = fixture("payments-page-2");
const customersPage1 = fixture("customers-page-1");
const customersPage2 = fixture("customers-page-2");
const customersEmpty = fixture("customers-empty");
const ordersPage1 = fixture("orders-page-1");
const ordersPage2 = fixture("orders-page-2");
const refundsPage1 = fixture("refunds-page-1");
const refundsPage2 = fixture("refunds-page-2");

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fake(
  routes: Record<string, unknown>,
  config: Record<string, unknown> = { base_url: HOST },
) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = init?.body;
    const call = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined,
    };

    calls.push(call);

    const path = `${new URL(url).pathname}${new URL(url).search}`;
    const route = routes[path];

    if (route === undefined) return new Response("missing", { status: 404 });

    const body = typeof route === "function" ? (route as () => unknown)() : route;

    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  const client = new Client(config, { access_token: TOKEN }, { fetch: fetchImpl });

  return { calls, client };
}

function expectAuthorized(calls: Call[]) {
  for (const call of calls) {
    expect(call.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(call.headers["Square-Version"]).toBe(defaultApiVersion);
    expect(call.url).not.toContain(TOKEN);
    expect(JSON.stringify(call.body ?? "")).not.toContain(TOKEN);
  }
}

async function collect(
  pages: AsyncIterable<{ cursor: string | number | null; data: { id?: string }[] }>,
) {
  const seen: { cursor: string | number | null; ids: (string | undefined)[] }[] = [];

  for await (const page of pages) {
    seen.push({ cursor: page.cursor, ids: page.data.map((row) => row.id) });
  }

  return seen;
}

describe("square connector", () => {
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

  it("reads locations, including a body with no locations array", async () => {
    const { calls, client } = fake({ "/v2/locations": locations });
    const rows = await client.locations();

    expect(rows).toEqual([
      {
        id: "L1",
        name: "Main",
        status: "ACTIVE",
        currency: "USD",
        merchant_id: "M1",
        created_at: "2025-01-01T00:00:00Z",
      },
    ]);
    expectAuthorized(calls);

    const empty = fake({ "/v2/locations": {} });

    expect(await empty.client.locations()).toEqual([]);
  });

  it("walks payment pages and resumes from the cursor", async () => {
    const { calls, client } = fake({
      "/v2/payments": paymentsPage1,
      "/v2/payments?cursor=pay-cursor-2": paymentsPage2,
    });

    expect(await collect(client.payments())).toEqual([
      { cursor: "pay-cursor-2", ids: ["pay_1"] },
      { cursor: null, ids: ["pay_2"] },
    ]);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", `${HOST}/v2/payments`],
      ["GET", `${HOST}/v2/payments?cursor=pay-cursor-2`],
    ]);
    expectAuthorized(calls);

    const resumed = fake({ "/v2/payments?cursor=pay-cursor-2": paymentsPage2 });

    expect(await collect(resumed.client.payments({ cursor: "pay-cursor-2" }))).toEqual([
      { cursor: null, ids: ["pay_2"] },
    ]);
    expect(resumed.calls[0]?.url).toBe(`${HOST}/v2/payments?cursor=pay-cursor-2`);
  });

  it("sends payment filters and limit only when the caller passed them", async () => {
    const first = "/v2/payments?begin_time=2024-01-01T00%3A00%3A00Z&location_id=L1&limit=2";
    const second = `${first}&cursor=pay-cursor-2`;
    const { calls, client } = fake({
      [first]: paymentsPage1,
      [second]: paymentsPage2,
    });

    await collect(
      client.payments({
        limit: 2,
        query: { begin_time: "2024-01-01T00:00:00Z", location_id: "L1" },
      }),
    );

    expect(calls.map((call) => call.url)).toEqual([`${HOST}${first}`, `${HOST}${second}`]);
  });

  it("walks customer pages and treats {} as no rows", async () => {
    const { calls, client } = fake({
      "/v2/customers": customersPage1,
      "/v2/customers?cursor=cust-cursor-2": customersPage2,
    });

    expect(await collect(client.customers())).toEqual([
      { cursor: "cust-cursor-2", ids: ["cust_1"] },
      { cursor: null, ids: ["cust_2"] },
    ]);
    expect(calls[0]?.method).toBe("GET");
    expectAuthorized(calls);

    const empty = fake({ "/v2/customers": customersEmpty });

    expect(await collect(empty.client.customers())).toEqual([]);
    expect(empty.calls).toHaveLength(1);
  });

  it("walks order search and sends the cursor in the body", async () => {
    const query = { filter: { state_filter: { states: ["COMPLETED"] as ["COMPLETED"] } } };
    const orderPages = [ordersPage1, ordersPage2];
    const { calls, client } = fake({
      "/v2/orders/search": () => orderPages.shift(),
    });

    const seen = await collect(client.orders({ locationIds: ["L1", "L2"], query, limit: 2 }));

    expect(seen).toEqual([
      { cursor: "order-cursor-2", ids: ["order_1"] },
      { cursor: null, ids: ["order_2"] },
    ]);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(calls[0]?.body).toEqual({
      location_ids: ["L1", "L2"],
      query,
      limit: 2,
    });
    expect(calls[1]?.body).toEqual({
      location_ids: ["L1", "L2"],
      query,
      limit: 2,
      cursor: "order-cursor-2",
    });
    expect(JSON.stringify(calls[0]?.body)).not.toContain("return_entries");
    expectAuthorized(calls);

    const resumed = fake({ "/v2/orders/search": ordersPage2 });

    expect(
      await collect(resumed.client.orders({ locationIds: ["L1"], cursor: "order-cursor-2" })),
    ).toEqual([{ cursor: null, ids: ["order_2"] }]);
    expect(resumed.calls[0]?.body).toEqual({
      location_ids: ["L1"],
      cursor: "order-cursor-2",
    });
  });

  it("walks refund pages", async () => {
    const { calls, client } = fake({
      "/v2/refunds": refundsPage1,
      "/v2/refunds?cursor=refund-cursor-2": refundsPage2,
    });

    expect(await collect(client.refunds())).toEqual([
      { cursor: "refund-cursor-2", ids: ["refund_1"] },
      { cursor: null, ids: ["refund_2"] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      `${HOST}/v2/refunds`,
      `${HOST}/v2/refunds?cursor=refund-cursor-2`,
    ]);
    expectAuthorized(calls);
  });

  it("uses the sandbox host when base_url is set", async () => {
    const sandbox = "https://connect.squareupsandbox.com";
    const { calls, client } = fake({ "/v2/locations": locations }, { base_url: sandbox });

    await client.locations();

    expect(calls[0]?.url).toBe(`${sandbox}/v2/locations`);
    expect(calls[0]?.headers["Square-Version"]).toBe(defaultApiVersion);
  });
});
