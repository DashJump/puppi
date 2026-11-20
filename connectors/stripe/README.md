# @puppi/adapter-stripe

Source connector for the Stripe Customers API. `customers()` walks `GET /v1/customers`. `cursor` is the last customer id from the previous page, sent back as `starting_after`. The last page yields a null cursor.

Auth is a bearer key. Secret `api_key` is that key. `api_version` defaults to `2024-06-20` and is sent as `stripe-version`. `base_url` defaults to `https://api.stripe.com`. `check()` calls `GET /v1/customers?limit=1`.

```json
{
  "stripe": {
    "config": {},
    "secret_refs": { "api_key": "stripe_key" }
  }
}
```

```ts
client.customers();
```

Reference: <https://docs.stripe.com/api/customers/list>
