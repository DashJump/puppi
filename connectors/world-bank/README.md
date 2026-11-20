# @puppi/adapter-world-bank

Source connector for the World Bank Indicators API. No key. `countries()` pages countries and aggregates. `indicator(code, options)` pages one indicator. Each page is a `[meta, rows]` pair. A query that matches nothing yields no rows. `cursor` is the next page number.

`mrv` asks for the most recent N values per country. `date` is a year or a `2000:2020` range. `countries` is a `;`-separated code list, `all` by default.

`base_url` defaults to `https://api.worldbank.org/v2`. There is no secret. `check()` reads the first page of countries.

```json
{
  "world-bank": {
    "config": {}
  }
}
```

```ts
client.indicator("SP.POP.TOTL", { mrv: 1 });
```

Reference: <https://datahelpdesk.worldbank.org/knowledgebase/articles/889392>
