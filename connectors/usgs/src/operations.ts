/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    queryEarthquakes: BodyOf<spec["queryEarthquakes"]>;
    countEarthquakes: BodyOf<spec["countEarthquakes"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  queryEarthquakes: {
    method: "get",
    path: "/query",
    query: [
      "format",
      "starttime",
      "endtime",
      "minmagnitude",
      "maxmagnitude",
      "latitude",
      "longitude",
      "maxradiuskm",
      "limit",
      "orderby",
      "eventtype",
    ],
  },
  countEarthquakes: {
    method: "get",
    path: "/count",
    query: ["format", "starttime", "minmagnitude"],
  },
};
