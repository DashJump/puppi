/**
 * A private copy of `fixtures/project` for a test that builds.
 *
 * `puppi deploy` writes `dist` and `puppi-env.d.ts` into the project it is
 * given, and the test deletes them afterwards. Two files that share the
 * fixture race when vitest runs them together. The copy lives under
 * `cli/test` so module resolution still walks up to this repo.
 */

import { cp, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/project");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function copyProjectFixture(): Promise<string> {
  const parent = await mkdtemp(join(ROOT, ".puppi-fixture-"));
  const dir = join(parent, "project");

  await cp(SOURCE, dir, {
    recursive: true,
    filter: (source) => !source.endsWith(`${sep}dist`) && !source.endsWith(`${sep}puppi-env.d.ts`),
  });

  return dir;
}

export async function removeProjectFixture(dir: string | undefined): Promise<void> {
  if (!dir) return;

  await rm(dirname(dir), { recursive: true, force: true });
}
