/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    listOrganizations: BodyOf<spec["listOrganizations"]>;
    listOrganizationProjects: BodyOf<spec["listOrganizationProjects"]>;
    listOrganizationIssues: BodyOf<spec["listOrganizationIssues"]>;
    listProjectEvents: BodyOf<spec["listProjectEvents"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  listOrganizations: {
    method: "get",
    path: "/api/0/organizations/",
    query: ["owner", "cursor", "query", "sortBy", "per_page"],
  },
  listOrganizationProjects: {
    method: "get",
    path: "/api/0/organizations/{organization_id_or_slug}/projects/",
    query: ["cursor", "per_page", "query"],
  },
  listOrganizationIssues: {
    method: "get",
    path: "/api/0/organizations/{organization_id_or_slug}/issues/",
    query: [
      "environment",
      "project",
      "statsPeriod",
      "statsPeriodStart",
      "statsPeriodEnd",
      "start",
      "end",
      "groupStatsPeriod",
      "shortIdLookup",
      "query",
      "sort",
      "limit",
      "expand",
      "collapse",
      "cursor",
    ],
  },
  listProjectEvents: {
    method: "get",
    path: "/api/0/projects/{organization_id_or_slug}/{project_id_or_slug}/events/",
    query: [
      "statsPeriod",
      "statsPeriodStart",
      "statsPeriodEnd",
      "start",
      "end",
      "cursor",
      "full",
      "sample",
    ],
  },
};
