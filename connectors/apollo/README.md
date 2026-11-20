# @puppi/adapter-apollo

Source connector for Apollo.io enrichment and search. Secret `api_key` is sent as `x-api-key`. `base_url` defaults to `https://api.apollo.io/api/v1`. The package lists `unversioned` and sends no version header.

The pinned spec is Apollo's published document at <https://docs.apollo.io/openapi/apollo-rest-api.json>, trimmed to the operations this client calls.

`check()` calls `GET /users/api_profile`.

`enrichPerson({ query })` is `POST /people/match`. `query` is that operation's parameters (`email`, `domain`, `linkedin_url`, and the rest). The return value is Apollo's body, including `person`.

`enrichPeople({ body, query })` is `POST /people/bulk_match`. `body.details` holds up to 10 people. `query` is the reveal flags. `matches` follows `details`. Phone numbers and waterfall results are not in that body. `webhook_url` or `poll_only` selects how Apollo delivers them. This client does not poll `GET /webhook_result/{request_id}`.

`enrichOrganization({ query })` is `GET /organizations/enrich`. Pass `domain`, `linkedin_url`, `name`, or `website`. A name on its own does not match.

`enrichOrganizations({ body, domains })` is `POST /organizations/bulk_enrich`, up to 10 companies. `body.details` is the JSON body. `domains` is sent as the `domains[]` query parameter. When both are set, Apollo uses `details`.

`searchPeople({ query, perPage, cursor })` is `POST /mixed_people/api_search`. `searchOrganizations({ query, perPage, cursor })` is `POST /mixed_companies/search`. Filters stay on the query string, including repeated parameters such as `person_titles[]`. `page` and `per_page` are query parameters on that POST. The POST has no body. `cursor` is the next page number, and null on the last page. `perPage` is sent as `per_page` only when the caller passed it. A search whose `total_pages` is above 500, or whose `total_entries` is above 50,000, or whose page count at the given `perPage` is above 500, throws `SearchCapError`. Narrow the filters and call the method again.

People search does not return email addresses or phone numbers. Enrich the ids it returns. Organization search costs 1 credit per page. People enrichment costs 1–9 credits per person when Apollo returns credit-consuming data. Organization enrichment costs 1 credit per organization. `check()` costs 0 credits.

An API key has to include the endpoint, or be a master key. A key without that path is a 403. A free account has to be registered with a work email.

```json
{
  "apollo": {
    "config": {},
    "secret_refs": { "api_key": "apollo_key" }
  }
}
```

Reference: <https://docs.apollo.io/reference/people-enrichment>
