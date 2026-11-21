/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    "/api/v4/Countries/Available": BodyOf<spec["/api/v4/Countries/Available"]>;
    "/api/v4/Holidays/{countryCode}/{year}": BodyOf<spec["/api/v4/Holidays/{countryCode}/{year}"]>;
    "/api/v4/Holidays/{countryCode}/Next": BodyOf<spec["/api/v4/Holidays/{countryCode}/Next"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  "/api/v4/Countries/Available": {
    method: "get",
    path: "/api/v4/Countries/Available",
    query: [],
  },
  "/api/v4/Holidays/{countryCode}/{year}": {
    method: "get",
    path: "/api/v4/Holidays/{countryCode}/{year}",
    query: [],
  },
  "/api/v4/Holidays/{countryCode}/Next": {
    method: "get",
    path: "/api/v4/Holidays/{countryCode}/Next",
    query: [],
  },
};
