# `@puppi/cli`

`puppi` builds a TypeScript pipeline, deploys it, and reads what the engine recorded. You need Node.js 26 or newer. Install and preview with the [quickstart](https://puppi.dev/docs/quickstart/). The HTTP API is <https://puppi.dev/docs/api/>. Every flag is in the [CLI reference](https://puppi.dev/docs/reference/cli/).

## Install and preview

```bash
npm install -g @puppi/cli@0.2.2
puppi init my-pipeline
cd my-pipeline
npm install
puppi build
puppi try example/people
```

`puppi init` writes `README.md`, `puppi.config.ts`, `src/pipeline.ts`, `bindings.local.json`, `package.json`, `tsconfig.json`, and `.gitignore`. The connection is `files` (`@puppi/adapter-filesystem`). `bindings.local.json` sets `root` to `out/files`. The assets are `example/people` and `core/person`. `puppi build` writes `out/bundle.js`, `out/manifest.json`, and `puppi-env.d.ts`. `puppi try example/people` prints Ada and Grace, then `Ran locally. Nothing was written.`

`puppi try` previews one producer on this machine. It reads `bindings.local.json`. It does not place an environment. The hosted service does not read that file.

The scaffold prints `puppi login`, `puppi deploy`, `puppi run`, and `puppi status` next. Those commands talk to `https://app.puppi.dev`. This README does not run them.

## Hosted commands

These need the key from `puppi login`. With no `--env` and no `PUPPI_ENV`, `deploy`, `run`, and `status` use the environment `default`. The first deploy creates it with executor `hosted`. The commands below name `prod` so they do not fall through to `default`.

```bash
puppi login
puppi env create prod --executor hosted
export PUPPI_ENV=prod
puppi deploy --env prod
puppi run --wait --env prod
puppi status --env prod
```

Pass `--executor hosted` for Puppi-managed execution. Pass `--executor remote` for a worker pool you run. One word. The public API refuses `local` with `403` `local_not_allowed`.

`puppi doctor` checks that the engine answers, the token is accepted, and this project's SDK matches the engine.

## Read a run

`assets`, `lineage`, `logs`, and `rollback` exit 2 without `--env` or `PUPPI_ENV`. They do not fall back to `default`. The keys below are independent of the scaffold. Replace `core/customer` with an asset key from `puppi assets --env prod`. `--allow-contract-change` needs an existing asset whose declared schema changed. Activate and rollback are in [Deploy and rollback](https://puppi.dev/docs/concepts/deploy/).

```bash
puppi assets --env prod
puppi assets core/customer --env prod
puppi logs <run-id> --env prod
puppi lineage core/customer --env prod
puppi rollback core/customer --env prod
puppi rollback core/customer --env prod --to <materialization-id>
```

`puppi run --wait --timeout 900 --env prod` stops waiting after 900 seconds. The run keeps going and the command exits 3. `--force` bypasses the staleness gate.

`puppi run cancel <run-id>` cancels a queued or running run and prints `run <run-id> <status>`. A queued run is `cancelled` at once. A running run gets 30 seconds to stop, and the command prints `run <run-id> running, cancel requested`. Running the cancel again while it stops exits 0. Cancelling a run that already finished exits 1.

`puppi run --wait`, `puppi status`, and `puppi rollback` exit 4 when the run is `cancelled`.

## Build

```bash
puppi build
puppi deploy --env prod
puppi deploy --env prod --no-activate
puppi deploy --env prod --allow-contract-change core/customer
```

`puppi build` writes `puppi-env.d.ts`, then runs `tsc --noEmit`. A type error fails the build, so `puppi deploy` uploads nothing. Repeat `--allow-contract-change` for each asset whose schema change a strict environment must accept.

`puppi deploy` builds, uploads the bundle if needed, and ingests the manifest. The routes are in the [HTTP API](https://puppi.dev/docs/api/). A rejected manifest exits 1 and leaves the environment unchanged.

`puppi run` prints the run id and returns. `puppi status --run <id> --env prod` follows it.

## Environments

`puppi env list` and `puppi env create <name>` do not read `--env`. `show`, `bind`, `unbind`, `secret`, `pause`, and `resume` need `--env` or `PUPPI_ENV`.

```bash
puppi env list
puppi env create prod --executor hosted
puppi env show --env prod
puppi place hosted
```

`puppi place hosted` sets hosted on every environment. `puppi place remote` sets remote on every environment. `puppi place local` is refused with `403` `local_not_allowed`.

### Bind a declared connection

Independent of the filesystem scaffold. The project must declare `warehouse` as `@puppi/adapter-postgres`, and `PGPASSWORD` must be set.

```bash
puppi env secret warehouse_password --env prod --from-env PGPASSWORD
puppi env bind warehouse --env prod \
  --config '{"host":"db.example.com","database":"warehouse","port":5432}' \
  --secret-ref password=warehouse_password \
  --type postgres
```

A secret's value goes in and does not come back.

### Delete or pause

These are not setup steps.

```bash
puppi env unbind scratch --env prod
puppi env secret drill_note --env prod --forget
puppi env pause --env prod
puppi env resume --env prod
```

## A connector package

```bash
puppi connector new acme
cd acme
npm install
npm test
```

`npm test` checks that the package exports the source interface. The steps and the limit of that test are <https://puppi.dev/docs/connectors/new/>.

## Sign-in

`--env <name>` or `PUPPI_ENV` names the environment. `--engine-url` or `PUPPI_ENGINE_URL` names the server. The default in `puppi help` is `https://app.puppi.dev`. `puppi login` stores a per-user key at `~/.config/puppi/config.json` (mode `0600`). That key is sent only to the origin it was saved for. `puppi logout` revokes the stored key and deletes the file.

Exit codes: `0` finished, `1` the engine refused or the run did not succeed, `2` usage, `3` `puppi run --wait --timeout` returned while the run was still going, `4` the run was cancelled.
