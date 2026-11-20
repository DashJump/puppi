# @puppi/adapter-jira

Source connector for the Jira Cloud platform REST API. `issues({ jql })` walks `GET /rest/api/3/search/jql`. `cursor` is `nextPageToken`. The last page yields a null cursor. The first page sends no token. `maxResults` is sent only when the caller passed it. The request asks for `summary` and `updated`.

Auth is HTTP Basic: config `email` and secret `api_token`. `base_url` is the site origin when it is set. Otherwise `domain` is used: a value that starts with `https://` is the origin, a value with a dot is `https://<domain>`, and any other value is `https://<domain>.atlassian.net`. The package lists `unversioned`. `check()` calls `GET /rest/api/3/myself`.

```json
{
  "jira": {
    "config": { "domain": "acme", "email": "ada@acme.com" },
    "secret_refs": { "api_token": "jira_api_token" }
  }
}
```

```ts
client.issues({ jql: "project = DEMO", maxResults: 1 });
```

Reference: <https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-get>
