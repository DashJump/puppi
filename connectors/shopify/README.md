# @puppi/adapter-shopify

Source connector for the Shopify Admin REST customers resource. The access token is sent as `x-shopify-access-token`. The API version is the path segment `/admin/api/<version>`.

`apiVersions` is `2026-07` and `2026-10`. A binding that omits `api_version` uses `2026-10`. `GET /customers.json` returns `{ customers }`. The next page is the absolute URL in the `Link` header `rel="next"` (`page_info` plus `limit`). Shopify documents that list and that header the same way for both versions. `limit` defaults to 50 and the maximum is 250. The last page has no `rel="next"`. The client sends `limit` only when the caller passed one.

`config.shop` is the subdomain (`ada` becomes `ada.myshopify.com`). When `config.base_url` is set, that string is the request prefix, including `/admin/api/<version>`, and `shop` is ignored.

```json
{
  "shopify": {
    "config": { "shop": "ada" },
    "secret_refs": { "access_token": "shopify_access_token" }
  }
}
```

`customers()` walks every page. `read("getCustomer")` unwraps `{ customer }`. `check()` calls `GET /shop.json`.

Reference: <https://shopify.dev/docs/api/admin-rest/latest/resources/customer>
