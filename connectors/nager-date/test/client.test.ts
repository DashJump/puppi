import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it, vi } from "vitest";

import * as connector from "../src/index.js";
import { Client, type Holiday } from "../src/index.js";
import { operations } from "../src/operations.js";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, object> };
};

/** A response body from the pinned schema, with the fields this case cares about. */
function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

const holiday = body(spec.components.schemas["holiday"]!, {
  date: "2026-10-03",
  localName: "Tag der Deutschen Einheit",
  name: "German Unity Day",
  countryCode: "DE",
  fixed: true,
  global: true,
  counties: null,
  launchYear: 1990,
  types: ["Public"],
}) as Holiday;

function country(overrides: Record<string, unknown> = {}) {
  return body(spec.components.schemas["country"]!, overrides);
}

function fake(routes: Record<string, unknown>) {
  const urls: string[] = [];

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url.pathname);
    const route = routes[url.pathname];

    if (route === undefined) return new Response("", { status: 404 });
    if (typeof route === "function") return route();

    return new Response(JSON.stringify(route), { status: 200 });
  }) as typeof fetch;

  return { urls, client: new Client({}, {}, { fetch: fetchImpl }) };
}

describe("nager-date client", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://date.test/api/v3" },
      }),
    );
  });

  it("fetches a year's holidays for a country", async () => {
    const { urls, client } = fake({ "/api/v3/PublicHolidays/2026/DE": [holiday] });

    const holidays = await client.publicHolidays(2026, "DE");

    expect(holidays?.[0]?.name).toBe("German Unity Day");
    expect(urls).toEqual(["/api/v3/PublicHolidays/2026/DE"]);
  });

  it("answers null, not an error, for a country the service does not cover", async () => {
    const { client } = fake({});

    expect(await client.publicHolidays(2026, "XX")).toBeNull();
    expect(await client.next("XX")).toBeNull();
  });

  it("still fails on anything but a 404", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { client } = fake({
      "/api/v3/PublicHolidays/2026/DE": () =>
        new Response("", { status: 503, statusText: "Service Unavailable" }),
    });
    const caught: unknown[] = [];
    const pending = client.publicHolidays(2026, "DE").catch((error: unknown) => {
      caught.push(error);
    });

    await vi.advanceTimersByTimeAsync(1_250);
    await pending;
    expect(caught).toHaveLength(1);
    expect(() => {
      throw caught[0];
    }).toThrow(/nager-date answered 503/);
    vi.useRealTimers();
  });

  it("lists covered countries and the next holidays worldwide", async () => {
    const { client } = fake({
      "/api/v3/AvailableCountries": [country({ countryCode: "DE", name: "Germany" })],
      "/api/v3/NextPublicHolidaysWorldwide": [holiday],
    });

    expect(await client.availableCountries()).toEqual([{ countryCode: "DE", name: "Germany" }]);
    expect((await client.nextWorldwide())[0]?.countryCode).toBe("DE");
  });
});
