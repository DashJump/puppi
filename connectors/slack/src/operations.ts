/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    conversationsList: BodyOf<spec["conversationsList"]>;
    conversationsInfo: BodyOf<spec["conversationsInfo"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  conversationsList: {
    method: "get",
    path: "/conversations.list",
    query: ["limit", "cursor", "types", "exclude_archived"],
  },
  conversationsInfo: {
    method: "get",
    path: "/conversations.info",
    query: ["channel"],
  },
};
