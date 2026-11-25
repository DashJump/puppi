# @puppi/adapter-chargebee

Source connector for [Chargebee](https://apidocs.chargebee.com/docs/api) API v2, Product Catalog 2.0. It lists customers, subscriptions, invoices, and items.

The pinned spec is [`spec/chargebee_api_v2_pc_v2_spec.json`](https://github.com/chargebee/openapi/blob/b9bcf89073ad399420af0e8230cf201ec5b3dcd4/spec/chargebee_api_v2_pc_v2_spec.json) at commit `b9bcf89073ad399420af0e8230cf201ec5b3dcd4` (`info.version` `2026-11-12.8ccf0f3db732eac5f7c79ffeda97bd8acdf9e0a7`). This package keeps `GET /customers`, `GET /subscriptions`, `GET /invoices`, and `GET /items`.

Auth is HTTP basic. The API key is the username and the password is empty. The client sends `Authorization: Basic` of `base64(api_key:)`. `api_key` is a full-access or read-only key. A publishable key cannot list these resources. Test and live sites use different keys.

`site` is one DNS label, such as `acme` or `acme-test`. The client calls `https://{site}.chargebee.com/api/v2`. Anything else throws `chargebee site must be one DNS label`. A missing `site`, when `base_url` is also omitted, throws `chargebee requires site`. `base_url` replaces the host and the client still appends `/api/{version}`. The only `api_version` is `v2`.

`check()` calls `GET /customers?limit=1`.

`customers()`, `subscriptions()`, `invoices()`, and `items()` walk those lists. `cursor` is `next_offset` from the previous page, sent back as the `offset` query parameter. The last page omits `next_offset` and yields a null cursor. `limit` is sent only when the caller passed it. Chargebee's default is 10 and the maximum is 100.

Each list row is a wrapper (`{ customer }`, `{ subscription, customer }`, `{ invoice }`, or `{ item }`). The method yields the resource, not the wrapper. A customers row may also include a card. A subscriptions row includes the customer. Those siblings are not in the yielded record.

Invoice `total` is an integer in cents (`$499.99` is `49999`). `currency_code` is ISO 4217. Timestamps are unix seconds. Subscription `mrr` is updated asynchronously and catches up with a change in less than a minute. Its value depends on the currency.

Deleted resources are left out unless the caller asks Chargebee for them. These methods do not send `include_deleted`.

Chargebee rate limits requests. Past the limit the API answers 429, sometimes with `Retry-After`. The client waits that out. See [Error handling](https://apidocs.chargebee.com/docs/api/error-handling).

This package is API v2 with Product Catalog 2.0. Product Catalog 1.0 is `chargebee_api_v2_pc_v1_spec.json` and serves plans, not `/items`. API v1 is a separate spec. This client calls neither.

```json
{
  "chargebee": {
    "config": { "site": "acme" },
    "secret_refs": { "api_key": "chargebee_api_key" }
  }
}
```

Reference: <https://apidocs.chargebee.com/docs/api/customers#list_customers>, <https://apidocs.chargebee.com/docs/api/subscriptions#list_subscriptions>, <https://apidocs.chargebee.com/docs/api/invoices#list_invoices>, <https://apidocs.chargebee.com/docs/api/items#list_items>, <https://apidocs.chargebee.com/docs/api/auth>.
