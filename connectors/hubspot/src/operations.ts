/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    listContacts: BodyOf<spec["listContacts"]>;
    getContact: BodyOf<spec["getContact"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  listContacts: {
    method: "get",
    path: "/objects/contacts",
    query: ["limit", "after"],
  },
  getContact: {
    method: "get",
    path: "/objects/contacts/{contactId}",
    query: [],
  },
};
