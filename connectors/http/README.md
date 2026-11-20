# @puppi/adapter-http

A JSON connection for an API that has no connector of its own.

`get(path, params)` sends `GET <base_url><path>` and decodes the body as JSON. `base_url` is the host the binding sets. `headers` is a JSON object added to every request.

Secrets are optional. `bearer_token` is sent as `Authorization: Bearer`. `api_key` is sent as the header named by `api_key_header` (default `x-api-key`), or as the query parameter named by `api_key_query` when that field is set. An empty secret sends nothing.

```json
{
  "http": {
    "config": {
      "base_url": "https://api.example.com",
      "headers": { "x-tenant": "acme" }
    },
    "secret_refs": { "bearer_token": "http_bearer_token" }
  }
}
```

```ts
import * as http from "@puppi/adapter-http";
import { defineConfig } from "@puppi/sdk";

export default defineConfig({
  connections: { api: http },
});
```
