# @puppi/adapter-nager-date

Source connector for Nager.Date public holidays. No key. `publicHolidays(year, countryCode)` is one year's holidays for an ISO 3166-1 alpha-2 code. `next(countryCode)` is the next 365 days for one country. A country the service does not cover is a 404, and both methods return `null`. A covered country with no holiday in that window answers 204, and `next` returns `[]`. `availableCountries()` lists covered countries.

`base_url` defaults to `https://nagerholidays.com`. There is no secret. `check()` calls `GET /api/v4/Countries/Available`.

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
