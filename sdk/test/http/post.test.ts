import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { operationsModule } from "../../src/http/openapi.js";
import { classifyOperations, OpenApiClient } from "../../src/index.js";
import type { BodyOf, ReadArgs, RequestOf } from "../../src/index.js";
import type { components, operations as spec } from "./fixtures/ga4-openapi.js";

/**
 * Trimmed from the Analytics Data API v1beta discovery document.
 * The response fixture is the sample under "Read the response" in the
 * Data API basics guide. `batchRunReports` is a second POST, so the table
 * is every operation in the document.
 */
const ga4Spec = JSON.parse(
  readFileSync(new URL("./fixtures/ga4-run-report.openapi.json", import.meta.url), "utf8"),
) as Parameters<typeof classifyOperations>[0];

const report = JSON.parse(
  readFileSync(new URL("./fixtures/ga4-run-report.json", import.meta.url), "utf8"),
) as Report;

interface Report {
  dimensionHeaders: { name: string }[];
  metricHeaders: { name: string; type: string }[];
  rows: Row[];
  metadata: Record<string, unknown>;
  rowCount: number;
}

interface Row {
  dimensionValues: { value: string }[];
  metricValues: { value: string }[];
}

type Ga4Api = {
  responses: {
    "properties.runReport": BodyOf<spec["properties.runReport"]>;
    "properties.getMetadata": BodyOf<spec["properties.getMetadata"]>;
  };
  requests: {
    "properties.runReport": RequestOf<spec["properties.runReport"]>;
  };
};

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T probes assignability in both directions
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type OptionalPost = {
  requestBody?: { content: { "application/json": { q?: string } } };
};

const runReportBody: Eq<
  RequestOf<spec["properties.runReport"]>,
  components["schemas"]["RunReportRequest"]
> = true;
const metadataBody: Eq<RequestOf<spec["properties.getMetadata"]>, never> = true;
const optionalBody: Eq<RequestOf<OptionalPost>, { q?: string } | undefined> = true;

/** Instantiates `read` so the assertions below can compare its parameter types. */
function readSignatures(client: OpenApiClient<Ga4Api>) {
  return {
    // oxlint-disable-next-line typescript/unbound-method -- type probe, not a call
    report: client.read<"properties.runReport">,
    // oxlint-disable-next-line typescript/unbound-method -- type probe, not a call
    metadata: client.read<"properties.getMetadata">,
  };
}

const reportRequiresBody: Eq<
  Parameters<ReturnType<typeof readSignatures>["report"]>,
  [
    operationId: "properties.runReport",
    args: ReadArgs & { body: components["schemas"]["RunReportRequest"] },
  ]
> = true;
const metadataOmitsBody: Eq<
  Parameters<ReturnType<typeof readSignatures>["metadata"]>,
  [operationId: "properties.getMetadata", args?: ReadArgs | undefined]
> = true;

type Bodyless = { requestBody?: never };
type RequiredUnknown = { requestBody: { content: { "application/json": unknown } } };

const bodylessIsNever: Eq<RequestOf<Bodyless>, never> = true;
const unknownStays: Eq<RequestOf<RequiredUnknown>, unknown> = true;

type NoBodyApi = { responses: { search: { ok: true } }; requests: { search: never } };
type UnknownApi = { responses: { search: { ok: true } }; requests: { search: unknown } };

function bodySignatures(plain: OpenApiClient<NoBodyApi>, loose: OpenApiClient<UnknownApi>) {
  return {
    // oxlint-disable-next-line typescript/unbound-method -- type probe, not a call
    plain: plain.read<"search">,
    // oxlint-disable-next-line typescript/unbound-method -- type probe, not a call
    loose: loose.read<"search">,
  };
}

const bodylessOmitsBody: Eq<
  Parameters<ReturnType<typeof bodySignatures>["plain"]>,
  [operationId: "search", args?: ReadArgs | undefined]
> = true;
const unknownRequiresBody: Eq<
  Parameters<ReturnType<typeof bodySignatures>["loose"]>,
  [operationId: "search", args: ReadArgs & { body: unknown }]
> = true;

const REPORT = {
  dateRanges: [{ startDate: "2020-09-01", endDate: "2020-09-15" }],
  dimensions: [{ name: "country" }],
  metrics: [{ name: "activeUsers" }],
  limit: "1",
};

/** A string `next` writes the hook's cursor into `offset`, and omits it on the first request. */
const ga4Rule = { rows: "rows", next: "next", param: "offset" } as const;

class Reports extends OpenApiClient<Ga4Api> {
  private readonly asked: { offset: string };

