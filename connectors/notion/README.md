# @puppi/adapter-notion

Source connector for the Notion API. It reads users, title search, and data source queries. Auth is a bearer integration token. Every request sends `Notion-Version`.

The pinned version is `2026-03-11`, the only value of the `Notion-Version` header in the official document at <https://developers.notion.com/openapi.json>. A binding that sets `api_version` must use that value. `base_url` defaults to `https://api.notion.com`.

`token` is the internal integration token, sent as `Authorization: Bearer`.

`users()` walks `GET /v1/users`. `cursor` is `next_cursor`, sent back as the `start_cursor` query parameter. The last page yields a null cursor. `pageSize` is sent as `page_size` only when the caller passed it.

`search({ body })` walks `POST /v1/search`. `body` is the search object (`query`, `filter`, `sort`). `cursor` is sent back as `start_cursor` in the JSON body. An incomplete result throws the same way as `queryDataSource`.

`queryDataSource({ dataSourceId, body })` walks `POST /v1/data_sources/{data_source_id}/query`. `body` is the query object (`filter`, `sorts`, `is_archived`, `result_type`). `cursor` is sent back as `start_cursor` in the JSON body. A response whose `request_status.type` is `incomplete` throws. The thrown error has no `code` of its own. `cause.code` is `incomplete_reason` (`query_result_limit_reached` at the 10,000-match cap). Notion then clears `next_cursor`. Narrow the filter and call the method again.

`check()` calls `GET /v1/users/me`.

```json
{
  "notion": {
    "config": {},
    "secret_refs": { "token": "notion_token" }
  }
}
```

Reference: <https://developers.notion.com/reference/query-a-data-source>
