# @puppi/adapter-salesforce

Source connector for the Salesforce REST API. `accounts({ q })` walks a SOQL query. `cursor` is `nextRecordsUrl` from the previous page. The last page yields a null cursor.

Auth is a bearer access token. Secret `access_token` is that token. `base_url` is the instance host, such as `https://example.my.salesforce.com`, and is required. `api_version` defaults to `v59.0` (`v60.0` is the other pinned value) and is a path prefix, `/services/data/<version>`. `check()` calls `GET /query?q=SELECT+Id+FROM+Account+LIMIT+1`.

```json
{
  "salesforce": {
    "config": { "base_url": "https://example.my.salesforce.com" },
    "secret_refs": { "access_token": "salesforce_access_token" }
  }
}
```

```ts
client.accounts({ q: "SELECT Id FROM Account" });
```

Reference: <https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_query.htm>
