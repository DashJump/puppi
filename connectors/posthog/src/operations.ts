/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation, RequestOf } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    users_retrieve: BodyOf<spec["users_retrieve"]>;
    persons_list: BodyOf<spec["persons_list"]>;
    insights_list: BodyOf<spec["insights_list"]>;
    query_create: BodyOf<spec["query_create"]>;
  };
  requests: {
    query_create: RequestOf<spec["query_create"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  users_retrieve: {
    method: "get",
    path: "/api/users/{uuid}/",
    query: [],
  },
  persons_list: {
    method: "get",
    path: "/api/projects/{project_id}/persons/",
    query: [
      "client_query_id",
      "distinct_id",
      "email",
      "format",
      "include_matched_fields",
      "limit",
      "offset",
      "properties",
      "search",
    ],
  },
  insights_list: {
    method: "get",
    path: "/api/projects/{project_id}/insights/",
    query: [
      "basic",
      "created_by",
      "created_date_from",
      "created_date_to",
      "dashboards",
      "date_from",
      "date_to",
      "display",
      "exclude_bi",
      "favorited",
      "format",
      "include_dashboards",
      "insight",
      "last_viewed_date_from",
      "last_viewed_date_to",
      "limit",
      "offset",
      "order",
      "refresh",
      "saved",
      "search",
      "short_id",
      "tags",
      "user",
    ],
  },
  query_create: {
    method: "post",
    path: "/api/projects/{project_id}/query/",
    query: [],
  },
};
