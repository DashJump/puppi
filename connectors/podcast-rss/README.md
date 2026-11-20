# @puppi/adapter-podcast-rss

Source connector for podcast RSS 2.0 and Atom 1.0 documents. `episodes({ feed_url })` yields `podcasts/episodes` rows. `feed_url` is the feed's canonical URL and is hashed into `feed_id`. A cursor may point at another page of that same feed and is passed with the same `feed_url`. One binding reads many feeds. A producer that walks more than one feed keeps a separate checkpoint for each `feed_url`. The wire body is XML. The client normalizes it before the shared HTTP client, which only decodes JSON. A BOM selects the encoding, then the Content-Type charset, then the XML declaration, then UTF-8. An unrecognized charset is read as UTF-8.

## Config

The binding has no feed URL. User agent, the request timeout, and rate-limit waits stay on the HTTP client. There is no secret and no API version.

```json
{
  "podcast_rss": {
    "config": {}
  }
}
```

`check()` does not GET a feed. The call that names `feed_url` does. Tests use the fixtures under `test/fixtures/` and do not call the network.

## Rows

An `Episode` is a `podcasts/episodes` row:

| Column | Value |
|---|---|
| `episode_id` | The item guid, or the hex SHA-256 of `feed_id` + `audio_url` with nothing between them |
| `feed_id` | Hex SHA-256 of the `feed_url` argument (the rss URL) |
| `guid` | The item guid, or `episode_id` when the item has none |
| `title` | Item title, or `""` |
| `description` | `content:encoded`, then `description`, then `summary` |
| `published_at` | ISO 8601. The append watermark |
| `audio_url` | Enclosure URL. An audio type is preferred over video |
| `audio_type` | Enclosure MIME type, or null |
| `audio_bytes` | Enclosure length when it is a safe integer, or null |
| `duration_sec` | Seconds, or null. Accepts an integer, `hh:mm:ss`, or `mm:ss` |
| `episode_url` | Show-notes link, or null |
| `season`, `episode_n` | Whole numbers, or null |
| `observed_at` | ISO 8601 client clock when the page was read |

An item with no enclosure URL or no parseable publish date is skipped, so `audio_url` and `published_at` are always set. A `rel="next"` link is the next page. `limit` slices one document; pass that cursor back to resume.
