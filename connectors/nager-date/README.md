# @puppi/adapter-nager-date

Source connector for Nager.Date public holidays. No key. `publicHolidays(year, countryCode)` is one year's holidays for an ISO 3166-1 alpha-2 code. `next(countryCode)` is the next 365 days for one country. A country the service does not cover is a 404, and both methods return `null`. `availableCountries()` lists covered countries. `nextWorldwide()` is the next holidays across every covered country.

`base_url` defaults to `https://date.nager.at/api/v3`. There is no secret. `check()` calls `GET /AvailableCountries`.

```json
{
  "nager-date": {
    "config": {}
  }
}
```

```ts
client.publicHolidays(2026, "DE");
```

Reference: <https://nagerholidays.com/api>
