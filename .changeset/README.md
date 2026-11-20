# Publish @puppi packages

`pnpm publish:packages` uploads the public packages to `registry.npmjs.org`. `.github/workflows/publish.yml` is the same command, started with `workflow_dispatch` from `master`. Provenance stays off. A push or a tag does not publish.

## Dry run

From the repo root, after `pnpm -r build`:

```bash
pnpm publish:dry-run
```

The script prints each package name, its version, and the file list from `pnpm publish --dry-run`. It does not upload. It does not print `NPM_TOKEN`.

## Publish

1. Check out `master`.
2. Run `pnpm -r build`.
3. Export `NPM_TOKEN` in the shell. The token publishes packages in the `puppi` organization on `registry.npmjs.org`. Do not pass the token as an argument.
4. Run `pnpm publish:packages`.

The script publishes with `--access public`. The set is every workspace package that is not `private`, dependencies first: a package is published after the workspace packages named in its `dependencies`. It skips a version already on the registry. It exits if `.changeset/` has a `*.md` file other than this README.

`workspace:*` stays in git. `pnpm publish` rewrites it to the current version in the package npm receives.

## Cut a version

On `master`, after the change is merged:

1. Run `pnpm changeset` and select the public packages that changed.
2. Run `pnpm changeset version`. That bumps those versions and writes each package's `CHANGELOG.md`.
3. Run `pnpm install`. That refreshes `pnpm-lock.yaml`.
4. Commit the version bump and merge it to `master`.
5. Run `pnpm publish:packages` with `NPM_TOKEN` set.
