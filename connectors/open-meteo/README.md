# @puppi/adapter-open-meteo

Source connector for Open-Meteo. No key. Three hosts, each a binding field with a default:

| Field | Default |
| --- | --- |
| `base_url` | `https://api.open-meteo.com` |
| `geocoding_url` | `https://geocoding-api.open-meteo.com` |
| `archive_url` | `https://archive-api.open-meteo.com` |

`current(locations)` is current conditions. `daily(locations)` is a daily forecast. `archive(location, { start, end })` is historical daily values between two ISO dates. `geocode(name)` searches places. There is no secret. `check()` searches the geocoding host for Berlin.

```json
{
  "open-meteo": {
    "config": {}
  }
}
```

```ts
client.current([{ latitude: 52.5, longitude: 13.4 }], {
  variables: ["temperature_2m", "weather_code", "wind_speed_10m"],
});
```

Reference: <https://open-meteo.com/en/docs>
