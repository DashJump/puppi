/**
 * `@puppi/adapter-open-meteo`: a source connector over https://open-meteo.com.
 * No key; three hosts (forecast, geocoding, archive), each a binding field
 * with a default. Archive and geocoding pass `base` on `read`.
 */

import {
  read,
  type CredentialCheck,
  chunk,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  trimSlash,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaForecast, SchemaPlace } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type Place = SchemaPlace;

export default connector;

export const DEFAULT_GEOCODING_URL = "https://geocoding-api.open-meteo.com";
export const DEFAULT_ARCHIVE_URL = "https://archive-api.open-meteo.com";

/** Open-Meteo accepts comma-separated coordinate lists; this many per request keeps a url short. */
const LOCATIONS_PER_REQUEST = 50;

export interface Location {
  latitude: number;
  longitude: number;
}

/** One location's current conditions: the variables asked for, by name. */
export interface Current extends Location {
  timezone: string;
  elevation: number;
  /** ISO 8601, in the response timezone (UTC unless asked otherwise). */
  time: string;
  values: Record<string, number | null>;
  units: Record<string, string>;
}

/** One location's daily series: one row per day, the variables by name. */
export interface Daily extends Location {
  timezone: string;
  days: { date: string; values: Record<string, number | null> }[];
  units: Record<string, string>;
}

export const DEFAULT_CURRENT = [
  "temperature_2m",
  "relative_humidity_2m",
  "precipitation",
  "weather_code",
  "wind_speed_10m",
] as const;

export const DEFAULT_DAILY = [
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_sum",
] as const;

export class Client extends OpenApiClient<Api> {
  private readonly geocodingBase: string;
  private readonly archiveBase: string;

  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(config, options, ...openApiClientOptions(connector, config, secrets, operations));
    this.geocodingBase = trimSlash(
      (config["geocoding_url"] as string | undefined) ?? DEFAULT_GEOCODING_URL,
    );
    this.archiveBase = trimSlash(
      (config["archive_url"] as string | undefined) ?? DEFAULT_ARCHIVE_URL,
    );
  }

  /** `GET` geocoding search for a known place proves a host answers. */
  override async check(): Promise<CredentialCheck> {
    await this.read("searchPlaces", {
      base: this.geocodingBase,
      query: { name: "Berlin", count: 1, language: "en", format: "json" },
    });

    return { ok: true };
  }

  /**
   * Current conditions at each location, in the order given, batched into as
   * few requests as the api allows. `onBatch` fires after each request with
   * the rows so far, so a caller can checkpoint between batches.
   */
  @read
  async current(
    locations: Location[],
    options: { variables?: readonly string[]; onBatch?: (done: number) => void } = {},
  ): Promise<Current[]> {
    const variables = options.variables ?? DEFAULT_CURRENT;
    const rows: Current[] = [];

    for (const batch of chunk(locations, LOCATIONS_PER_REQUEST)) {
      const responses = await this.forecast(batch, { current: variables.join(",") });

      for (const response of responses) {
        const values = Object.fromEntries(
          variables.map((name) => [name, numberOrNull(response.current?.[name])]),
        );

        rows.push({
          latitude: response.latitude,
          longitude: response.longitude,
          timezone: response.timezone,
          elevation: response.elevation,
          time: String(response.current?.["time"] ?? ""),
          values,
          units: response.current_units ?? {},
        });
      }

      options.onBatch?.(rows.length);
    }

    return rows;
  }

  /** A daily forecast per location, `forecastDays` days from today. */
  @read
  async daily(
    locations: Location[],
    options: { variables?: readonly string[]; forecastDays?: number } = {},
  ): Promise<Daily[]> {
    const variables = options.variables ?? DEFAULT_DAILY;
    const rows: Daily[] = [];

    for (const batch of chunk(locations, LOCATIONS_PER_REQUEST)) {
      const responses = await this.forecast(batch, {
        daily: variables.join(","),
        forecast_days: options.forecastDays ?? 7,
      });

      for (const response of responses) rows.push(dailyRows(response, variables));
    }

    return rows;
  }

  /** Historical daily values for one location between two ISO dates (inclusive). */
  @read
  async archive(
    location: Location,
    range: { start: string; end: string; variables?: readonly string[] },
  ): Promise<Daily> {
    const variables = range.variables ?? DEFAULT_DAILY;
    const response = await this.read("getArchive", {
      base: this.archiveBase,
      query: {
        latitude: location.latitude,
        longitude: location.longitude,
        start_date: range.start,
        end_date: range.end,
        daily: variables.join(","),
        timezone: "UTC",
      },
    });

    return dailyRows(response, variables);
  }

  /** Places matching a name, best first. */
  @read
  async geocode(
    name: string,
    options: { count?: number; language?: string } = {},
  ): Promise<Place[]> {
    const body = await this.read("searchPlaces", {
      base: this.geocodingBase,
      query: {
        name,
        count: options.count ?? 5,
        language: options.language ?? "en",
        format: "json",
      },
    });

    return body.results ?? [];
  }

  /** WMO weather interpretation codes, as Open-Meteo documents them. */
  @read
  describe(code: number | null): string {
    return describeWeatherCode(code);
  }

  private async forecast(
    locations: Location[],
    params: Record<string, string | number>,
  ): Promise<SchemaForecast[]> {
    const body = await this.read("getForecast", {
      query: {
        latitude: locations.map((location) => location.latitude).join(","),
        longitude: locations.map((location) => location.longitude).join(","),
        timezone: "UTC",
        ...params,
      },
    });

    // One location answers with an object, several with an array.
    return Array.isArray(body) ? body : [body];
  }
}

function dailyRows(response: SchemaForecast, variables: readonly string[]): Daily {
  const dates = (response.daily?.["time"] ?? []) as string[];

  return {
    latitude: response.latitude,
    longitude: response.longitude,
    timezone: response.timezone,
    days: dates.map((date, index) => ({
      date,
      values: Object.fromEntries(
        variables.map((name) => [name, numberOrNull(response.daily?.[name]?.[index])]),
      ),
    })),
    units: response.daily_units ?? {},
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** WMO weather interpretation codes, as Open-Meteo documents them. */
export function describeWeatherCode(code: number | null): string {
  if (code === null) return "unknown";
  if (code === 0) return "clear";
  if (code <= 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code <= 48) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "rain showers";
  if (code <= 86) return "snow showers";

  return "thunderstorm";
}
