# @puppi/adapter-podcast-index

Source connector for the [Podcast Index API](https://podcastindex-org.github.io/docs-api/). `show` and `shows` resolve feeds. `episodes` lists episodes for a feed id, a feed URL, or the shows a search matched. Rows are `Show` and `Episode` in `src/index.ts`.

## Credentials

This package does not include a key. Sign up at <https://api.podcastindex.org>; the account page issues an API key and a secret.

Every request sends three headers, and `X-Auth-Date` is the unix time in seconds, refreshed on each request (the API allows about three minutes of clock skew):

| Header | Value |
|---|---|
| `X-Auth-Key` | the API key |
| `X-Auth-Date` | unix time, seconds |
| `Authorization` | `sha1(apiKey + apiSecret + X-Auth-Date)` as lowercase hex |
| `User-Agent` | `puppi-adapter-podcast-index/0.1 (...)` |

The connector names one secret, `api_key`, because that is the value sent as `X-Auth-Key`. `api_secret` is never sent. The client still reads it from the binding. Add both `secret_refs`. Both resolved values are passed to the client.

```json
{
  "podcast_index": {
    "config": {},
    "secret_refs": {
      "api_key": "podcast_index_key",
      "api_secret": "podcast_index_secret"
    }
  }
}
```

In `bindings.local.json`, point those names at the environment:

```json
"secrets": {
  "podcast_index_key": { "env": "PODCAST_INDEX_KEY" },
  "podcast_index_secret": { "env": "PODCAST_INDEX_SECRET" }
}
```

A missing secret is signed as an empty string. The API answers 401, and `check()` reports that as authentication (`GET /categories/list`). Tests use the fixtures under `test/fixtures/` and do not call the live API.

`max` on an episode list defaults to 1000, which is the most one call returns. A full window of 1000 throws, because the API has no token for whatever is older. `shows({ query })` returns one search window and `cursor` is null; a full window does not throw. `episodes({ query })` uses the first `feedLimit` matches from that search, 10 when omitted, and throws above 200 ids.

## Feeds dump

`feedsDump()` downloads `https://public.podcastindex.org/podcastindex_feeds.db.tgz`, the weekly snapshot of every live feed, and returns the response body as a stream: a gzipped tar holding one SQLite file. The request is not signed, because the host is public; it sends the connector `User-Agent`, which that host requires. The connector does not unpack or read it. A 404 throws `NotFound`; any other non-2xx throws `HttpStatusError`. If the body is cut short, and the response has no `Content-Encoding` or it is `identity`, the stream asks for the rest with `Range` and `If-Range` and carries on from that byte. It gives up after three tries in a row that bring no new byte, after 20 resumes, when the host answers with the whole file instead, when the resumed range does not start at the bytes already read or end on the last byte, when the finished stream is short of a known total, or when the response is compressed.

## Rows

`Show` is a `podcasts/feeds` row. `feed_id` is the hex SHA-256 of `rss_url` in every case, the same key the RSS connector uses. The index id is only `podcast_index_id`. `known` is true. The API has no `subject_id` and no `added_at`, so those columns are not on the row.

`Episode` is a `podcasts/episodes` row, the same columns the RSS connector writes. A lookup that only has a feed id loads that show's rss URL first. `episode_id` is the item `guid` when the item has one, otherwise the hex SHA-256 of `feed_id` + `audio_url` with nothing between them, and `guid` is that same hash. `audio_url` is the enclosure. `published_at` is the append watermark; the next poll passes that time, in unix seconds, as `since`. `observed_at` is when this client read the row. An item with no enclosure URL or no `datePublished` is skipped.
