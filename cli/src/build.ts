import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import { bundle, sdkVersion } from "./bundle.js";
import { collect } from "./collect.js";
import { type Command, done, helpBlock } from "./command.js";
import { compile } from "./compile.js";
import {
  buildManifest,
  type DeclaredConnection,
  type Manifest,
  reachedConnections,
  unservableStorageDefaults,
  visibilityViolations,
} from "./manifest.js";
import { counted, err, out } from "./print.js";
import {
  buildPaths,
  CONFIG_FILE,
  declaredConnections,
  lockfileHash,
  parseDefaultStorage,
  pathExists,
} from "./project.js";
import { connectionTypes, declarationFile, TYPES_FILE } from "./typegen.js";

export interface BuildOutput {
  bundlePath: string;
  manifestPath: string;
  /** The generated `puppi-env.d.ts`, next to `puppi.config.ts`. */
  typesPath: string;
  manifest: Manifest;
  bytes: number;
  warnings: string[];
}

export const build: Command<BuildOutput> = {
  name: "build",
  help: [
    helpBlock(90, [
      "  puppi build                          bundle, typecheck, manifest into `out`",
    ]),
  ],
  offline: true,
  async run(ctx) {
    const output = await buildProject(ctx.dir);

    report(output, { stdout: false });

    return done(output);
  },
  render(data) {
    renderBuild(data);
  },
};

/** bundle -> collect -> compile -> manifest -> types -> tsc. */
export async function buildProject(dir: string): Promise<BuildOutput> {
  const paths = await buildPaths(dir);
  const bundlePath = resolve(paths.out, "bundle.js");
  const manifestPath = resolve(paths.out, "manifest.json");
  // Into the project root, not `out`: it has to be inside the tsconfig's
  // `include` for the editor to see it, and `out` is usually gitignored.
  const typesPath = resolve(dir, TYPES_FILE);

  const { bytes } = await bundle({
    entry: paths.entry,
    config: paths.config,
    outFile: bundlePath,
  });
  const collected = await collect(bundlePath);
  const registry = collected.registry;
  const connections = declaredConnections(collected.config.connections);
  const defaultStorage = parseDefaultStorage(collected.config.defaultStorage);
  const adapters = registry.adapters;
  const compiled = compile(registry, { connections, adapters });

  const options = {
    registry,
    compiled,
    sdkVersion: sdkVersion(),
    lockfileHash: await lockfileHash(dir),
    connections,
    ...(defaultStorage ? { defaultStorage } : {}),
  };
  const manifest = buildManifest(options);
  const unservable = unservableStorageDefaults(defaultStorage, manifest.connections, adapters);
  const unregistered = undeclaredTypes(connections, adapters);

  if (unservable.length > 0) throw new Error(unservable.join("\n"));
  if (unregistered.length > 0) throw new Error(unregistered.map(unregisteredType).join("\n"));

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    typesPath,
    declarationFile(manifest.assets, connectionTypes(dir, connections, registry.adapters)),
  );

  // `ctx.input` types come from the file just written.
  await typecheckProject(dir);

  const warnings = [
    ...compiled.warnings,
    ...compiled.unresolved.map(
      ({ asset, key }) =>
        `${asset} calls ctx.input("${key}"), which is not a declared asset. ` +
        `A typo, or a read the SDK shim will report at run time.`,
    ),
    ...undeclaredConnections(manifest).map(
      ({ asset, name, via }) =>
        `${asset} reaches connection "${name}" (${via}), which ${CONFIG_FILE} ` +
        `does not declare. The engine will reject the deployment.`,
    ),
    ...visibilityViolations(manifest).map(({ message }) => message),
  ];

  return { bundlePath, manifestPath, typesPath, manifest, bytes, warnings };
}

/**
 * The `tsc` this project installed. Resolution starts at the project, so a
 * compiler on `PATH` is not the one that runs.
 */
