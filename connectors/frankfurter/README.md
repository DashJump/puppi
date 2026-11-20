# @puppi/adapter-frankfurter

Source connector for Frankfurter, the ECB reference exchange rates. No key. Rates are published on TARGET business days, so `latest` on a weekend carries Friday's date.

`latest({ base, symbols })` is the most recent rates. `base` defaults to EUR. `series({ start, end, base, symbols })` is every published day from `start` through `end`. Omit `end` for today. `on(date)` is one ISO date, or the previous business day when that date is a weekend or holiday. `currencies()` is code to currency name.

`base_url` defaults to `https://api.frankfurter.dev/v1`. There is no secret. `check()` calls `GET /currencies`.

```json
{
  "frankfurter": {
    "config": {}
  }
}
```

```ts
client.latest({ base: "USD", symbols: ["EUR", "GBP"] });
```

Reference: <https://frankfurter.dev/>
