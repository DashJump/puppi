/**
 * Write a scaffold into an existing directory.
 * Nothing is overwritten without being asked: a scaffold over real work is
 * not recoverable. `overwrite` is the recovery half of that error.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { UsageError } from "./args.js";

export async function writeScaffold(
  target: string,
  files: Iterable<readonly [string, string]>,
  force: boolean,
  overwrite: string,
): Promise<void> {
  const entries = [...files];
  const existing = force
    ? []
    : await present(
        target,
        entries.map(([path]) => path),
      );

  if (existing.length > 0) {
    throw new UsageError(`${target} already has ${existing.join(", ")}; ${overwrite}`);
  }

  for (const [path, contents] of entries) {
    const full = join(target, path);

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
}

async function present(target: string, paths: string[]): Promise<string[]> {
  const found: string[] = [];

  for (const path of paths) {
    const readable = await readFile(join(target, path), "utf8").catch(() => null);

    if (readable !== null) found.push(path);
  }

  return found;
}
