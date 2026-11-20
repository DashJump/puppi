# @puppi/adapter-usgs

Source connector for the USGS earthquake catalog. No key. `earthquakes(params)` reads `GET /query` as GeoJSON and returns one flat row per event. `count(params)` is how many events match. The catalog is revised for days after an event, so a window re-read is not the same twice.

`base_url` defaults to `https://earthquake.usgs.gov/fdsnws/event/1`. There is no secret. `check()` calls `GET /count?format=geojson`.

```json
{
  "usgs": {
    "config": {}
  }
}
```

```ts
client.earthquakes({
  starttime: "2026-09-09",
  endtime: "2026-09-16",
  minmagnitude: 4.5,
  orderby: "time",
});
```

Reference: <https://earthquake.usgs.gov/fdsnws/event/1/>
