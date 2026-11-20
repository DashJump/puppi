# @puppi/adapter-intercom

Source connector for the Intercom REST API, version 2.17. `contacts()`, `conversations()`, and `companies()` list those resources. The access token is sent as `Authorization: Bearer`. The API version is the `Intercom-Version` header. A binding that omits `api_version` uses `2.17`.

The pinned spec is [Intercom OpenAPI 2.17](https://github.com/intercom/Intercom-OpenAPI/blob/main/descriptions/2.17/api.intercom.io.yaml), trimmed to `GET /contacts`, `GET /conversations`, and `GET /companies/scroll`.

`contacts()` is `GET /contacts`. `conversations()` is `GET /conversations`. The next page sends `starting_after` set to `pages.next.starting_after`. The last page has no `pages.next`. `per_page` is sent only when the caller passed `perPage`. Contacts default to 10 per page, maximum 150. Conversations default to 20, maximum 150. Conversation rows are the `conversations` array.

`companies()` is `GET /companies/scroll`. The first request omits `scroll_param`. The next page sends the `scroll_param` from the previous response. An empty `data` array ends the walk, including when `scroll_param` is still present. The call requires the `read_users_companies` scope. A 401 whose `errors[].code` is `token_unauthorized` throws `token_unauthorized` and names that scope. A page with companies and no `scroll_param` throws `missing_scroll_param`. A workspace allows one open scroll, so two concurrent companies syncs get `400` `scroll_exists`. Wait for that scroll to finish or expire before starting another. A scroll unused for 1 minute expires. Resuming that `scroll_param` is a 404, and `companies()` throws `scroll_expired`. The companies sync has to start again without that cursor.

`base_url` replaces `https://api.intercom.io`. The EU host is `https://api.eu.intercom.io`. The AU host is `https://api.au.intercom.io`.

```json
{
  "intercom": {
    "config": {},
    "secret_refs": { "access_token": "intercom_access_token" }
  }
}
```

`check()` calls `GET /contacts?per_page=1`. It does not verify the companies scope, and it does not open a companies scroll. A `token_unauthorized` body is an authorization failure for that contacts read.

Reference: <https://developers.intercom.com/docs/references/rest-api/api.intercom.io>
