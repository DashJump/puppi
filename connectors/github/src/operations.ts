/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    getUser: BodyOf<spec["getUser"]>;
    listIssues: BodyOf<spec["listIssues"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  getUser: {
    method: "get",
    path: "/user",
    query: [],
  },
  listIssues: {
    method: "get",
    path: "/repos/{owner}/{repo}/issues",
    query: ["state", "since", "per_page", "page"],
  },
};
