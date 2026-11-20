# @puppi/adapter-hubspot

Source connector for the HubSpot CRM contacts API. `contacts()` walks the contacts list. `cursor` is `paging.next.after` from the previous page. The last page yields a null cursor.

Auth is a bearer access token. Secret `access_token` is that token. `api_version` defaults to `v3` and is a path prefix, `/crm/<version>`. `base_url` defaults to `https://api.hubapi.com` and replaces the host. `check()` calls `GET /crm/<version>/objects/contacts?limit=1`.

```json
{
  "hubspot": {
    "config": {},
    "secret_refs": { "access_token": "hubspot_access_token" }
  }
}
```

```ts
client.contacts();
```

Reference: <https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide>
