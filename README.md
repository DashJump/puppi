# Puppi

Puppi runs data pipelines you write in TypeScript. The CLI builds a project, deploys it, and starts a run.

You need Node.js 26 or newer.

## Install

```bash
npm install -g @puppi/cli@0.2.1
```

`puppi help` lists the commands. There is no `--version` flag.

## Start a pipeline

1. Create a project.

   ```bash
   puppi init my-pipeline
   ```

   The command writes `README.md`, `puppi.config.ts`, `src/pipeline.ts`, `bindings.local.json`, `package.json`, `tsconfig.json`, and `.gitignore`. The connection is `files` (`@puppi/adapter-filesystem`). `bindings.local.json` sets `root` to `out/files`. The assets are `example/people` and `core/person`. `package.json` depends on `@puppi/sdk` at `^0.4.0`. `@puppi/adapter-filesystem`, `@puppi/cli`, and `typescript` are devDependencies.

2. Install the project's packages.

   ```bash
   cd my-pipeline
   npm install
   ```

3. Log in. The default server is `https://app.puppi.dev`. The command prints a URL and a code, opens the browser, and stores the key at `~/.config/puppi/config.json` (mode `0600`).

   ```bash
   puppi login
   ```

4. Deploy. `puppi deploy` builds, uploads the bundle, and activates it. With no `--env` and no `PUPPI_ENV`, it creates the hosted environment `default` the first time and reuses it after that.

   ```bash
   puppi deploy
   ```

5. Start a run, then print the last one.

   ```bash
   puppi run
   puppi status
   ```

   `puppi run` triggers the whole graph and prints the run id. `puppi status` prints the last run, per attempt.

The guide is <https://puppi.dev/docs/quickstart/>.
