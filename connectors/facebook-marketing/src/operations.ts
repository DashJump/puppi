/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    listCampaigns: BodyOf<spec["listCampaigns"]>;
    getAccount: BodyOf<spec["getAccount"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  listCampaigns: {
    method: "get",
    path: "/{account}/campaigns",
    query: ["limit", "after", "fields"],
  },
  getAccount: {
    method: "get",
    path: "/{account}",
    query: [],
  },
};
