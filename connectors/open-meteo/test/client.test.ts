import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as connector from "../src/index.js";
import { Client, describeWeatherCode } from "../src/index.js";
import { operations } from "../src/operations.js";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, object> };
};

/** A response body from the pinned schema, with the fields this case cares about. */
function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

function fake(handler: (url: URL) => unknown) {
  const urls: URL[] = [];

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url);
    const payload = handler(url);

    return payload instanceof Response
      ? payload
      : new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;

  return {
    urls,
    client: new Client(
      {
        base_url: "https://forecast.test",
        geocoding_url: "https://geo.test",
        archive_url: "https://archive.test",
      },
      {},
      { fetch: fetchImpl },
    ),
  };
}

/** Fake timers cover the clock the client sleeps on, and leave the socket clock alone. */
function useWaitTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}

/** Records how `pending` settles, so a retry can fail before the test awaits it. */
function watch<T>(pending: Promise<T>): {
  outcome?: { ok: true; value: T } | { ok: false; error: unknown };
} {
  const box: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};

  void pending.then(
    (value) => {
      box.outcome = { ok: true, value };
    },
    (error: unknown) => {
      box.outcome = { ok: false, error };
    },
  );

  return box;
}

function take<T>(box: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } }): T {
  if (!box.outcome) throw new Error("the call did not finish");
  if (!box.outcome.ok) throw box.outcome.error;

  return box.outcome.value;
}

afterEach(() => {
  vi.useRealTimers();
});

function forecastFor(latitude: number, longitude: number) {
  return body(spec.components.schemas["forecast"]!, {
    latitude,
    longitude,
    timezone: "GMT",
    elevation: 10,
    current: { time: "2026-09-16T12:00", temperature_2m: 21.5, weather_code: 3, wind_speed_10m: 9 },
    current_units: { temperature_2m: "°C" },
  });
}

describe("open-meteo client", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: {
          base_url: "https://forecast.test",
          geocoding_url: "https://geo.test",
          archive_url: "https://archive.test",
        },
      }),
    );
  });

  it("asks for one location as an object and unpacks it", async () => {
    const { urls, client } = fake(() => forecastFor(52.5, 13.4));

    const [berlin] = await client.current([{ latitude: 52.5, longitude: 13.4 }], {
      variables: ["temperature_2m", "weather_code", "wind_speed_10m"],
    });

    expect(berlin).toMatchObject({
      latitude: 52.5,
      longitude: 13.4,
      time: "2026-09-16T12:00",
      values: { temperature_2m: 21.5, weather_code: 3, wind_speed_10m: 9 },
      units: { temperature_2m: "°C" },
    });

    const [url] = urls;
    expect(url?.pathname).toBe("/v1/forecast");
    expect(url?.searchParams.get("latitude")).toBe("52.5");
    expect(url?.searchParams.get("current")).toBe("temperature_2m,weather_code,wind_speed_10m");
    expect(url?.searchParams.get("timezone")).toBe("UTC");
  });

  it("batches many locations into few requests and keeps their order", async () => {
    const { urls, client } = fake((url) => {
      const lats = url.searchParams.get("latitude")!.split(",").map(Number);
      const lngs = url.searchParams.get("longitude")!.split(",").map(Number);

      return lats.map((lat, i) => forecastFor(lat, lngs[i]!));
    });

    const locations = Array.from({ length: 120 }, (_, i) => ({ latitude: i, longitude: -i }));
    const batches: number[] = [];
    const rows = await client.current(locations, { onBatch: (done) => void batches.push(done) });

    expect(rows.map((r) => r.latitude)).toEqual(locations.map((l) => l.latitude));
    expect(urls).toHaveLength(3);
    expect(batches).toEqual([50, 100, 120]);
  });

  it("reads a variable the api left out as null rather than NaN", async () => {
    const { client } = fake(() => forecastFor(0, 0));

    const [row] = await client.current([{ latitude: 0, longitude: 0 }], {
      variables: ["temperature_2m", "snowfall"],
    });

    expect(row?.values).toEqual({ temperature_2m: 21.5, snowfall: null });
  });

  it("turns a daily series into one row per day", async () => {
    const { client } = fake(() =>
      body(spec.components.schemas["forecast"]!, {
        latitude: 1,
        longitude: 2,
        timezone: "GMT",
        elevation: 0,
        daily: {
          time: ["2026-09-16", "2026-09-17"],
          temperature_2m_max: [20, 22],
          temperature_2m_min: [10, null],
        },
        daily_units: { temperature_2m_max: "°C" },
      }),
    );

    const [series] = await client.daily([{ latitude: 1, longitude: 2 }], {
      variables: ["temperature_2m_max", "temperature_2m_min"],
      forecastDays: 2,
    });

    expect(series?.days).toEqual([
      { date: "2026-09-16", values: { temperature_2m_max: 20, temperature_2m_min: 10 } },
      { date: "2026-09-17", values: { temperature_2m_max: 22, temperature_2m_min: null } },
    ]);
  });

  it("geocodes against the geocoding host and archives against the archive host", async () => {
    const { urls, client } = fake((url) =>
      url.host === "geo.test"
        ? body(spec.components.schemas["search"]!, {
            results: [
              body(spec.components.schemas["place"]!, {
                id: 1,
                name: "Berlin",
                latitude: 52.5,
                longitude: 13.4,
              }),
            ],
          })
        : body(spec.components.schemas["forecast"]!, {
            latitude: 52.5,
            longitude: 13.4,
            timezone: "GMT",
            elevation: 0,
            daily: { time: [] },
          }),
    );

    const places = await client.geocode("Berlin", { count: 1 });
    await client.archive(
      { latitude: 52.5, longitude: 13.4 },
      { start: "2026-01-01", end: "2026-01-31" },
    );

    expect(places[0]?.name).toBe("Berlin");
    expect(urls.map((u) => `${u.host}${u.pathname}`)).toEqual([
      "geo.test/v1/search",
      "archive.test/v1/archive",
    ]);
    expect(urls[1]?.searchParams.get("start_date")).toBe("2026-01-01");
  });

  it("reports a persistent 503 with its status after the client waits", async () => {
    useWaitTimers();
    let calls = 0;
    const { client } = fake(() => {
      calls += 1;

      return new Response("down", { status: 503, statusText: "Service Unavailable" });
    });
    const pending = watch(client.current([{ latitude: 0, longitude: 0 }]));

    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(() => take(pending)).toThrow(/open-meteo answered 503/);
    expect(calls).toBe(3);
  });

  it("names the WMO weather codes", () => {
    expect(describeWeatherCode(0)).toBe("clear");
    expect(describeWeatherCode(61)).toBe("rain");
    expect(describeWeatherCode(95)).toBe("thunderstorm");
    expect(describeWeatherCode(null)).toBe("unknown");
  });
});
