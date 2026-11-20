import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vitest";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const HOST = "https://pipedrive.test";
const TOKEN = "pd-test-token";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  paths: Record<
    string,
    {
      get: {
        responses: Record<string, { content: { "application/json": { schema: object } } }>;
      };
    }
  >;
};

interface Row {
  id?: number;
}

function page(path: string, id: number, next: string | null) {
  const schema = spec.paths[path]!.get.responses["200"]!.content["application/json"].schema;
  const sampled = sample(schema, { enablePatterns: true }, spec) as { data?: Row[] };

  return {
    ...sampled,
    data: [{ ...sampled.data?.[0], id }],
    additional_data: { next_cursor: next },
  };
}

interface Call {
  url: string;
  headers: Headers;
}

function fake(config: Record<string, unknown>, reply: (url: URL) => unknown) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));

    calls.push({ url: url.href, headers: new Headers(init?.headers) });

    return new Response(JSON.stringify(reply(url)), { status: 200 });
  }) as typeof fetch;

  const client = new Client(config, { api_token: TOKEN }, { fetch: fetchImpl });

  return { calls, client };
}

const LISTS = [
  ["deals", "/deals"],
  ["persons", "/persons"],
  ["organizations", "/organizations"],
  ["activities", "/activities"],
  ["pipelines", "/pipelines"],
  ["stages", "/stages"],
] as const;

describe("pipedrive connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: HOST, company_domain: "acme" },
      }),
    );
  });

  it("builds the company host and lets base_url replace it", async () => {
    const company = fake({ company_domain: "acme" }, () => page("/deals", 1, null));
    const pages = [];

    for await (const item of company.client.deals()) pages.push(item);

    expect(pages).toHaveLength(1);
    expect(company.calls[0]?.url).toBe("https://acme.pipedrive.com/api/v2/deals");
    expect(company.calls[0]?.headers.get("x-api-token")).toBe(TOKEN);

    const replaced = fake({ base_url: HOST, company_domain: "acme" }, () =>
      page("/deals", 1, null),
    );

    for await (const item of replaced.client.deals()) void item;

    expect(replaced.calls[0]?.url).toBe(`${HOST}/api/v2/deals`);
    expect(() => new Client({})).toThrow("pipedrive requires company_domain");
  });

  it("rejects a company_domain that is not one DNS label before any request", () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;

      return Promise.resolve(new Response("{}"));
    }) as typeof fetch;

    for (const company_domain of ["evil.example/x?", "evil.example#"]) {
      expect(
        () => new Client({ company_domain }, { api_token: TOKEN }, { fetch: fetchImpl }),
      ).toThrow(`pipedrive company_domain ${JSON.stringify(company_domain)} is not a DNS label`);
    }

    expect(
      () =>
        new Client(
          { base_url: HOST, company_domain: "evil.example#" },
          { api_token: TOKEN },
          { fetch: fetchImpl },
        ),
    ).not.toThrow();
    expect(calls).toBe(0);
  });

  it("pages each list across two pages and resumes from the cursor", async () => {
    for (const [method, path] of LISTS) {
      const { calls, client } = fake({ base_url: HOST }, (url) =>
        page(
          path,
          url.searchParams.get("cursor") === "page-2" ? 2 : 1,
          url.searchParams.has("cursor") ? null : "page-2",
        ),
      );
      const seen: { cursor: string | number | null; ids: (number | undefined)[] }[] = [];

      for await (const item of client[method]()) {
        seen.push({ cursor: item.cursor, ids: item.data.map((row) => row.id) });
      }

      expect(seen).toEqual([
        { cursor: "page-2", ids: [1] },
        { cursor: null, ids: [2] },
      ]);
      expect(calls.map((call) => call.url)).toEqual([
        `${HOST}/api/v2${path}`,
        `${HOST}/api/v2${path}?cursor=page-2`,
      ]);
      expect(calls.every((call) => call.headers.get("x-api-token") === TOKEN)).toBe(true);
      expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true);
      expect(calls.every((call) => new URL(call.url).searchParams.get("limit") === null)).toBe(
        true,
      );
    }

    const resumed = fake({ base_url: HOST }, () => page("/deals", 2, null));
    const seen = [];

    for await (const item of resumed.client.deals({ cursor: "page-2", limit: 25 })) {
      seen.push({ cursor: item.cursor, ids: item.data.map((row) => row.id) });
    }

    expect(seen).toEqual([{ cursor: null, ids: [2] }]);
    expect(resumed.calls).toHaveLength(1);
    expect(resumed.calls[0]?.url).toBe(`${HOST}/api/v2/deals?limit=25&cursor=page-2`);
    expect(resumed.calls[0]?.headers.get("x-api-token")).toBe(TOKEN);
  });
});
