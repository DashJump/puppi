/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    getLatest: BodyOf<spec["getLatest"]>;
    getOn: BodyOf<spec["getOn"]>;
    getSeries: BodyOf<spec["getSeries"]>;
    getCurrencies: BodyOf<spec["getCurrencies"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  getLatest: {
    method: "get",
    path: "/latest",
    query: ["base", "symbols"],
  },
  getOn: {
    method: "get",
    path: "/{date}",
    query: [],
  },
  getSeries: {
    method: "get",
    path: "/{range}",
    query: [],
  },
  getCurrencies: {
    method: "get",
    path: "/currencies",
    query: [],
  },
};
