import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "rolldown";

export interface BundleOptions {
  /** The user's pipeline entry, e.g. `src/pipeline.ts`. */
  entry: string;
  /**
   * `puppi.config.ts`. Imported into this bundle so `defineConfig` registers
   * catalog clients into the same SDK module `collect()` reads. The class in
   * the registry is then the class inside `bundle.js`.
   */
  config: string;
  /** Where to write `bundle.js` and its source map. */
  outFile: string;
}

export interface BundleResult {
  outFile: string;
  bytes: number;
}

const COLLECT_ENTRY = "\0puppi:collect-entry";

/**
 * The SDK the bundle inlines: the CLI's own install of it. `createRequire` for
 * the path only -- `import.meta.resolve` is absent under Vite's SSR transform,
 * which is how the tests load this module.
 */
const fromHere = createRequire(import.meta.url);

function sdkFile(subpath: string): string {
  return fromHere.resolve(`@puppi/sdk${subpath}`);
}

export function sdkVersion(): string {
  const json = readFileSync(sdkFile("/package.json"), "utf8");

  return (JSON.parse(json) as { version: string }).version;
}

/**
 * Evaluates `puppi.config.ts` and returns its default export.
 *
 * `entry` and `out` may be computed — a function return, `import.meta.url` —
 * so they are read by running the module. Node cannot `import()` the `.ts`
 * file, and running it on the CLI's SDK would register catalog `Client`s on
 * this process. This bundles the config on its own, imports that bundle, and
 * drops it. The pipeline bundle imports the config again; that evaluation is
 * the one whose classes the executor constructs.
 */
export async function importConfig(configPath: string): Promise<unknown> {
  const config = resolve(configPath);
  const dir = await mkdtemp(join(tmpdir(), "puppi-config-"));
  const outFile = join(dir, "config.js");

  try {
    await build({
      input: config,
      platform: "node",
      output: { file: outFile, format: "esm" },
      plugins: [configModulePlugin(config)],
      write: true,
    });

    const imported = (await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)) as {
      default?: unknown;
    };

    return imported.default;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Imports the config and the pipeline so `collect()` sees the registered clients.
 *
 * The CLI's earlier evaluation of the config is discarded. Publishing it
 * would hand the executor a class `bundle.js` never received. `@puppi/sdk`
 * is the CLI's copy, so the registration and the snapshot are one module.
 */
function collectEntrySource(configPath: string, entryPath: string): string {
  return [
    `import userConfig from ${JSON.stringify(configPath)};`,
    `import ${JSON.stringify(entryPath)};`,
    `import { collect } from ${JSON.stringify(sdkFile(""))};`,
    `export const config = userConfig;`,
    `export default collect();`,
  ].join("\n");
}

/** Bundles the user's pipeline into one self-contained ES module. */
export async function bundle(options: BundleOptions): Promise<BundleResult> {
  const entry = resolve(options.entry);
  const config = resolve(options.config);
  const outFile = resolve(options.outFile);
  await mkdir(dirname(outFile), { recursive: true });

  await build({
    input: COLLECT_ENTRY,
    platform: "node",
    output: { file: outFile, format: "esm", sourcemap: true },
    plugins: [
      configModulePlugin(config),
      {
        name: "puppi:collect-entry",
        resolveId(id: string) {
          if (id === COLLECT_ENTRY) return id;

          return null;
        },
        load(id: string) {
          return id === COLLECT_ENTRY ? collectEntrySource(config, entry) : null;
        },
      },
    ],
    write: true,
  });

  const { size } = await stat(outFile);

  return { outFile, bytes: size };
}

/**
 * Pins `@puppi/sdk` to the CLI's copy, and keeps `import.meta.url` in the
 * config pointing at `puppi.config.ts` rather than at the emitted bundle.
 */
function configModulePlugin(configPath: string) {
  const sdk = sdkFile("");
  const configUrl = JSON.stringify(pathToFileURL(configPath).href);

  return {
    name: "puppi:config-module",
    resolveId(id: string) {
      if (id === "@puppi/sdk") return sdk;

      return null;
    },
    transform(code: string, id: string) {
      if (id !== configPath || !code.includes("import.meta.url")) return null;

      return code.replaceAll("import.meta.url", configUrl);
    },
  };
}
