# @puppi/adapter-sentry

Source connector for the Sentry web API. `projects` lists an organization's projects, `issues` lists an organization's issues, and `events` lists one project's error events. Secret `token` is a user auth token or an organization auth token, sent as `Authorization: Bearer`.

`base_url` defaults to `https://sentry.io`. Set it to `https://us.sentry.io`, `https://de.sentry.io`, or a self-hosted origin. `/api/0/` is a fixed path prefix. The package lists `unversioned` and sends no version header.

Each call accepts any one scope in its row. The lists are the `security` arrays on the pinned operations.

| Call | Scopes |
| --- | --- |
| `check()`, `projects` | `org:read`, `org:write`, `org:admin` |
| `issues` | `event:read`, `event:write`, `event:admin` |
| `events` | `project:read`, `project:write`, `project:admin` |

`check()` calls `GET /api/0/organizations/`. A token with only `event:read` or `project:read` fails that call. A 403 names scope `org:read`.

Sentry sends `Link` `rel="next"` on every page, including the last. `cursor` is that next URL when its `results` parameter is `true`, and null otherwise. The client follows that URL. A next URL on another origin throws. `projects` sends `per_page` and `query` only when the caller passed them. The default page size is 100, which is also the maximum. `issues` sends `query`, `limit`, `sort`, `project`, `environment`, `statsPeriod`, `start`, and `end` only when the caller passed them. Omitting `query` leaves Sentry's default `is:unresolved`; `""` returns every issue. `limit` defaults to 100 and the maximum is 100. `sort` defaults to `date`. `project` and `environment` are one value each. `events` sends `statsPeriod`, `start`, `end`, `full`, and `sample` only when the caller passed them. `statsPeriod` overrides `start` and `end`. `full: true` includes the stacktrace and caps the page at 10.

`GET /api/0/organizations/{organization_id_or_slug}/events/` is the Explore table, not `events`. `issues` does not send `expand`, `collapse`, `groupStatsPeriod`, `shortIdLookup`, `statsPeriodStart`, or `statsPeriodEnd`. `events` does not send `statsPeriodStart` or `statsPeriodEnd`.

```json
{
  "sentry": {
    "config": {},
    "secret_refs": { "token": "sentry_token" }
  }
}
```

Reference: <https://docs.sentry.io/api/>, <https://docs.sentry.io/api/pagination/>, <https://docs.sentry.io/api/organizations/list-an-organizations-projects/>, <https://docs.sentry.io/api/events/list-an-organizations-issues/>, and <https://docs.sentry.io/api/events/list-a-projects-error-events/>.
