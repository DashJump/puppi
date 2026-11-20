/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    listCountries: BodyOf<spec["listCountries"]>;
    indicator: BodyOf<spec["indicator"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  listCountries: {
    method: "get",
    path: "/country",
    query: ["format", "per_page", "page"],
  },
  indicator: {
    method: "get",
    path: "/country/{countries}/indicator/{code}",
    query: ["format", "per_page", "page", "mrv", "date"],
  },
};
