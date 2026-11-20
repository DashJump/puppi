/**
 * `puppi init`: a project that builds, so that the first thing a user writes
 * is a pipeline rather than a connection declaration.
 *
 * The scaffold is deliberately small. `puppi.config.ts` imports
 * `@puppi/adapter-filesystem` and passes it to `defineConfig`. The source
 * emits hard-coded rows. Those rows are Parquet on the hosted service.
 * `config_schema` and `secret_fields` come from that module when the project
 * is built. The local binding writes `root` directly: the adapter declares
 * `{ root: "string" }` and no secret, and this command does not load it.
 * The tsconfig `include` that makes `puppi-env.d.ts` visible is written
 * here, and so is `bindings.local.json`, which `puppi try` reads and which
 * is not deployed.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, resolve } from "node:path";

import { type Args, has } from "./args.js";
import { type Command, type Outcome, done, helpBlock } from "./command.js";
import { heading, note, out } from "./print.js";
import { scaffoldVersions } from "./scaffold-versions.js";
import { writeScaffold } from "./scaffold.js";

/** Path resolution only; `import.meta.resolve` is absent under Vite's SSR transform. */
const fromHere = createRequire(import.meta.url);

const DEFAULT_CONNECTION = "files";
const ADAPTER = "@puppi/adapter-filesystem";
/** A directory on this machine for `puppi try`. The hosted service does not read this file. */
const LOCAL_ROOT = "out/files";

interface InitResult {
  target: string;
  files: string[];
}

async function initCommand(args: Args, dir: string): Promise<Outcome<InitResult>> {
  const target = resolve(args.positional[0] ?? dir);
  const files = scaffold(basename(target));

  await writeScaffold(
    target,
    files,
    has(args, "force"),
    "`puppi init --force` overwrites, or init into an empty directory",
  );

  return done({
    target,
    files: [...files.keys()].sort(),
  });
}

function renderInit(row: InitResult): void {
  heading("init", "A project that writes two hard-coded people to Parquet on the hosted service.");

  for (const path of row.files) note(path);

  out();
  note(`next:  cd ${row.target}`);
  note("       npm install                 # or pnpm, or bun");
  note("       puppi login");
  note("       puppi deploy");
  note("       puppi run");
  note("       puppi status");
  out();
}

function scaffold(name: string): Map<string, string> {
  return new Map([
    ["README.md", readme(name)],
    ["puppi.config.ts", config()],
    ["src/pipeline.ts", PIPELINE],
    ["bindings.local.json", bindings(name)],
    ["package.json", packageJson(name)],
    ["tsconfig.json", TSCONFIG],
    [".gitignore", GITIGNORE],
  ]);
}

function readme(name: string): string {
  return `# ${name}

A pipeline that writes two hard-coded people to Parquet through \`@puppi/adapter-filesystem\`.

\`\`\`bash
npm install
puppi login
puppi deploy
puppi run
puppi status
\`\`\`

\`puppi deploy\` creates the hosted environment \`default\` when \`--env\` and \`PUPPI_ENV\` are omitted. A later deploy reuses it. \`puppi run\` starts a run of the graph. \`puppi status\` prints that run.

The default server is \`https://app.puppi.dev\`.

A Postgres source is the next step.
`;
}

function config(): string {
  const imports = `import * as filesystem from ${JSON.stringify(ADAPTER)};
import { defineConfig } from "@puppi/sdk";`;

  return `${imports}

export default defineConfig({
  entry: "src/pipeline.ts",
  out: "out",
  defaultStorage: ${JSON.stringify(DEFAULT_CONNECTION)},
  connections: {
    ${JSON.stringify(DEFAULT_CONNECTION)}: filesystem,
  },
});
`;
}

/**
 * `puppi try` reads this file on this machine. The hosted service does not.
 * The filesystem adapter declares `{ root: "string" }` and no secret. The
 * binding is that field. Init does not load the adapter; the project installs it.
 */
function bindings(name: string): string {
  return json({
    environment: name,
    bindings: {
      [DEFAULT_CONNECTION]: { config: { root: LOCAL_ROOT } },
    },
    secrets: {},
  });
}

