/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation, RequestOf } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    ListCustomers: BodyOf<spec["ListCustomers"]>;
    ListLocations: BodyOf<spec["ListLocations"]>;
    SearchOrders: BodyOf<spec["SearchOrders"]>;
    ListPayments: BodyOf<spec["ListPayments"]>;
    ListPaymentRefunds: BodyOf<spec["ListPaymentRefunds"]>;
  };
  requests: {
    SearchOrders: RequestOf<spec["SearchOrders"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  ListCustomers: {
    method: "get",
    path: "/v2/customers",
    query: ["cursor", "limit", "sort_field", "sort_order", "count"],
  },
  ListLocations: {
    method: "get",
    path: "/v2/locations",
    query: [],
  },
  SearchOrders: {
    method: "post",
    path: "/v2/orders/search",
    query: [],
  },
  ListPayments: {
    method: "get",
    path: "/v2/payments",
    query: [
      "begin_time",
      "end_time",
      "sort_order",
      "cursor",
      "location_id",
      "total",
      "last_4",
      "card_brand",
      "limit",
      "is_offline_payment",
      "offline_begin_time",
      "offline_end_time",
      "updated_at_begin_time",
      "updated_at_end_time",
      "sort_field",
    ],
  },
  ListPaymentRefunds: {
    method: "get",
    path: "/v2/refunds",
    query: [
      "begin_time",
      "end_time",
      "sort_order",
      "cursor",
      "location_id",
      "status",
      "source_type",
      "limit",
      "updated_at_begin_time",
      "updated_at_end_time",
      "sort_field",
    ],
  },
};
