import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { isTerminal } from "@puppi/sdk";
import { describe, expect, it } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const { defaultBaseUrl } = connector.default;

const person = JSON.parse(
  readFileSync(new URL("./fixtures/person.json", import.meta.url), "utf8"),
) as { id: number; uuid: string };

const insight = JSON.parse(
  readFileSync(new URL("./fixtures/insight.json", import.meta.url), "utf8"),
) as { id: number; short_id: string };

const queryRows = JSON.parse(
  readFileSync(new URL("./fixtures/query-rows.json", import.meta.url), "utf8"),
) as unknown;

const queryNoRows = JSON.parse(
  readFileSync(new URL("./fixtures/query-no-rows.json", import.meta.url), "utf8"),
) as unknown;

const queryEmpty = JSON.parse(
  readFileSync(new URL("./fixtures/query-empty.json", import.meta.url), "utf8"),
) as unknown;

const queryMismatch = JSON.parse(
  readFileSync(new URL("./fixtures/query-mismatch.json", import.meta.url), "utf8"),
) as unknown;

const queryStatus = JSON.parse(
  readFileSync(new URL("./fixtures/query-status.json", import.meta.url), "utf8"),
) as unknown;

const HOST = "https://us.posthog.test";
const PROJECT = "42";
const KEY = "phx_test";
const SQL =
  "SELECT toDate(timestamp) AS day, count() AS events FROM events GROUP BY day ORDER BY day";

const PERSONS = `${HOST}/api/projects/${PROJECT}/persons/`;
const PERSONS_NEXT = `${HOST}/api/projects/${PROJECT}/persons/?cursor=cD0y`;
const INSIGHTS = `${HOST}/api/projects/${PROJECT}/insights/`;
const INSIGHTS_NEXT = `${HOST}/api/projects/${PROJECT}/insights/?limit=1&offset=1`;
const QUERY = `${HOST}/api/projects/${PROJECT}/query/`;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function page(rows: unknown[], next: string | null) {
  return { count: rows.length, next, previous: null, results: rows };
}

function fake(
  reply: (call: Call) => { status?: number; body?: unknown },
  config: Record<string, unknown> = { base_url: HOST, project_id: PROJECT },
) {
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

  const client = new Client(config, { api_key: KEY }, { fetch: fetchImpl });

  return { calls, client };
}

async function collect<T>(pages: AsyncIterable<{ cursor: string | number | null; data: T[] }>) {
  const seen: { cursor: string | number | null; data: T[] }[] = [];

  for await (const item of pages) seen.push({ cursor: item.cursor, data: item.data });

  return seen;
}

describe("posthog connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: HOST, project_id: PROJECT },
      }),
    );
  });

  it("requires project_id", () => {
    expect(() => new Client({ base_url: HOST }, { api_key: KEY })).toThrow(/project_id/);
  });

  it("uses the default host when base_url is omitted", async () => {
    const { calls, client } = fake(() => ({ body: { uuid: "user-1" } }), { project_id: PROJECT });

    await client.check();

    expect(calls[0]?.url).toBe(`${defaultBaseUrl}/api/users/@me/`);
  });

  it("walks person pages by the next URL", async () => {
    const second = { ...person, id: 2, uuid: "11111111-1111-4111-8111-111111111111" };
    const { calls, client } = fake((call) => {
      if (call.url === PERSONS) return { body: page([person], PERSONS_NEXT) };
      if (call.url === PERSONS_NEXT) return { body: page([second], null) };

      return { status: 404, body: { detail: call.url } };
    });

    const seen = await collect(client.persons());

    expect(seen).toEqual([
      { cursor: PERSONS_NEXT, data: [expect.objectContaining({ id: 1, uuid: person.uuid })] },
      { cursor: null, data: [expect.objectContaining({ id: 2 })] },
    ]);
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", PERSONS],
      ["GET", PERSONS_NEXT],
    ]);
    expect(calls[0]?.url).not.toContain("limit=");
    expect(calls[0]?.url).not.toContain("offset=");
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(calls[1]?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(calls[1]?.url).not.toContain(KEY);
  });

  it("sends limit only when the caller passed it", async () => {
    const { calls, client } = fake(() => ({ body: page([person], null) }));

    await collect(client.persons({ limit: 50 }));

    expect(calls.map((call) => call.url)).toEqual([`${PERSONS}?limit=50`]);
  });

  it("resumes persons from the next URL", async () => {
    const { calls, client } = fake(() => ({ body: page([person], null) }));
    const seen = await collect(client.persons({ cursor: PERSONS_NEXT }));

    expect(seen).toEqual([{ cursor: null, data: [expect.objectContaining({ id: 1 })] }]);
    expect(calls.map((call) => call.url)).toEqual([PERSONS_NEXT]);
  });

  it("walks insight pages by the next URL", async () => {
    const second = { ...insight, id: 11, short_id: "def456" };
    const { calls, client } = fake((call) => {
      if (call.url === INSIGHTS) return { body: page([insight], INSIGHTS_NEXT) };
      if (call.url === INSIGHTS_NEXT) return { body: page([second], null) };

      return { status: 404, body: { detail: call.url } };
    });

    const seen = await collect(client.insights());

    expect(
      seen.map((item) => ({ cursor: item.cursor, ids: item.data.map((row) => row.id) })),
    ).toEqual([
      { cursor: INSIGHTS_NEXT, ids: [10] },
      { cursor: null, ids: [11] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([INSIGHTS, INSIGHTS_NEXT]);
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.url).not.toContain("refresh=");
  });

  it("returns HogQL rows keyed by columns", async () => {
    const { calls, client } = fake(() => ({ body: queryRows }));
    const rows = await client.query({ query: SQL });

    expect(rows).toEqual([
      { day: "2026-11-10", events: 4 },
      { day: "2026-11-11", events: 9 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(QUERY);
    expect(calls[0]?.body).toEqual({ query: { kind: "HogQLQuery", query: SQL } });
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(calls[0]?.body)).not.toContain(KEY);
    expect(calls[0]?.url).not.toContain(KEY);
  });

  it("returns no rows when results is empty", async () => {
    const { calls, client } = fake(() => ({ body: queryNoRows }));

    await expect(client.query({ query: SQL })).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("throws when a HogQL response has no columns", async () => {
    const { client } = fake(() => ({ body: queryEmpty }));
    const error = await client.query({ query: SQL }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/no columns/);
    expect(isTerminal(error)).toBe(true);
  });

  it("throws when a HogQL row length does not match columns", async () => {
    const { client } = fake(() => ({ body: queryMismatch }));
    const error = await client.query({ query: SQL }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/does not match columns/);
    expect(isTerminal(error)).toBe(true);
  });

  it("throws when a HogQL response has no results array", async () => {
    const { client } = fake(() => ({ body: queryStatus }));
    const error = await client.query({ query: SQL }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/no results/);
    expect(isTerminal(error)).toBe(true);
  });
});
