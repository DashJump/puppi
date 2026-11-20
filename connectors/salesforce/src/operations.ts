/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    query: BodyOf<spec["query"]>;
    getAccount: BodyOf<spec["getAccount"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  query: {
    method: "get",
    path: "/query",
    query: ["q"],
  },
  getAccount: {
    method: "get",
    path: "/sobjects/Account/{id}",
    query: [],
  },
};
