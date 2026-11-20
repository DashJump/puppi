# @puppi/adapter-zendesk-support

Source connector for the Zendesk Support API. `tickets()` walks the ticket list by following `links.next`. `cursor` is that absolute URL. The last page yields a null cursor.

The client sends `page[size]`. Without it, Zendesk answers with offset pages, which omit `links.next`, and the walk stops after the first hundred tickets. The default is Zendesk's maximum of 100. Pass `pageSize` to send a different size.

Auth is HTTP Basic of `{email}/token:{api_token}`. Config `email` is the username. Secret `api_token` is the password. `subdomain` is the account (`acme` becomes `acme.zendesk.com`). `base_url` replaces that host. `api_version` defaults to `v2` and is the `/api/<version>` prefix. `check()` calls `GET /users/me`.

```json
{
  "zendesk-support": {
    "config": { "subdomain": "acme", "email": "ada@acme.example" },
    "secret_refs": { "api_token": "zendesk_api_token" }
  }
}
```

```ts
client.tickets();
```

Reference: <https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/#list-tickets>
