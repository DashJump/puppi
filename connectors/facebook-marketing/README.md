# @puppi/adapter-facebook-marketing

Source connector for the Facebook Marketing API. `campaigns()` walks an ad account's campaigns. `cursor` is `paging.cursors.after`, sent back as `after`, and only while `paging.next` is present. The last page yields a null cursor. `fields` is always `id,name,status,updated_time`. Without `fields` the edge returns only `id`.

Auth is a bearer access token. Secret `access_token` is that token. Config `ad_account_id` is required. A leading `act_` is not doubled. `api_version` defaults to `v26.0` (`v25.0` is the other pinned value) and is a path prefix. `base_url` defaults to `https://graph.facebook.com` and replaces the host. `check()` calls `GET /<version>/{account}?fields=id`.

```json
{
  "facebook-marketing": {
    "config": { "ad_account_id": "123" },
    "secret_refs": { "access_token": "facebook_access_token" }
  }
}
```

```ts
client.campaigns();
```

Reference: <https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/campaigns>
