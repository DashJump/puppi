import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it, vi } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client, type Feature, flatten } from "../src/index.js";
import { operations } from "../src/operations.js";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, object> };
  paths: Record<
    string,
    { get: { responses: Record<string, { content: { "application/json": { schema: object } } }> } }
  >;
};

/** A response body from the pinned schema, with the fields this case cares about. */
function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

const quake = body(spec.components.schemas["feature"]!, {
  id: "us7000abcd",
  properties: body(spec.components.schemas["featureProperties"]!, {
    mag: 5.1,
    place: "12 km S of Somewhere",
    time: 1_789_000_000_000,
    updated: 1_789_000_100_000,
    tz: null,
    url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
    felt: 12,
    cdi: 3.4,
    mmi: null,
    alert: "green",
    tsunami: 0,
    sig: 400,
    net: "us",
    magType: "mww",
    type: "earthquake",
    title: "M 5.1 - 12 km S of Somewhere",
  }),
  geometry: body(spec.components.schemas["point"]!, {
    coordinates: [140.1, 35.2, 10.5],
  }),
}) as Feature;

const countSchema = spec.paths["/count"]!.get.responses["200"]!.content["application/json"].schema;

function fake(payload: unknown, status = 200) {
  const urls: URL[] = [];

  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(new URL(input instanceof Request ? input.url : String(input)));
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;

  return { urls, client: new Client({}, {}, { fetch: fetchImpl }) };
}

describe("usgs client", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://earthquake.test/fdsnws/event/1" },
      }),
    );
  });
  it("queries the catalog as geojson with the window it was given", async () => {
    const { urls, client } = fake(
      body(spec.components.schemas["featureCollection"]!, {
        metadata: { generated: 1, count: 1, title: "t", status: 200 },
        features: [quake],
      }),
    );

    const rows = await client.earthquakes({
      starttime: "2026-09-09",
      endtime: "2026-09-16",
      minmagnitude: 4.5,
      orderby: "time",
    });

    expect(rows).toHaveLength(1);
    expect(urls[0]?.pathname).toBe("/fdsnws/event/1/query");
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
      format: "geojson",
      starttime: "2026-09-09",
      endtime: "2026-09-16",
      minmagnitude: "4.5",
      orderby: "time",
    });
  });

  it("flattens a feature into one row with ISO times and lon/lat/depth split out", () => {
    expect(flatten(quake)).toEqual({
      id: "us7000abcd",
      magnitude: 5.1,
      magnitude_type: "mww",
      place: "12 km S of Somewhere",
      time: "2026-09-10T00:26:40.000Z",
      updated: "2026-09-10T00:28:20.000Z",
      longitude: 140.1,
      latitude: 35.2,
      depth_km: 10.5,
      tsunami: false,
      significance: 400,
      felt: 12,
      alert: "green",
      event_type: "earthquake",
      network: "us",
      url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
    });
  });

  it("counts without fetching features", async () => {
    const { urls, client } = fake(body(countSchema, { count: 42 }));

    expect(await client.count({ minmagnitude: 6 })).toBe(42);
    expect(urls[0]?.pathname).toBe("/fdsnws/event/1/count");
  });

  it("reports a 504 with its status", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { client } = fake("gateway", 504);
    const caught: unknown[] = [];
    const pending = client.count({}).catch((error: unknown) => {
      caught.push(error);
    });

    await vi.advanceTimersByTimeAsync(1_250);
    await pending;
    expect(caught).toHaveLength(1);
    expect(() => {
      throw caught[0];
    }).toThrow(/usgs answered 504/);
    vi.useRealTimers();
  });
});
