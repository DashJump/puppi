# @puppi/adapter-github

Source connector for GitHub repository issues. `issues({ owner, repo })` walks `GET /repos/{owner}/{repo}/issues`, including pull requests. `cursor` is the `Link: rel="next"` URL. The last page yields a null cursor. `perPage`, `state`, and `since` are sent only when the caller passed them. GitHub's default `state` is `open`.

Auth is a bearer token. Secret `token` is that token. `api_version` defaults to `2022-11-28` and is sent as `x-github-api-version`. `base_url` defaults to `https://api.github.com`. `check()` calls `GET /user`.

```json
{
  "github": {
    "config": {},
    "secret_refs": { "token": "github_token" }
  }
}
```

```ts
client.issues({ owner: "acme", repo: "app" });
```

Reference: <https://docs.github.com/en/rest/issues/issues#list-repository-issues>