function packageJson(name: string): string {
  return json({
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      build: "puppi build",
      typecheck: "puppi build",
    },
    dependencies: { "@puppi/sdk": pinned("@puppi/sdk") },
    devDependencies: {
      [ADAPTER]: pinned(ADAPTER),
      "@puppi/cli": pinned("@puppi/cli"),
      typescript: "^5.6.3",
    },
  });
}

/**
 * `@puppi/cli` and `@puppi/adapter-filesystem` come from `scaffold-versions.ts`,
 * which `scripts/write-versions.mjs` copies from each package.json. The CLI's
 * exports hide `./package.json`, and the adapter is not installed beside this
 * package. `@puppi/sdk` resolves, because it exports `./package.json`.
 */
function pinned(pkg: string): string {
  const found = scaffoldVersions[pkg] ?? version(pkg);

  if (!found) throw new Error(`puppi init has no version for ${pkg}`);

  return `^${found}`;
}

function version(pkg: string): string | undefined {
  try {
    const path = fromHere.resolve(`${pkg}/package.json`);

    return (JSON.parse(readFileSync(path, "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

const PIPELINE = `/**
 * Your first pipeline.
 *
 *   example/people ──▶ core/person
 *
 * \`puppi build\` bundles this file, loads it for these declarations, and runs
 * a compile pass over the producers for the \`ctx.input()\` calls — so \`deps\`
 * are never written by hand. It also writes \`puppi-env.d.ts\`, which maps
 * every asset key to the row type its schema implies, then runs this
 * project's \`tsc --noEmit\`. \`ctx.input("typo/key")\` fails the build.
 */

import { model, source } from "@puppi/sdk";

// A column contract, which the engine checks every materialization against.
// A Standard Schema (Zod, Valibot, ArkType) works here too, and additionally
// types what \`ctx.emit()\` accepts.
const Person = {
  columns: [
    { name: "id", type: "string" },
    { name: "name", type: "string" },
  ],
};

export const people = source({
  key: "example/people",
  // No source system: these rows are fabricated. Storage is
  // defaultStorage ("files"), Parquet through @puppi/adapter-filesystem.
  // A real source reaches the system it reads with \`ctx.connection("stripe")\`.
  schema: Person,

  // full_refresh is the default: every run is a complete copy. Writing it
  // makes the choice explicit. The adapter's content hash is what stops an
  // unchanged poll from rebuilding everything downstream.
  mode: "full_refresh",

  run: async (ctx) => {
    ctx.log("fetching people");

    await ctx.emit([
      { id: "1", name: "Ada" },
      { id: "2", name: "Grace" },
    ]);
  },
});

export const corePerson = model({
  key: "core/person",
  schema: Person,

  run: async (ctx) => {
    // Compiled into \`deps\`: nothing above declares the edge. The value is the
    // physical table name, so the SQL embeds it.
    const upstream = ctx.input("example/people");

    const { rows } = await ctx.query<{ id: string; name: string }>(
      \`select id, upper(name) as name from \${upstream} order by id\`,
    );

    await ctx.emit(rows);
  },
});
`;

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "Preserve",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
    },
    // `puppi-env.d.ts` has to be in here, or the generated types are invisible
    // and `ctx.input()` silently accepts any string.
    include: ["src/**/*", "puppi.config.ts", "puppi-env.d.ts"],
  },
  null,
  2,
)}\n`;

const GITIGNORE = `node_modules/
out/

# Written by \`puppi build\` from the asset declarations; \`tsc\` reads it,
# nothing else does.
puppi-env.d.ts

# Local values for this project. Not deployed.
bindings.local.json
`;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export const init: Command<InitResult> = {
  name: "init",
  help: [
    helpBlock(10, [
      "  puppi init [dir]                     a project that writes Parquet on the hosted service",
      "                                       [--force]",
    ]),
  ],
  flags: [{ name: "force" }],
  offline: true,
  run: (ctx) => initCommand(ctx.args, ctx.dir),
  render: renderInit,
};
