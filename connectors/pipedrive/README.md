# @puppi/adapter-pipedrive

Source connector for Pipedrive deals, persons, organizations, activities, pipelines, and stages. Secret `api_token` is sent as the `x-api-token` header. `company_domain` is one DNS label, the subdomain in `https://<company_domain>.pipedrive.com`. Anything else throws `pipedrive company_domain "…" is not a DNS label`. `base_url` replaces that host. The client appends `/api/v2` for the lists below.

The list operations are Pipedrive's API v2 document at <https://developers.pipedrive.com/docs/api/v1/openapi-v2.yaml> (`openapi` 3.0.1, `info.version` 2.0.0), trimmed to the GET operations this client calls. `GET /users/me` is copied from the API v1 document at <https://developers.pipedrive.com/docs/api/v1/openapi.yaml> (`info.version` 1.0.0). API v2 publishes no current-user operation. Vendor fields on those operations, including `x-token-cost`, are unchanged.

`check()` calls `GET /api/v1/users/me`.

`deals()`, `persons()`, `organizations()`, `activities()`, `pipelines()`, and `stages()` walk the v2 lists. `cursor` is `additional_data.next_cursor`, sent back as the `cursor` query parameter, and null on the last page. When `limit` is omitted, Pipedrive returns 100 rows. The maximum is 500. The client sends `limit` only when the caller passed it.

`deals()` is `GET /api/v2/deals`: not archived, and not deleted. Archived deals are `GET /api/v2/deals/archived`, which this client does not call.

Each request spends tokens from Pipedrive's daily token budget. A spent budget is HTTP 429. See <https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting>.

The v1 list endpoints these v2 calls replace have been out of support since 2026-08-01. `GET /users/me` is not in that set.

```json
{
  "pipedrive": {
    "config": { "company_domain": "acme" },
    "secret_refs": { "api_token": "pipedrive_token" }
  }
}
```

Reference: <https://developers.pipedrive.com/docs/api/v1/Deals> and <https://pipedrive.readme.io/docs/core-api-concepts-pagination>.
