import { lstatSync, mkdirSync, mkdtempSync, chmodSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Directory this launcher owns under the temp dir.
 *
 * Attempt directories are created inside it. On boot the launcher removes
 * `puppi-*` children here and leaves every other launcher's directories.
 */
export function prepareRoot(prefix: string, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "") || "worker";
  const root = join(tmpdir(), `${prefix}${safe}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  sweep(root);
  return root;
}

/**
 * Private directory for one attempt, used as `TMPDIR`.
 *
 * The name is random and creation fails when the path already exists. The
 * caller removes the directory when the attempt ends, because a crash never
 * runs the producer's own finally.
 */
export function createScratch(root: string): string {
  const dir = mkdtempSync(join(root, "puppi-"));
  chmodSync(dir, 0o700);
  return dir;
}

/** Removes an attempt directory. A missing directory is already clean. */
export function removeScratch(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`puppi scratch cleanup failed: ${message}\n`);
  }
}

function sweep(root: string): void {
  let names: string[];

  try {
    names = readdirSync(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`puppi scratch cleanup failed: ${message}\n`);
    return;
  }

  for (const name of names) {
    if (!name.startsWith("puppi-")) continue;
    removeChild(join(root, name));
  }
}

function removeChild(path: string): void {
  try {
    const stat = lstatSync(path);

    if (stat.isSymbolicLink()) {
      rmSync(path);
      return;
    }

    if (!stat.isDirectory()) return;

    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`puppi scratch cleanup failed: ${message}\n`);
  }
}
