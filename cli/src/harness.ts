/**
 * Spawns `@puppi/executor-js` rather than importing it. Oxlint and fallow
 * keep the CLI off the package that runs a producer, so this file holds the
 * protocol and the process.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const PACKAGE = "@puppi/executor-js";

// `import.meta.resolve` is absent under Vite's SSR transform, which loads this
// file in tests. `import.meta.url` is the real path, so a pnpm symlink finds
// the executor beside the store copy.
const require = createRequire(import.meta.url);

/**
 * A local run that could not start or could not be read. `bin/puppi.js`
 * prints the message and exits 1.
 */
class HarnessError extends Error {}

export function harnessEntry(dir: string): string {
  return resolveEntry("local", `a local run in ${dir}`);
}

export function poolEntry(dir: string): string {
  return resolveEntry("pool", `puppi worker start in ${dir}`);
}

function resolveEntry(subpath: "local" | "pool", command: string): string {
  try {
    return require.resolve(`${PACKAGE}/${subpath}`);
  } catch {
    throw new HarnessError(`${command} could not start. Reinstall @puppi/cli.`);
  }
}

/**
 * Runs the harness over `input` and hands every event to `onEvent` as it
 * arrives, so `ctx.log` reaches the terminal while the producer is still
 * working. Resolves when the process exits.
 */
export async function runHarness(
  entry: string,
  input: unknown,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "inherit"] });

  child.stdin.end(`${JSON.stringify(input)}\n`);

  const lines = createInterface({ input: child.stdout });

  for await (const line of lines) {
    if (!line.trim()) continue;

    try {
      onEvent(JSON.parse(line) as Record<string, unknown>);
    } catch {
      throw new HarnessError(`the local harness wrote something that is not an event: ${line}`);
    }
  }

  const code = await new Promise<number>((resolve) => child.on("close", resolve));

  if (code !== 0) throw new HarnessError(`the local harness exited ${code}`);
}
