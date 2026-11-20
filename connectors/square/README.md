# @puppi/adapter-square

Source connector for the Square Connect API. It reads locations, payments, customers, orders, and refunds. Auth is a bearer access token. Every request sends `Square-Version`.

The pinned version is `2026-09-16`, the `Square-Version` default in Square's published OpenAPI document (commit `79ccc3f89e1527f7b943cc2f6628b6098572583e` of [connect-api-specification](https://github.com/square/connect-api-specification/blob/79ccc3f89e1527f7b943cc2f6628b6098572583e/api.json)). A binding that sets `api_version` must use that value. The header overrides the application's default version in the Developer Console.

`base_url` defaults to `https://connect.squareup.com`. Sandbox is `https://connect.squareupsandbox.com`. A production token against Sandbox, or the reverse, is `UNAUTHORIZED`.

`access_token` is sent as `Authorization: Bearer`. A personal access token has full access to that Square account. An OAuth access token uses the same header. This client does not refresh tokens. An OAuth token needs `MERCHANT_PROFILE_READ` for locations, `PAYMENTS_READ` for payments and refunds, `CUSTOMERS_READ` for customers, and `ORDERS_READ` for orders.

The pinned file is that document trimmed to `GET /v2/locations`, `GET /v2/payments`, `GET /v2/customers`, `POST /v2/orders/search`, and `GET /v2/refunds`. The published document references `AppFeeAllocation` and `CurrencyExchange` and does not define them, so the trim drops `Payment.app_fee_allocations`, `Payment.buyer_currency_exchange`, and `PaymentRefund.app_fee_allocations`.

`check()` calls `GET /v2/locations`. It proves the token can list locations.

`locations()` is `GET /v2/locations`. Inactive locations are included. The response has no cursor.

`payments({ query, limit, cursor })` is `GET /v2/payments`. `cursor` is the response `cursor`, sent back as the `cursor` query parameter. The last page omits `cursor`. Omitting `begin_time` lists payments from the last year.

`customers({ query, limit, cursor })` is `GET /v2/customers`. The cursor works the same way. Profiles without a public name, company, email, or phone are omitted. An empty account is `{}`.

`orders({ locationIds, query, limit, cursor })` is `POST /v2/orders/search`. The POST only reads. `locationIds` is `location_ids`. `cursor` goes in the JSON body with the same locations, query, and limit. `return_entries` is not sent, so each row is an order.

`refunds({ query, limit, cursor })` is `GET /v2/refunds`. The cursor works the same way as payments. Omitting `begin_time` lists refunds from the last year.

A cursor expires after 5 minutes.

```json
{
  "square": {
    "config": {},
    "secret_refs": { "access_token": "square_access_token" }
  }
}
```

Reference: <https://developer.squareup.com/reference/square>
