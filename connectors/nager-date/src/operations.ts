/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    availableCountries: BodyOf<spec["availableCountries"]>;
    publicHolidays: BodyOf<spec["publicHolidays"]>;
    nextWorldwide: BodyOf<spec["nextWorldwide"]>;
    next: BodyOf<spec["next"]>;
    longWeekends: BodyOf<spec["longWeekends"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  availableCountries: {
    method: "get",
    path: "/AvailableCountries",
    query: [],
  },
  publicHolidays: {
    method: "get",
    path: "/PublicHolidays/{year}/{countryCode}",
    query: [],
  },
  nextWorldwide: {
    method: "get",
    path: "/NextPublicHolidaysWorldwide",
    query: [],
  },
  next: {
    method: "get",
    path: "/NextPublicHolidays/{countryCode}",
    query: [],
  },
  longWeekends: {
    method: "get",
    path: "/LongWeekend/{year}/{countryCode}",
    query: [],
  },
};
