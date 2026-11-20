import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client, type Country, type Observation } from "../src/index.js";
import { operations } from "../src/operations.js";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, object> };
};

/** A response body from the pinned schema, with the fields this case cares about. */
function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

function named(overrides: Record<string, unknown>) {
  return body(spec.components.schemas["named"]!, overrides);
}

const germany = body(spec.components.schemas["country"]!, {
  id: "DEU",
  iso2Code: "DE",
  name: "Germany",
  region: named({ id: "ECS", iso2code: "Z7", value: "Europe & Central Asia" }),
  adminregion: named({ id: "", iso2code: "", value: "" }),
  incomeLevel: named({ id: "HIC", iso2code: "XD", value: "High income" }),
  lendingType: named({ id: "LNX", iso2code: "XX", value: "Not classified" }),
  capitalCity: "Berlin",
  longitude: "13.4115",
  latitude: "52.5235",
}) as Country;

const world: Country = {
  ...germany,
  id: "WLD",
  iso2Code: "1W",
  name: "World",
  region: named({ id: "NA", iso2code: "NA", value: "Aggregates" }) as Country["region"],
  capitalCity: "",
  longitude: "",
  latitude: "",
};

function observation(iso3: string, date: string, value: number | null): Observation {
  return body(spec.components.schemas["observation"]!, {
    indicator: { id: "SP.POP.TOTL", value: "Population, total" },
    country: { id: iso3.slice(0, 2), value: iso3 },
    countryiso3code: iso3,
    date,
    value,
    unit: "",
    obs_status: "",
    decimal: 0,
  }) as Observation;
}

function pageMeta(overrides: Record<string, unknown>) {
  return body(spec.components.schemas["pageMeta"]!, overrides);
}

function message(overrides: Record<string, unknown> = {}) {
  return body(spec.components.schemas["message"]!, overrides);
}

function messageEnvelope(overrides: Record<string, unknown> = {}) {
  return body(spec.components.schemas["messageEnvelope"]!, overrides);
}

function fake(handler: (url: URL) => unknown) {
  const urls: URL[] = [];

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url);
    return new Response(JSON.stringify(handler(url)), { status: 200 });
  }) as typeof fetch;

  return { urls, client: new Client({}, {}, { fetch: fetchImpl }) };
}

describe("world-bank client", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://api.worldbank.test/v2" },
      }),
    );
  });
  it("walks every page of the country list", async () => {
    const { urls, client } = fake((url) => {
      const page = Number(url.searchParams.get("page"));
      return [pageMeta({ page, pages: 2, total: 2 }), [page === 1 ? germany : world]];
    });

    const ids: string[] = [];
    const cursors: (string | number | null)[] = [];

    for await (const page of client.countries()) {
      ids.push(...page.data.map((country) => country.id));
      cursors.push(page.cursor);
    }

    expect(ids).toEqual(["DEU", "WLD"]);
    expect(cursors).toEqual([2, null]);
    expect(urls.map((u) => u.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(urls[0]?.pathname).toBe("/v2/country");
    expect(urls[0]?.searchParams.get("format")).toBe("json");
  });

  it("asks for an indicator's most recent values, for every country", async () => {
    const { urls, client } = fake(() => [
      pageMeta({ page: 1, pages: 1, total: 1 }),
      [observation("DEU", "2023", 84_548_231)],
    ]);

    const rows = [];

    for await (const page of client.indicator("SP.POP.TOTL", { mrv: 1 })) rows.push(...page.data);

    expect(rows[0]?.value).toBe(84_548_231);
    expect(urls[0]?.pathname).toBe("/v2/country/all/indicator/SP.POP.TOTL");
    expect(urls[0]?.searchParams.get("mrv")).toBe("1");
  });

  it("yields no rows when the api reports an empty selection as [meta, null]", async () => {
    const emptySelection = JSON.parse(
      readFileSync(new URL("fixtures/empty-selection.json", import.meta.url), "utf8"),
    ) as unknown;
    const { urls, client } = fake(() => emptySelection);

    const rows = [];

    for await (const page of client.indicator("SP.POP.TOTL", { date: "2099:2099" })) {
      rows.push(...page.data);
    }

    expect(rows).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it("turns the api's 200-with-a-message refusal into an error", async () => {
    const { client } = fake(() => [
      messageEnvelope({
        message: [
          message({
            id: "120",
            key: "Invalid value",
            value: "The provided parameter value is not valid",
          }),
        ],
      }),
    ]);

    await expect(client.indicator("NOPE").next()).rejects.toThrow(
      /world-bank answered .* not valid/,
    );
  });
});
