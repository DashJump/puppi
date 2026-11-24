/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    "get-/crm/objects/2026-09/contacts_/crm/objects/2026-09-beta/{objectType}": BodyOf<
      spec["get-/crm/objects/2026-09/contacts_/crm/objects/2026-09-beta/{objectType}"]
    >;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  "get-/crm/objects/2026-09/contacts_/crm/objects/2026-09-beta/{objectType}": {
    method: "get",
    path: "/crm/objects/2026-09/contacts",
    query: ["after", "archived", "associations", "limit", "properties", "propertiesWithHistory"],
  },
};
