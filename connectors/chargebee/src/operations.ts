/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    list_customers: BodyOf<spec["list_customers"]>;
    list_subscriptions: BodyOf<spec["list_subscriptions"]>;
    list_invoices: BodyOf<spec["list_invoices"]>;
    list_items: BodyOf<spec["list_items"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  list_customers: {
    method: "get",
    path: "/customers",
    query: [
      "limit",
      "offset",
      "include_deleted",
      "id",
      "first_name",
      "last_name",
      "email",
      "company",
      "phone",
      "auto_collection",
      "taxability",
      "created_at",
      "updated_at",
      "offline_payment_method",
      "auto_close_invoices",
      "channel",
      "business_entity_id",
      "sort_by",
      "relationship",
    ],
  },
  list_subscriptions: {
    method: "get",
    path: "/subscriptions",
    query: [
      "limit",
      "offset",
      "include_deleted",
      "id",
      "customer_id",
      "item_id",
      "item_price_id",
      "status",
      "cancel_reason",
      "cancel_reason_code",
      "remaining_billing_cycles",
      "created_at",
      "activated_at",
      "next_billing_at",
      "cancelled_at",
      "has_scheduled_changes",
      "updated_at",
      "offline_payment_method",
      "auto_close_invoices",
      "override_relationship",
      "sort_by",
      "business_entity_id",
      "channel",
      "decommissioned",
    ],
  },
  list_invoices: {
    method: "get",
    path: "/invoices",
    query: [
      "limit",
      "offset",
      "include_deleted",
      "id",
      "subscription_id",
      "customer_id",
      "recurring",
      "status",
      "price_type",
      "date",
      "paid_at",
      "total",
      "amount_paid",
      "amount_adjusted",
      "credits_applied",
      "amount_due",
      "dunning_status",
      "payment_owner",
      "updated_at",
      "channel",
      "voided_at",
      "void_reason_code",
      "sort_by",
      "exclude",
      "einvoice",
    ],
  },
  list_items: {
    method: "get",
    path: "/items",
    query: [
      "limit",
      "offset",
      "id",
      "item_family_id",
      "type",
      "name",
      "item_applicability",
      "status",
      "is_giftable",
      "updated_at",
      "enabled_for_checkout",
      "enabled_in_portal",
      "metered",
      "usage_calculation",
      "channel",
      "business_entity_id",
      "include_site_level_resources",
      "sort_by",
      "bundle_configuration",
    ],
  },
};
