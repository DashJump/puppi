/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    listTickets: BodyOf<spec["listTickets"]>;
    getMe: BodyOf<spec["getMe"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  listTickets: {
    method: "get",
    path: "/tickets",
    query: ["page[size]", "page[after]"],
  },
  getMe: {
    method: "get",
    path: "/users/me",
    query: [],
  },
};
