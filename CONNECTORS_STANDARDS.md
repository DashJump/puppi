# Connector standards

Review bar for a pull request that changes a catalog connector. Check every item.

- Tests cover the change. Bodies live in `test/fixtures/`, `fetch` is injected, and CI does not call the network.
- Error handling and retry classification use a structured status or error code, never message text, and the HTTP kit's hooks (`responseError`, `reshape`, `extract`, `expiredPageToken`).
- Writes are idempotent. A repeated write leaves the same stored result.
- Docs and the `docs` field on the default export are updated when behavior or config changes.
- `src/openapi.ts` and `src/operations.ts` come from `pnpm generate` and are not hand-edited. `openapi.json` is the vendor spec used as published, trimmed only to the operations this package calls, with vendor fields left as they are and no `x-` extensions.
- The pull request touches exactly one `connectors/<name>/` directory and no shared file.
- `runSourceConformance` passes, and CI is green.
