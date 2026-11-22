# @puppi/adapter-hubspot

Source connector for the HubSpot CRM contacts API. `contacts()` walks the contacts list. `cursor` is `paging.next.after` from the previous page. The last page yields a null cursor.

Auth is a bearer access token. Secret `access_token` is that token. `api_version` defaults to `2026-09`, which requests `GET /crm/objects/2026-09/contacts`. `v3` requests `GET /crm/v3/objects/contacts`. `base_url` defaults to `https://api.hubapi.com` and replaces the host. `check()` calls `GET /crm/objects/2026-09/contacts?limit=1`.

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

Reference: <https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide>
