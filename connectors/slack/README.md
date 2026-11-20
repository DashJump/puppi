# @puppi/adapter-slack

Source connector for the Slack Web API. `conversations()` walks `conversations.list`. `cursor` is `response_metadata.next_cursor`. An empty cursor ends the walk.

Auth is a bearer bot token. Secret `bot_token` is that token. `base_url` defaults to `https://slack.com/api`. The package lists `unversioned` and sends no version header. A refusal is HTTP 200 with `{ ok: false, error }`, which is thrown, or a failed `check()`. `check()` calls `GET /conversations.list?limit=1`.

```json
{
  "slack": {
    "config": {},
    "secret_refs": { "bot_token": "slack_bot_token" }
  }
}
```

```ts
client.conversations();
```

Reference: <https://docs.slack.dev/reference/methods/conversations.list/>
