/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation, RequestOf } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    "get-self": BodyOf<spec["get-self"]>;
    "get-users": BodyOf<spec["get-users"]>;
    "post-search": BodyOf<spec["post-search"]>;
    "post-database-query": BodyOf<spec["post-database-query"]>;
  };
  requests: {
    "post-search": RequestOf<spec["post-search"]>;
    "post-database-query": RequestOf<spec["post-database-query"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  "get-self": {
    method: "get",
    path: "/v1/users/me",
    query: [],
  },
  "get-users": {
    method: "get",
    path: "/v1/users",
    query: ["start_cursor", "page_size"],
  },
  "post-search": {
    method: "post",
    path: "/v1/search",
    query: ["filter_properties"],
  },
  "post-database-query": {
    method: "post",
    path: "/v1/data_sources/{data_source_id}/query",
    query: ["filter_properties"],
  },
};
