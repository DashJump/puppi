/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    getShop: BodyOf<spec["getShop"]>;
    listCustomers: BodyOf<spec["listCustomers"]>;
    getCustomer: BodyOf<spec["getCustomer"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  getShop: {
    method: "get",
    path: "/shop.json",
    query: [],
  },
  listCustomers: {
    method: "get",
    path: "/customers.json",
    query: ["limit"],
  },
  getCustomer: {
    method: "get",
    path: "/customers/{customer_id}.json",
    query: [],
  },
};
