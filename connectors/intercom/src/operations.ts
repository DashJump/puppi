/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    ListContacts: BodyOf<spec["ListContacts"]>;
    listConversations: BodyOf<spec["listConversations"]>;
    scrollOverAllCompanies: BodyOf<spec["scrollOverAllCompanies"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  ListContacts: {
    method: "get",
    path: "/contacts",
    query: ["include_merge_history", "escape_identity", "per_page", "starting_after"],
  },
  listConversations: {
    method: "get",
    path: "/conversations",
    query: ["per_page", "starting_after", "include_monitors", "include_scorecards"],
  },
  scrollOverAllCompanies: {
    method: "get",
    path: "/companies/scroll",
    query: ["scroll_param"],
  },
};
