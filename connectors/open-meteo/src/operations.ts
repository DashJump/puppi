/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    getForecast: BodyOf<spec["getForecast"]>;
    getArchive: BodyOf<spec["getArchive"]>;
    searchPlaces: BodyOf<spec["searchPlaces"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  getForecast: {
    method: "get",
    path: "/v1/forecast",
    query: ["latitude", "longitude", "current", "daily", "forecast_days", "timezone"],
  },
  getArchive: {
    method: "get",
    path: "/v1/archive",
    query: ["latitude", "longitude", "start_date", "end_date", "daily", "timezone"],
  },
  searchPlaces: {
    method: "get",
    path: "/v1/search",
    query: ["name", "count", "language", "format"],
  },
};
