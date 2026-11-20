/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation, RequestOf } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    "properties.runReport": BodyOf<spec["properties.runReport"]>;
    "properties.getMetadata": BodyOf<spec["properties.getMetadata"]>;
  };
  requests: {
    "properties.runReport": RequestOf<spec["properties.runReport"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  "properties.runReport": {
    method: "post",
    path: "/properties/{property}:runReport",
    query: [],
  },
  "properties.getMetadata": {
    method: "get",
    path: "/properties/{property}/metadata",
    query: [],
  },
};
