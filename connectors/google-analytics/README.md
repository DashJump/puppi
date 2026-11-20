# @puppi/adapter-google-analytics

Source connector for the Google Analytics Data API. It reads a GA4 property's metadata and pages a core report. Auth is a bearer access token. The token needs `https://www.googleapis.com/auth/analytics.readonly`, and the Google account that minted it needs access to the property.

The API version is the `v1beta` prefix of the base URL. `base_url` defaults to `https://analyticsdata.googleapis.com`. A binding that omits `api_version` uses `v1beta`. `property_id` is the numeric property id, such as `123456789`.

The spec is the discovery document <https://analyticsdata.googleapis.com/$discovery/rest?version=v1beta> revision `20261111`, trimmed to `properties.runReport` and `properties.getMetadata`. Google publishes that discovery document, not OpenAPI. Paths are its `flatPath` with the `v1beta` prefix removed. The path parameter is the numeric id (`{propertiesId}` on the flat path).

`check()` and `getMetadata()` call `GET /v1beta/properties/{property}/metadata`. `getMetadata()` returns the property's dimensions, metrics, and comparisons.

`runReport({ body, cursor })` calls `POST /v1beta/properties/{property}:runReport`. `body` is a run-report request without `offset`. `limit` is an int64 string and is sent only when `body` includes it. The API's default limit is 10,000 rows and the maximum is 250,000. `cursor` is the next row offset, a decimal string, or null on the last page. The first request omits `offset`. The next offset is the offset this request sent plus the number of rows it returned. The walk stops when that reaches `rowCount`. A page with no rows, or a response without `rowCount`, ends the walk.

A row is an object keyed by the dimension names, then the metric names. Values are the strings the API sent. A missing cell is null.

The walk does not return `metadata`. A report can be sampled (`metadata.samplingMetadatas`), thresholded (`metadata.subjectToThresholding`), or roll dimension combinations into an `(other)` row (`metadata.dataLossFromOtherRow`). Those flags stay on the raw response.

Quotas are in the [Data API quotas](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas). `runReport` and `getMetadata` both spend Core tokens. A standard property allows 200,000 core tokens a day, 40,000 an hour, 14,000 an hour for one Cloud project on that property, and 10 concurrent requests. Analytics 360 allows 2,000,000 a day, 400,000 an hour, 140,000 an hour per project, and 50 concurrent requests. Most requests cost 10 tokens or fewer. The cost depends on the row count, the dimensions and metrics, the filters, the date range, cardinality, and how many events the property has. Daily quotas refresh at midnight Pacific. A request past a token or concurrency quota is `429`. A standard property also allows 10 server errors (`500` and `503`) per project per hour, and 360 allows 50. Properties allow 120 potentially thresholded requests an hour. `userAgeBracket`, `userGender`, `brandingInterest`, `audienceId`, and `audienceName` count toward that limit.

The product docs call this the Data API v1. The reporting methods are on the `v1beta` discovery document, which is the channel where Google does not expect breaking changes. `v1alpha` is a separate document and can break. A discovery document named `v1` lists long-running operations only, not `runReport` or `getMetadata`. This package sends `v1beta`.

```json
{
  "google-analytics": {
    "config": { "property_id": "123456789" },
    "secret_refs": { "access_token": "ga_access_token" }
  }
}
```

Reference: <https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport>
