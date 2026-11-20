/**
 * `@puppi/adapter-usgs`: a source connector over the USGS earthquake catalog
 * (https://earthquake.usgs.gov/fdsnws/event/1). No key. The catalog is
 * revised for days after an event, so a window re-read is never the same
 * twice.
 */

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaFeature, SchemaFeatureCollection } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type Feature = SchemaFeature;
export type FeatureCollection = SchemaFeatureCollection;

export default connector;

export interface QueryParams {
  /** ISO 8601 date or datetime. */
  starttime?: string;
  endtime?: string;
  minmagnitude?: number;
  maxmagnitude?: number;
  /** A circle: all three or none. */
  latitude?: number;
  longitude?: number;
  maxradiuskm?: number;
  limit?: number;
  orderby?: "time" | "time-asc" | "magnitude" | "magnitude-asc";
  eventtype?: string;
}

/** One event, flat: the row a source emits. The API returns GeoJSON, not this shape. */
export interface Earthquake {
  id: string;
  magnitude: number | null;
  magnitude_type: string | null;
  place: string | null;
  /** ISO 8601, UTC. */
  time: string;
  updated: string;
  longitude: number;
  latitude: number;
  depth_km: number;
  tsunami: boolean;
  significance: number;
  felt: number | null;
  alert: string | null;
  event_type: string;
  network: string;
  url: string;
}

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(config, options, ...openApiClientOptions(connector, config, secrets, operations));
  }

  /** `GET /count?format=geojson` proves the host answers. */
  override async check(): Promise<CredentialCheck> {
    await this.read("countEarthquakes", { query: { format: "geojson" } });

    return { ok: true };
  }

  /** The raw GeoJSON answer. */
  @read
  query(params: QueryParams): Promise<FeatureCollection> {
    return this.read("queryEarthquakes", {
      query: { format: "geojson", ...params },
    });
  }

  /** The events matching `params`, flattened. */
  @read
  async earthquakes(params: QueryParams): Promise<Earthquake[]> {
    const collection = await this.query(params);

    return collection.features.map(flatten);
  }

  /** How many events match, without fetching them. */
  @read
  async count(params: QueryParams): Promise<number> {
    const answer = await this.read("countEarthquakes", {
      query: { format: "geojson", ...params },
    });

    return answer.count;
  }
}

export function flatten(feature: Feature): Earthquake {
  const { properties, geometry } = feature;
  const [longitude, latitude, depth] = geometry.coordinates as [number, number, number];

  return {
    id: feature.id,
    magnitude: properties.mag,
    magnitude_type: properties.magType,
    place: properties.place,
    time: new Date(properties.time).toISOString(),
    updated: new Date(properties.updated).toISOString(),
    longitude,
    latitude,
    depth_km: depth,
    tsunami: properties.tsunami === 1,
    significance: properties.sig,
    felt: properties.felt,
    alert: properties.alert,
    event_type: properties.type,
    network: properties.net,
    url: properties.url,
  };
}
