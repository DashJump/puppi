# @puppi/adapter-stripe

Source connector for the Stripe Customers API. `customers()` lists customers, and `read("GetCustomersCustomer")` retrieves one. `api_key` is sent as `Authorization: Bearer`. Every request sends `stripe-version`.

`api_version` must be `2024-06-20`. A binding that omits it uses `2024-06-20`. Any other string throws `stripe api_version "<value>" is not supported by this connector (2024-06-20)` when the client is constructed. The client sends that value in the `stripe-version` header.

`base_url` defaults to `https://api.stripe.com`. Sandbox and live mode share that host. The key selects the mode.

`api_key` is a restricted key (`rk_test_...` or `rk_live_...`) or a secret key (`sk_test_...` or `sk_live_...`). Open the API keys page in the Stripe Dashboard. The sandbox page is <https://dashboard.stripe.com/test/apikeys>. Switch that page to live mode for a live key.

1. Click Create restricted key.
2. Name the key.
3. Set Customers to Read. Leave every other resource at None.
4. Click Create key, finish the verification Stripe sends, and copy the key.

Customers Read is Stripe's `customer_read` permission. It covers both calls below. A secret key can call them too. A publishable key (`pk_...`) cannot.

The pinned spec is Stripe's OpenAPI document (`info.version` `2026-09-30.endive`), trimmed to `GET /v1/customers` and `GET /v1/customers/{customer}`.

`check()` calls `GET /v1/customers?limit=1`. It proves `api_key` can list customers.

`customers({ limit, cursor })` is `GET /v1/customers`. Stripe returns customers newest first. `cursor` is the id of the last customer on the page, sent back as `starting_after`. The last page has `has_more` false and yields a null cursor. An empty list yields no pages. The client sends `limit` only when the caller passed it. Stripe's default is 10. The allowed range is 1 to 100.

`read("GetCustomersCustomer", { path: { customer } })` is `GET /v1/customers/{customer}`.

```json
{
  "stripe": {
    "config": {},
    "secret_refs": { "api_key": "stripe_api_key" }
  }
}
```

Reference: <https://docs.stripe.com/api/customers/list> and <https://docs.stripe.com/keys/restricted-api-keys>
