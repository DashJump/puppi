/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    GetCustomers: BodyOf<spec["GetCustomers"]>;
    GetCustomersCustomer: BodyOf<spec["GetCustomersCustomer"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  GetCustomers: {
    method: "get",
    path: "/v1/customers",
    query: ["ending_before", "limit", "starting_after"],
  },
  GetCustomersCustomer: {
    method: "get",
    path: "/v1/customers/{customer}",
    query: [],
  },
};
