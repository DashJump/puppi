# @puppi/adapter-s3

Files and Parquet tables in [S3-compatible object storage](https://docs.aws.amazon.com/AmazonS3/latest/API/API_Operations.html): AWS S3, Cloudflare R2, and MinIO. Files are `put`, `get`, `head`, and `drop`. A table materialization is one Parquet object: `write`, `read`, `query`, and `drop`. `prefix` applies to file keys, not to those Parquet objects. A producer can also put and head objects it names itself.

A file asset's storage calls `put(storageRef, body, { contentType })`, `get(storageRef)`, `head(storageRef)`, and `drop(storageRef)`. `put` hashes the body while uploading and returns `{ sha256, bytes, contentType }`. `get` is the byte stream. `head` is the size and content type, or null when the key is missing. `drop` deletes the object, and a second drop is a no-op. The argument is the storage ref. The binding prefix applies to file keys.

`putStream` is that upload, and what `ctx.connection` calls with a key the producer chose. It returns `{ bytes, sha256, etag }`. A body under 8 MiB is one PUT. A larger body is a multipart upload, held one part at a time, and aborted if the upload fails. `contentLength` only chooses that part size. `exists` is `head`. `close` is a no-op.

An endpoint (R2, MinIO) is path-style. With no endpoint the client uses virtual-hosted AWS. `region` defaults to `us-east-1`; R2 uses `auto`.

Requests are signed with SigV4. `access_key_id`, `secret_access_key`, and an optional `session_token` are secrets, never config. The table store also reads `force_path_style` (path style when an endpoint is set, unless the binding says otherwise). File keys are path-style whenever an endpoint is set.

```json
{
  "audio_store": {
    "config": {
      "bucket": "podcasts",
      "region": "auto",
      "endpoint": "https://<account>.r2.cloudflarestorage.com",
      "prefix": "audio"
    },
    "secret_refs": {
      "access_key_id": "audio_access_key",
      "secret_access_key": "audio_secret_key"
    }
  }
}
```

Omit `endpoint` for AWS. A 403 from a bad key is terminal. 429, 5xx, and a dropped connection are tried three more times, then raised with the HTTP status so the attempt can classify them.
