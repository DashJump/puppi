import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { isTerminal } from "@puppi/sdk";
import { describe, expect, it } from "vitest";

import * as connector from "../src/index.js";
import { Client, SearchCapError } from "../src/index.js";
import { operations } from "../src/operations.js";

const { auth, defaultApiVersion } = connector.default;

const HOST = "https://api.apollo.test/api/v1";
const KEY = "test-key";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function fake(reply: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const call = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof raw === "string" ? (JSON.parse(raw) as unknown) : undefined,
    };

    calls.push(call);

    const result = reply(call);

    return new Response(result.body === undefined ? "" : JSON.stringify(result.body), {
      status: result.status ?? 200,
    });
  }) as typeof fetch;

  const client = new Client({ base_url: HOST }, { api_key: KEY }, { fetch: fetchImpl });

  return { calls, client };
}

function pageOf(url: string): string | null {
  return new URL(url).searchParams.get("page");
}

async function collect(pages: AsyncIterable<{ cursor: number | null; data: { id?: string }[] }>) {
  const seen: { cursor: number | null; ids: (string | undefined)[] }[] = [];

  for await (const item of pages) {
    seen.push({ cursor: item.cursor, ids: item.data.map((row) => row.id) });
  }

  return seen;
}

describe("apollo connector", () => {
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

  it("proves the key with GET /users/api_profile and the x-api-key header", async () => {
    const { calls, client } = fake(() => ({ body: { id: "user-1" } }));

    expect(await client.check()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/users/api_profile");
    expect(calls[0]?.headers.get("x-api-key")).toBe(KEY);
    expect(calls[0]?.url).not.toContain(KEY);
    expect(auth).toEqual({ scheme: "api_key_header", header: "x-api-key", secret: "api_key" });
    expect(defaultApiVersion).toBe("unversioned");
  });

  it("enriches one person with POST /people/match", async () => {
    const { calls, client } = fake(() => ({ body: fixture("person") }));

    const body = await client.enrichPerson({ query: { email: "ada@example.com" } });

    expect(body.person?.id).toBe("672c91d4a7be42000184f2c9");
    expect(body.person?.name).toBe("Ada Lovelace");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("x-api-key")).toBe(KEY);
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.url).not.toContain(KEY);

    const url = new URL(calls[0]?.url ?? "");

    expect(url.pathname).toBe("/api/v1/people/match");
    expect(url.searchParams.get("email")).toBe("ada@example.com");
  });

  it("enriches a batch of people from the details body", async () => {
    const { calls, client } = fake(() => ({ body: fixture("people-bulk") }));
    const details = [{ email: "ada@example.com" }, { email: "grace@example.com" }];

    const body = await client.enrichPeople({
      body: { details },
      query: { reveal_personal_emails: false },
    });

    expect(body.matches?.map((match) => match.id)).toEqual(["p1", "p2"]);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("x-api-key")).toBe(KEY);
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.body).toEqual({ details });

    const url = new URL(calls[0]?.url ?? "");

    expect(url.pathname).toBe("/api/v1/people/bulk_match");
    expect(url.searchParams.get("reveal_personal_emails")).toBe("false");
  });

  it("enriches one organization with GET /organizations/enrich", async () => {
    const { calls, client } = fake(() => ({ body: fixture("organization") }));

    const body = await client.enrichOrganization({ query: { domain: "apollo.io" } });

    expect(body.organization?.id).toBe("5e66b6381e05b4008c8331b8");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.get("x-api-key")).toBe(KEY);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/organizations/enrich");
    expect(new URL(calls[0]?.url ?? "").searchParams.get("domain")).toBe("apollo.io");
  });

  it("enriches organizations from details or from domains[]", async () => {
    const details = fake(() => ({ body: fixture("organizations-bulk") }));
    const body = { details: [{ domain: "apollo.io" }, { domain: "example.com" }] };

    const enriched = await details.client.enrichOrganizations({ body });

    expect(enriched.organizations?.map((organization) => organization.id)).toEqual(["o1", "o2"]);
    expect(details.calls[0]?.method).toBe("POST");
    expect(details.calls[0]?.body).toEqual(body);
    expect(new URL(details.calls[0]?.url ?? "").pathname).toBe("/api/v1/organizations/bulk_enrich");
    expect(new URL(details.calls[0]?.url ?? "").search).toBe("");

    const domains = fake(() => ({ body: fixture("organizations-bulk") }));

    await domains.client.enrichOrganizations({ domains: ["apollo.io", "example.com"] });

    expect(domains.calls[0]?.method).toBe("POST");
    expect(domains.calls[0]?.body).toBeUndefined();
    expect(new URL(domains.calls[0]?.url ?? "").searchParams.getAll("domains[]")).toEqual([
      "apollo.io",
      "example.com",
    ]);
  });

  it("pages people search on the query string and resumes from the cursor", async () => {
    const { calls, client } = fake((call) => ({
      body: fixture(pageOf(call.url) === "2" ? "people-page-2" : "people-page-1"),
    }));

    const seen = await collect(
      client.searchPeople({
        query: { "person_titles[]": ["founder"] },
        perPage: 1,
      }),
    );

    expect(seen).toEqual([
      { cursor: 2, ids: ["p1"] },
      { cursor: null, ids: ["p2"] },
    ]);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(calls.every((call) => call.body === undefined)).toBe(true);
    expect(calls.every((call) => call.headers.get("x-api-key") === KEY)).toBe(true);

    const first = new URL(calls[0]?.url ?? "");
    const second = new URL(calls[1]?.url ?? "");

    expect(first.pathname).toBe("/api/v1/mixed_people/api_search");
    expect(first.searchParams.get("page")).toBe("1");
    expect(first.searchParams.get("per_page")).toBe("1");
    expect(first.searchParams.getAll("person_titles[]")).toEqual(["founder"]);
    expect(second.searchParams.get("page")).toBe("2");
    expect(second.searchParams.get("per_page")).toBe("1");

    const resumed = fake(() => ({ body: fixture("people-page-2") }));

    expect(
      await collect(
        resumed.client.searchPeople({
          query: { "person_titles[]": ["founder"] },
          perPage: 1,
          cursor: 2,
        }),
      ),
    ).toEqual([{ cursor: null, ids: ["p2"] }]);
    expect(new URL(resumed.calls[0]?.url ?? "").searchParams.get("page")).toBe("2");
    expect(resumed.calls).toHaveLength(1);
  });

  it("pages organization search from pagination and omits per_page unless asked", async () => {
    const { calls, client } = fake((call) => ({
      body: fixture(pageOf(call.url) === "2" ? "organizations-page-2" : "organizations-page-1"),
    }));

    expect(
      await collect(client.searchOrganizations({ query: { q_organization_name: "apollo" } })),
    ).toEqual([
      { cursor: 2, ids: ["o1"] },
      { cursor: null, ids: ["o2"] },
    ]);
    expect(calls.map((call) => new URL(call.url).searchParams.get("page"))).toEqual(["1", "2"]);
    expect(calls.every((call) => new URL(call.url).searchParams.get("per_page") === null)).toBe(
      true,
    );
    expect(new URL(calls[0]?.url ?? "").searchParams.get("q_organization_name")).toBe("apollo");
    expect(calls[0]?.method).toBe("POST");

    const resumed = fake(() => ({ body: fixture("organizations-page-2") }));

    expect(await collect(resumed.client.searchOrganizations({ cursor: 2 }))).toEqual([
      { cursor: null, ids: ["o2"] },
    ]);
    expect(resumed.calls).toHaveLength(1);
  });

  it("ends a people search that omits perPage when the following page is empty", async () => {
    const { calls, client } = fake((call) => {
      const page = pageOf(call.url);

      if (page === "2") return { body: fixture("people-page-2") };
      if (page === "3") return { body: fixture("people-empty") };

      return { body: fixture("people-page-1") };
    });

    expect(await collect(client.searchPeople())).toEqual([
      { cursor: 2, ids: ["p1"] },
      { cursor: null, ids: ["p2"] },
    ]);
    expect(calls.map((call) => pageOf(call.url))).toEqual(["1", "2", "3"]);
    expect(calls.every((call) => new URL(call.url).searchParams.get("per_page") === null)).toBe(
      true,
    );
  });

  it("throws when a search is past the display cap", async () => {
    const organizations = fake(() => ({ body: fixture("organizations-capped") }));

    await expect(collect(organizations.client.searchOrganizations())).rejects.toBeInstanceOf(
      SearchCapError,
    );
    expect(organizations.calls).toHaveLength(1);

    const records = fake(() => ({ body: fixture("people-over-records") }));

    await expect(collect(records.client.searchPeople({ perPage: 200 }))).rejects.toMatchObject({
      code: "search_cap",
    });

    const pages = fake(() => ({ body: fixture("people-over-pages") }));
    const error = await collect(pages.client.searchPeople({ perPage: 10 })).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SearchCapError);
    expect(isTerminal(error)).toBe(true);
    expect(pages.calls).toHaveLength(1);
  });
});