  constructor(fetchImpl: typeof fetch) {
    const asked = { offset: "0" };

    super(
      { base_url: "https://analyticsdata.googleapis.com" },
      { fetch: fetchImpl },
      { api: "ga4", baseUrl: "https://analyticsdata.googleapis.com" },
      {
        operations: classifyOperations(ga4Spec),
        extract: (_operationId, body) => stopAtRowCount(body, asked),
      },
    );
    this.asked = asked;
  }

  countries(cursor?: string | null) {
    this.asked.offset = cursor ?? "0";

    return this.pages<Row>("properties.runReport", ga4Rule, {
      path: { property: "1234" },
      body: REPORT,
      cursor,
    });
  }
}

describe("POST reads", () => {
  it("records every GET and POST, and keeps the first id when one is reused", () => {
    const operations = classifyOperations(ga4Spec);

    expect(operations["properties.runReport"]).toEqual({
      method: "post",
      path: "/v1beta/properties/{property}:runReport",
      query: [],
    });
    expect(operations["properties.getMetadata"]).toEqual({
      method: "get",
      path: "/v1beta/properties/{property}/metadata",
      query: [],
    });
    expect(operations["properties.batchRunReports"]).toEqual({
      method: "post",
      path: "/v1beta/properties/{property}:batchRunReports",
      query: [],
    });
    expect(
      classifyOperations({
        paths: { "/items": { get: { operationId: "list" }, post: { operationId: "list" } } },
      }),
    ).toEqual({
      list: { method: "get", path: "/items", query: [] },
      "post list": { method: "post", path: "/items", query: [] },
    });
  });

  it("types a POST body in the generated module and leaves a GET module unchanged", () => {
    expect([
      runReportBody,
      metadataBody,
      optionalBody,
      reportRequiresBody,
      metadataOmitsBody,
      bodylessIsNever,
      unknownStays,
      bodylessOmitsBody,
      unknownRequiresBody,
    ]).toEqual([true, true, true, true, true, true, true, true, true]);

    const generated = operationsModule(classifyOperations(ga4Spec));

    expect(generated).toContain('"properties.runReport": RequestOf<spec["properties.runReport"]>;');
    expect(generated).toContain(
      '"properties.batchRunReports": RequestOf<spec["properties.batchRunReports"]>;',
    );
    expect(generated).toContain("BodyOf, Operation, RequestOf");

    const gets = operationsModule({
      list: { method: "get", path: "/items", query: ["limit"] },
    });

    expect(gets).toContain("import type { BodyOf, Operation } from");
    expect(gets).not.toContain("requests:");
  });

  it("posts the report body and lets extract stop at rowCount", async () => {
    const calls: ReturnType<typeof record>[] = [];
    const client = reports((call) => {
      calls.push(call);
      return pageAt(offsetOf(call.body));
    });

    const seen: { cursor: string | number | null; country: string | undefined }[] = [];

    for await (const page of client.countries()) {
      seen.push({ cursor: page.cursor, country: page.data[0]?.dimensionValues[0]?.value });
    }

    expect(seen).toEqual([
      { cursor: "1", country: "Japan" },
      { cursor: null, country: "France" },
    ]);
    expect(calls.map((call) => call.body)).toEqual([REPORT, { ...REPORT, offset: "1" }]);
    expect(calls[0]).toMatchObject({
      url: "https://analyticsdata.googleapis.com/v1beta/properties/1234:runReport",
      method: "POST",
      type: "application/json",
    });
    expect(calls.every((call) => !call.url.includes("?"))).toBe(true);
  });

  it("reads the sample report, and does not ask for a page past rowCount", async () => {
    const calls: ReturnType<typeof record>[] = [];
    const client = reports((call) => {
      calls.push(call);
      return report;
    });

    await expect(
      client.read("properties.runReport", { path: { property: "1234" }, body: REPORT }),
    ).resolves.toEqual(report);
    expect(calls[0]).toEqual({
      url: "https://analyticsdata.googleapis.com/v1beta/properties/1234:runReport",
      method: "POST",
      type: "application/json",
      body: REPORT,
    });

    const cursors = [];

    for await (const page of client.countries()) cursors.push(page.cursor);

    expect(cursors).toEqual([null]);
    expect(calls).toHaveLength(2);
  });

  it("makes one request when the report is empty", async () => {
    const calls: ReturnType<typeof record>[] = [];
    const client = reports((call) => {
      calls.push(call);
      return { ...report, rows: [], rowCount: 0 };
    });

    const pages = [];

    for await (const page of client.countries()) pages.push(page);

    expect(pages).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("resumes from an offset", async () => {
    const calls: ReturnType<typeof record>[] = [];
    const client = reports((call) => {
      calls.push(call);
      return pageAt(offsetOf(call.body));
    });

    const countries: string[] = [];

    for await (const page of client.countries("1")) {
      const country = page.data[0]?.dimensionValues[0]?.value;

      if (country) countries.push(country);
    }

    expect(countries).toEqual(["France"]);
    expect(calls.map((call) => call.body)).toEqual([{ ...REPORT, offset: "1" }]);
  });

  it("does not send a body for a GET in the same spec", async () => {
    const calls: ReturnType<typeof record>[] = [];
    const client = reports((call) => {
      calls.push(call);
      return { name: "properties/1234/metadata" };
    });

    await expect(
      client.read("properties.getMetadata", { path: { property: "1234" } }),
    ).resolves.toEqual({
      name: "properties/1234/metadata",
    });
    expect(calls).toEqual([
      {
        url: "https://analyticsdata.googleapis.com/v1beta/properties/1234/metadata",
        method: "GET",
        type: null,
        body: undefined,
      },
    ]);
  });

  it("sends a page token in the JSON body", async () => {
    const calls: unknown[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const call = record(input, init);
      calls.push(call.body);

      const token =
        call.body && typeof call.body === "object" && "pageToken" in call.body
          ? call.body.pageToken
          : undefined;

      return json(
        token === "tok"
          ? { results: [{ id: "2" }] }
          : { results: [{ id: "1" }], nextPageToken: "tok" },
      );
    }) as typeof fetch;

    const client = new (class extends OpenApiClient<AdsApi> {
      search(cursor?: string | null) {
        return this.pages<{ id?: string }>(
          "customers.googleAds.search",
          { rows: "results", next: "nextPageToken", param: "pageToken" },
          {
            path: { customerId: "7" },
            body: { query: "SELECT campaign.id FROM campaign" },
            cursor,
          },
        );
      }
    })(
      { base_url: "https://googleads.googleapis.com" },
      { fetch: fetchImpl },
      { api: "google-ads", baseUrl: "https://googleads.googleapis.com" },
      { operations: classifyOperations(adsSpec) },
    );

    const seen: { cursor: string | number | null; ids: (string | undefined)[] }[] = [];

    for await (const page of client.search()) {
      seen.push({ cursor: page.cursor, ids: page.data.map((row) => row.id) });
    }

    expect(seen).toEqual([
      { cursor: "tok", ids: ["1"] },
      { cursor: null, ids: ["2"] },
    ]);
    expect(calls).toEqual([
      { query: "SELECT campaign.id FROM campaign" },
      { query: "SELECT campaign.id FROM campaign", pageToken: "tok" },
    ]);

    calls.length = 0;
    const resumed: (string | number | null)[] = [];

    for await (const page of client.search("tok")) resumed.push(page.cursor);

    expect(resumed).toEqual([null]);
    expect(calls).toEqual([{ query: "SELECT campaign.id FROM campaign", pageToken: "tok" }]);
  });
});

const adsSpec = {
  paths: {
    "/v22/customers/{customerId}/googleAds:search": {
      post: {
        operationId: "customers.googleAds.search",
        parameters: [{ name: "customerId", in: "path", required: true }],
      },
    },
  },
};

type AdsApi = {
  responses: {
    "customers.googleAds.search": { results?: { id?: string }[]; nextPageToken?: string };
  };
  requests: {
    "customers.googleAds.search": { query: string; pageToken?: string };
  };
};

function offsetOf(body: unknown): string {
  if (!body || typeof body !== "object" || !("offset" in body)) return "0";

  return typeof body.offset === "string" ? body.offset : "0";
}

function pageAt(offset: string): Report {
  const row = report.rows[Number(offset)];

  return { ...report, rows: row ? [row] : [], rowCount: report.rowCount };
}

/** The offset the client asked for, plus this page's rows, against `rowCount`. */
function stopAtRowCount(body: unknown, asked: { offset: string }) {
  const page = body as Report;
  const advance = Number(asked.offset) + page.rows.length;

  asked.offset = String(advance);

  return { data: page.rows, next: advance < page.rowCount ? String(advance) : null };
}

function reports(answer: (call: ReturnType<typeof record>) => unknown): Reports {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    json(answer(record(input, init)))) as typeof fetch;

  return new Reports(fetchImpl);
}

function record(input: string | URL | Request, init?: RequestInit) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  return {
    url,
    method: init?.method ?? "GET",
    type: new Headers(init?.headers).get("content-type"),
    body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
