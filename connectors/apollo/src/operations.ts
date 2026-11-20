/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation, RequestOf } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    "people-enrichment": BodyOf<spec["people-enrichment"]>;
    "bulk-people-enrichment": BodyOf<spec["bulk-people-enrichment"]>;
    "organization-enrichment": BodyOf<spec["organization-enrichment"]>;
    "bulk-organization-enrichment": BodyOf<spec["bulk-organization-enrichment"]>;
    "people-api-search": BodyOf<spec["people-api-search"]>;
    "organization-search": BodyOf<spec["organization-search"]>;
    "get-current-user-profile": BodyOf<spec["get-current-user-profile"]>;
  };
  requests: {
    "people-enrichment": RequestOf<spec["people-enrichment"]>;
    "bulk-people-enrichment": RequestOf<spec["bulk-people-enrichment"]>;
    "bulk-organization-enrichment": RequestOf<spec["bulk-organization-enrichment"]>;
    "people-api-search": RequestOf<spec["people-api-search"]>;
    "organization-search": RequestOf<spec["organization-search"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  "people-enrichment": {
    method: "post",
    path: "/people/match",
    query: [
      "first_name",
      "last_name",
      "name",
      "email",
      "hashed_email",
      "organization_name",
      "domain",
      "id",
      "linkedin_url",
      "run_waterfall_email",
      "run_waterfall_phone",
      "reveal_personal_emails",
      "reveal_phone_number",
      "webhook_url",
      "poll_only",
    ],
  },
  "bulk-people-enrichment": {
    method: "post",
    path: "/people/bulk_match",
    query: [
      "run_waterfall_email",
      "run_waterfall_phone",
      "reveal_personal_emails",
      "reveal_phone_number",
      "webhook_url",
      "poll_only",
    ],
  },
  "organization-enrichment": {
    method: "get",
    path: "/organizations/enrich",
    query: ["domain", "linkedin_url", "name", "website"],
  },
  "bulk-organization-enrichment": {
    method: "post",
    path: "/organizations/bulk_enrich",
    query: ["domains[]"],
  },
  "people-api-search": {
    method: "post",
    path: "/mixed_people/api_search",
    query: [
      "person_titles[]",
      "include_similar_titles",
      "person_not_titles[]",
      "person_not_past_titles[]",
      "q_keywords",
      "q_person_name",
      "person_locations[]",
      "person_not_locations[]",
      "person_seniorities[]",
      "organization_locations[]",
      "organization_not_locations[]",
      "organization_industry_tag_ids[]",
      "organization_not_industry_tag_ids[]",
      "organization_industries[]",
      "organization_naics_codes[]",
      "not_organization_naics_codes[]",
      "organization_sic_codes[]",
      "not_organization_sic_codes[]",
      "q_organization_domains_list[]",
      "contact_email_status[]",
      "organization_ids[]",
      "organization_num_employees_ranges[]",
      "revenue_range[min]",
      "revenue_range[max]",
      "currently_using_all_of_technology_uids[]",
      "currently_using_any_of_technology_uids[]",
      "currently_not_using_any_of_technology_uids[]",
      "q_organization_job_titles[]",
      "organization_job_locations[]",
      "organization_num_jobs_range[min]",
      "organization_num_jobs_range[max]",
      "organization_job_posted_at_range[min]",
      "organization_job_posted_at_range[max]",
      "organization_headcount_growth_past_n_months",
      "organization_headcount_growth_range[min]",
      "organization_headcount_growth_range[max]",
      "lookalike_organization_ids[]",
      "not_organization_websites_list[]",
      "page",
      "per_page",
    ],
  },
  "organization-search": {
    method: "post",
    path: "/mixed_companies/search",
    query: [
      "q_organization_domains_list[]",
      "organization_num_employees_ranges[]",
      "organization_locations[]",
      "organization_not_locations[]",
      "organization_industry_tag_ids[]",
      "organization_not_industry_tag_ids[]",
      "organization_industries[]",
      "organization_naics_codes[]",
      "not_organization_naics_codes[]",
      "organization_sic_codes[]",
      "not_organization_sic_codes[]",
      "revenue_range[min]",
      "revenue_range[max]",
      "currently_using_any_of_technology_uids[]",
      "q_organization_keyword_tags[]",
      "q_not_organization_keyword_tags[]",
      "q_organization_name",
      "organization_ids[]",
      "latest_funding_amount_range[min]",
      "latest_funding_amount_range[max]",
      "total_funding_range[min]",
      "total_funding_range[max]",
      "latest_funding_date_range[min]",
      "latest_funding_date_range[max]",
      "q_organization_job_titles[]",
      "organization_job_locations[]",
      "organization_num_jobs_range[min]",
      "organization_num_jobs_range[max]",
      "organization_job_posted_at_range[min]",
      "organization_job_posted_at_range[max]",
      "organization_headcount_growth_past_n_months",
      "organization_headcount_growth_range[min]",
      "organization_headcount_growth_range[max]",
      "lookalike_organization_ids[]",
      "not_organization_websites_list[]",
      "page",
      "per_page",
    ],
  },
  "get-current-user-profile": {
    method: "get",
    path: "/users/api_profile",
    query: ["include_credit_usage"],
  },
};
