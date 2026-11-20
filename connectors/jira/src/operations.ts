/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    getMyself: BodyOf<spec["getMyself"]>;
    searchIssues: BodyOf<spec["searchIssues"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  getMyself: {
    method: "get",
    path: "/rest/api/3/myself",
    query: [],
  },
  searchIssues: {
    method: "get",
    path: "/rest/api/3/search/jql",
    query: ["jql", "nextPageToken", "maxResults", "fields"],
  },
};
