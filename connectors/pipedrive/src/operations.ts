/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    getDeals: BodyOf<spec["getDeals"]>;
    getPersons: BodyOf<spec["getPersons"]>;
    getOrganizations: BodyOf<spec["getOrganizations"]>;
    getActivities: BodyOf<spec["getActivities"]>;
    getPipelines: BodyOf<spec["getPipelines"]>;
    getStages: BodyOf<spec["getStages"]>;
    getCurrentUser: BodyOf<spec["getCurrentUser"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  getDeals: {
    method: "get",
    path: "/deals",
    query: [
      "filter_id",
      "ids",
      "owner_id",
      "person_id",
      "org_id",
      "pipeline_id",
      "stage_id",
      "status",
      "updated_since",
      "updated_until",
      "sort_by",
      "sort_direction",
      "include_fields",
      "custom_fields",
      "include_option_labels",
      "include_labels",
      "limit",
      "cursor",
    ],
  },
  getPersons: {
    method: "get",
    path: "/persons",
    query: [
      "filter_id",
      "ids",
      "owner_id",
      "org_id",
      "deal_id",
      "updated_since",
      "updated_until",
      "sort_by",
      "sort_direction",
      "include_fields",
      "custom_fields",
      "include_option_labels",
      "include_labels",
      "limit",
      "cursor",
    ],
  },
  getOrganizations: {
    method: "get",
    path: "/organizations",
    query: [
      "filter_id",
      "ids",
      "owner_id",
      "updated_since",
      "updated_until",
      "sort_by",
      "sort_direction",
      "include_fields",
      "custom_fields",
      "include_option_labels",
      "include_labels",
      "limit",
      "cursor",
    ],
  },
  getActivities: {
    method: "get",
    path: "/activities",
    query: [
      "filter_id",
      "ids",
      "owner_id",
      "deal_id",
      "lead_id",
      "person_id",
      "org_id",
      "done",
      "updated_since",
      "updated_until",
      "sort_by",
      "sort_direction",
      "include_fields",
      "limit",
      "cursor",
    ],
  },
  getPipelines: {
    method: "get",
    path: "/pipelines",
    query: ["sort_by", "sort_direction", "limit", "cursor"],
  },
  getStages: {
    method: "get",
    path: "/stages",
    query: ["pipeline_id", "sort_by", "sort_direction", "limit", "cursor"],
  },
  getCurrentUser: {
    method: "get",
    path: "/users/me",
    query: [],
  },
};
