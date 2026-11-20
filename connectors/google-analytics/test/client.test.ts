import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { describe, expect, it } from "vitest";

import * as connector from "../src/index.js";
import { operations } from "../src/operations.js";

const config = { base_url: "https://analyticsdata.googleapis.test", property_id: "1234" };
const token = "ya29.test";

const reportBody = {
  dateRanges: [{ startDate: "2020-09-01", endDate: "2020-09-15" }],
  dimensions: [{ name: "country" }],
  metrics: [{ name: "activeUsers" }],
  limit: "1",
};

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function scripted(respond: (call: Call) => unknown) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };

    calls.push(call);

    return new Response(JSON.stringify(respond(call)), { status: 200 });
  }) as typeof fetch;

  const client = new connector.Client(config, { access_token: token }, { fetch: fetchImpl });

  return { calls, client };
}

function fake(payload: unknown) {
  return scripted(() => payload);
}

async function collect(
  pages: AsyncIterable<{ cursor: string | null; data: connector.ReportRow[] }>,
) {
  const seen: { cursor: string | null; rows: connector.ReportRow[] }[] = [];

  for await (const page of pages) seen.push({ cursor: page.cursor, rows: page.data });

  return seen;
}

describe("google analytics connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config,
      }),
    );
  });

  it("proves the token with getMetadata", async () => {
    const { calls, client } = fake(fixture("metadata"));

    expect(await client.check()).toEqual({ ok: true });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://analyticsdata.googleapis.test/v1beta/properties/1234/metadata",
    );
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${token}`);
    expect(calls[0]?.url).not.toContain(token);
    expect(operations["properties.getMetadata"]?.path).toBe("/properties/{property}/metadata");
  });

  it("requires property_id", () => {
    expect(
      () => new connector.Client({ base_url: "https://analyticsdata.googleapis.test" }),
    ).toThrow("google-analytics requires property_id");
  });

  it("returns metadata for the property", async () => {
    const metadata = fixture("metadata");
    const { calls, client } = fake(metadata);

    expect(await client.getMetadata()).toEqual(metadata);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe(
      "https://analyticsdata.googleapis.test/v1beta/properties/1234/metadata",
    );
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${token}`);
    expect(calls[0]?.url).not.toContain(token);
    expect(calls[0]?.body).toBeUndefined();
  });

  it("returns report rows keyed by dimension and metric names", async () => {
    const { calls, client } = fake(fixture("report"));
    const body = {
      dateRanges: [{ startDate: "2020-09-01", endDate: "2020-09-15" }],
      dimensions: [{ name: "country" }, { name: "city" }],
      metrics: [{ name: "activeUsers" }],
    };

    expect(await collect(client.runReport({ body }))).toEqual([
      {
        cursor: null,
        rows: [
          { country: "Japan", city: "Tokyo", activeUsers: "2541" },
          { country: "France", city: null, activeUsers: "12" },
        ],
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      "https://analyticsdata.googleapis.test/v1beta/properties/1234:runReport",
    );
    expect(calls[0]?.headers["authorization"]).toBe(`Bearer ${token}`);
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.url).not.toContain(token);
    expect(calls[0]?.body).toEqual(body);
  });

  it("pages with offset until rowCount and resumes from the cursor", async () => {
    const { calls, client } = scripted((call) => {
      const offset =
        call.body && typeof call.body === "object" && "offset" in call.body
          ? call.body.offset
          : undefined;

      return fixture(offset === "1" ? "report-page-2" : "report-page-1");
    });

    expect(await collect(client.runReport({ body: reportBody }))).toEqual([
      { cursor: "1", rows: [{ country: "Japan", activeUsers: "2541" }] },
      { cursor: null, rows: [{ country: "France", activeUsers: "12" }] },
    ]);
    expect(calls.map((call) => call.body)).toEqual([reportBody, { ...reportBody, offset: "1" }]);
    expect(calls.every((call) => call.method === "POST")).toBe(true);
    expect(calls.every((call) => call.headers["authorization"] === `Bearer ${token}`)).toBe(true);
    expect(calls.every((call) => !call.url.includes(token))).toBe(true);

    const resumed = scripted((call) => {
      const offset =
        call.body && typeof call.body === "object" && "offset" in call.body
          ? call.body.offset
          : undefined;

      return fixture(offset === "1" ? "report-page-2" : "report-page-1");
    });

    expect(await collect(resumed.client.runReport({ body: reportBody, cursor: "1" }))).toEqual([
      { cursor: null, rows: [{ country: "France", activeUsers: "12" }] },
    ]);
    expect(resumed.calls.map((call) => call.body)).toEqual([{ ...reportBody, offset: "1" }]);
  });

  it("makes one request when the report is empty", async () => {
    const { calls, client } = fake(fixture("report-empty"));

    expect(await collect(client.runReport({ body: reportBody }))).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("rejects an offset that is not a row index", async () => {
    const { calls, client } = fake(fixture("report-page-2"));

    await expect(collect(client.runReport({ body: reportBody, cursor: "next" }))).rejects.toThrow(
      'google-analytics offset "next" is not a row index',
    );
    expect(calls).toHaveLength(0);
  });
});