function projectCompiler(dir: string): string | undefined {
  try {
    const require = createRequire(resolve(dir, "package.json"));

    return resolve(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  } catch {
    return undefined;
  }
}

function missingTypecheck(
  dir: string,
  tsconfig: boolean,
  tsc: string | undefined,
): string | undefined {
  const missing: string[] = [];

  if (!tsconfig) {
    missing.push(
      `no tsconfig.json in ${dir}. Add one that includes src, ${CONFIG_FILE}, and ${TYPES_FILE}.`,
    );
  }

  if (!tsc) {
    missing.push(
      `TypeScript is not installed in ${dir}. Add it with \`npm install --save-dev typescript\`.`,
    );
  }

  return missing.length > 0 ? missing.join("\n") : undefined;
}

async function typecheckProject(dir: string): Promise<void> {
  const tsconfig = resolve(dir, "tsconfig.json");
  const tsc = projectCompiler(dir);
  const problem = missingTypecheck(dir, await pathExists(tsconfig), tsc);

  if (!tsc || problem) {
    throw new Error(
      problem ??
        `TypeScript is not installed in ${dir}. Add it with \`npm install --save-dev typescript\`.`,
    );
  }

  await runCompiler(tsc, tsconfig, dir);
}

function runCompiler(tsc: string, tsconfig: string, dir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsc, "--noEmit", "-p", tsconfig], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;

      settled = true;
      if (error) reject(error);
      else resolvePromise();
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", finish);
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }

      const output = [stdout, stderr]
        .filter((part) => part.trim() !== "")
        .join("\n")
        .trim();

      finish(new Error(output || `tsc --noEmit exited ${code ?? "null"}`));
    });
  });
}

/**
 * A connection whose type the bundle did not register. The manifest would
 * name a client the deployment does not carry, and the attempt would fail.
 */
function undeclaredTypes(
  connections: Record<string, DeclaredConnection>,
  adapters: Record<string, unknown>,
): { name: string; type: string }[] {
  return Object.entries(connections)
    .filter(([, connection]) => !adapters[connection.type])
    .map(([name, connection]) => ({ name, type: connection.type }));
}

function unregisteredType({ name, type }: { name: string; type: string }): string {
  const binding = type.replaceAll("-", "_");

  return (
    `connection ${JSON.stringify(name)} is type ${JSON.stringify(type)}, which this bundle does not register. ` +
    `Add \`import * as ${binding} from "@puppi/adapter-${type}"\` to ${CONFIG_FILE} and pass it to defineConfig.`
  );
}

/** Every connection an asset names that the project does not declare: the engine's `undeclared_connection`, seen early. */
function undeclaredConnections(manifest: Manifest): { asset: string; name: string; via: string }[] {
  const found: { asset: string; name: string; via: string }[] = [];

  for (const asset of manifest.assets) {
    for (const { name, via } of reachedConnections(asset)) {
      if (Object.hasOwn(manifest.connections, name)) continue;

      found.push({ asset: asset.key, name, via });
    }
  }

  return found;
}

/** Paths on stdout, warnings on stderr. `stdout: false` skips the paths so `--json` does not print them as well. */
export function report(output: BuildOutput, options?: { stdout?: boolean }): void {
  if (options?.stdout !== false) renderBuild(output);

  for (const warning of output.warnings) err(`  warning: ${warning}`);
}

export function renderBuild(output: BuildOutput): void {
  const assets = output.manifest.assets;

  out(`${output.bundlePath} (${output.bytes} bytes)`);
  out(output.manifestPath);
  out(output.typesPath);
  out();

  for (const asset of assets) {
    const deps = asset.deps.length > 0 ? ` <- ${asset.deps.join(", ")}` : "";

    out(`  ${asset.role.padEnd(12)} ${asset.key}${deps}`);
  }

  out();
  out(`  ${counted(assets.length, "asset")}`);
}
