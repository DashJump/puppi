# @puppi/adapter-postgres

Storage adapter for Postgres. One materialization is one table. Neon and Supabase use the same client.

## Config

| Field | Type | Meaning |
| --- | --- | --- |
| `host` | string | Default `127.0.0.1` when `url` is unset |
| `port` | integer | Default `5432` when `url` is unset |
| `database` | string | Default `postgres` when `url` is unset |
| `user` | string | Default `postgres` when `url` is unset |
| `ssl` | boolean | Driver `ssl`. Refused when the url sets `sslmode` and `ca` is unset |

`password`, `url`, and `ca` are secrets. `password` goes with `host`, `port`, `database`, and `user`. `url` is the whole connection string. `ca` is the PEM of a CA the server certificate must chain to, including the `BEGIN CERTIFICATE` and `END CERTIFICATE` lines.

When `ca` is set, the certificate chain and the server name are both checked. `ssl: false` and `sslmode=disable` are refused. A `sslmode` in the url does not turn that check off.

When `ca` is unset, `require`, `prefer`, and `verify-ca` check the chain and the server name against the system trust store. `sslrootcert` is a filesystem path, not PEM text. A Fly Postgres certificate is not in that trust store, so the connection fails with `self-signed certificate in certificate chain` until `ca` is set.

Do not rely on `channel_binding=require` for fail-closed channel-binding enforcement.

An empty `url`, `ssl`, or `ca` is unset. `puppi init` writes an empty string where it has no local default.

### Host

```json
{
  "warehouse": {
    "config": {
      "host": "127.0.0.1",
      "port": 5432,
      "database": "app",
      "user": "postgres"
    },
    "secret_refs": { "password": "warehouse_password" }
  }
}
```

### Neon or Supabase

```json
{
  "warehouse": {
    "secret_refs": { "url": "warehouse_url" }
  }
}
```

`warehouse_url` is the connection string, password included. Set `ssl: true` only when that string has no `sslmode`. A Neon string already has `sslmode=require`. Neon's certificate is in the system trust store, so `ca` stays unset.

### Fly Postgres

```json
{
  "warehouse": {
    "secret_refs": {
      "url": "warehouse_url",
      "ca": "warehouse_ca"
    }
  }
}
```

`warehouse_ca` is the Fly Postgres CA certificate. The connection checks the server certificate against that PEM and checks the server name. Leave `ssl` unset. The url may keep `sslmode=require`.
