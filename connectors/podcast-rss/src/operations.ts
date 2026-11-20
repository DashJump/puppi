/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    getFeed: BodyOf<spec["getFeed"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  getFeed: {
    method: "get",
    path: "/feed",
    query: [],
  },
};
