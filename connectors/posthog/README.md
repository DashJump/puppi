# @puppi/adapter-posthog

Source connector for the PostHog API. It lists persons and saved insights, and runs a HogQL query. The personal API key is sent as `Authorization: Bearer`.

`base_url` defaults to `https://us.posthog.com`. An EU Cloud project sets `https://eu.posthog.com`. A self-hosted project sets its own host. `project_id` is the project those calls read. The package lists `unversioned` and sends no version header.

The pinned spec is the OpenAPI document served at <https://us.posthog.com/api/schema/>, fetched on 2026-11-13, trimmed to the operations this client calls.

`api_key` is a personal API key. `check()` calls `GET /api/users/@me/` and needs the `user:read` scope. `persons()` needs `person:read`. `insights()` needs `insight:read`. `query()` needs `query:read`. A key without the scope is a 403.

`persons()` is `GET /api/projects/{project_id}/persons/`. `insights()` is `GET /api/projects/{project_id}/insights/`. `cursor` is the `next` URL, and null on the last page. That URL carries the server's cursor or `offset`, and the client requests it as returned. `limit` is sent on a request that starts from the beginning, and only when the caller passed it. Persons accepts at most 1000. Omitting `limit` leaves the server's page size, usually 100. `insights()` sends no `refresh`, so the server default `force_cache` applies and the list does not calculate insight results.

`query({ query })` is one `POST /api/projects/{project_id}/query/` with `{"query":{"kind":"HogQLQuery","query":"..."}}`. It returns objects keyed by `columns`. A response with no `columns` or `results`, or a row whose length differs from `columns`, throws. A SELECT with no LIMIT returns at most 100 rows. Put a LIMIT in the SQL, at most 50,000, or keyset on `timestamp` for events and `id` for persons: OFFSET pagination returns HTTP 400 for a personal API key, and `/query` is not an export API.

Retrieving persons, and calculating insights, are limited to 240 requests per minute and 1,200 per hour. The query endpoint allows 2,400 requests per hour and 240 per minute, with 3 queries running at once. A personal API key also draws the project's hourly read budget. Exhausting it returns 429 `api_queries_budget_exceeded` and a `Retry-After` header. The other private endpoints allow 480 requests per minute and 4,800 per hour. PostHog publishes no API version header and changes this schema in place. This package pins the document fetched on 2026-11-13.

```json
{
  "posthog": {
    "config": { "project_id": "12345" },
    "secret_refs": { "api_key": "posthog_key" }
  }
}
```

Reference: <https://posthog.com/docs/api>
