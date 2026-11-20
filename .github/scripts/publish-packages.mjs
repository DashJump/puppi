/**
 * Publishes the public workspace packages to registry.npmjs.org.
 *
 * The first publish is this script, run from a checkout with `NPM_TOKEN`
 * set in the environment. `--dry-run` prints each package's name, version,
 * and file list and does not upload. The script never prints the token and
 * never passes it on the command line. Provenance stays off.
 *
 * A real publish refuses unless the branch is `master` and the worktree is
 * clean, then lets pnpm check git itself. `--no-git-checks` is only on the
 * dry run: that run is used on a feature branch, and generated files often
 * leave the worktree dirty.
 *
 * The token lives in a mode-0600 npmrc. `exit`, a thrown error, and
 * SIGINT, SIGTERM, and SIGHUP delete that directory.
 *
 *   pnpm publish:dry-run
 *   NPM_TOKEN=… pnpm publish:packages
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ORDER = [
  "@puppi/sdk",
  "@puppi/adapter-storage",
  "@puppi/adapter-http",
  "@puppi/adapter-filesystem",
  "@puppi/adapter-postgres",
  "@puppi/adapter-s3",
  "@puppi/adapter-podcast-index",
  "@puppi/adapter-podcast-rss",
  "@puppi/executor-js",
  "@puppi/cli",
];

/** Directory of the npmrc for this process. Unset once it has been removed. */
let npmrcDir;
let cleanupArmed = false;

/** Deletes the temp npmrc directory. A second call does nothing. */
export function removeNpmrc() {
  if (!npmrcDir) return;

  const dir = npmrcDir;

  npmrcDir = undefined;
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Deletes the npmrc directory on a normal exit and on the signals that do
 * not emit `exit` by themselves.
 */
export function armNpmrcCleanup() {
  if (cleanupArmed) return;

  cleanupArmed = true;
  process.on("exit", removeNpmrc);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      removeNpmrc();
      process.exit(1);
    });
  }
}

/** Writes `//registry.npmjs.org/:_authToken=` into a fresh mode-0600 npmrc. */
export function writeNpmrc(token) {
  const dir = mkdtempSync(join(tmpdir(), "puppi-npm-"));

  writeFileSync(join(dir, "npmrc"), `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });

  if (npmrcDir) rmSync(npmrcDir, { recursive: true, force: true });

  npmrcDir = dir;

  return dir;
}

/**
 * Environment for the pnpm child. The token is removed from the environment.
 * A dry run gets no npmrc. A real publish without `NPM_TOKEN` exits 1.
 */
export function publishEnv({ dryRun }) {
  const childEnv = { ...process.env };

  delete childEnv.NPM_TOKEN;
  delete childEnv.NODE_AUTH_TOKEN;

  if (dryRun) return childEnv;

  const token = process.env.NPM_TOKEN;

  if (!token) {
    process.stderr.write(
      "Set NPM_TOKEN in the environment. This script does not read it from argv and does not print it.\n",
    );
    process.exit(1);
  }

  childEnv.NPM_CONFIG_USERCONFIG = join(writeNpmrc(token), "npmrc");

  return childEnv;
}

/**
 * A real publish runs from a clean `master`. A dry run skips this: pnpm's
 * own git check is disabled only for that run.
 */
export function assertPublishable({ dryRun }) {
  if (dryRun) return;

  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  }).trim();

  if (branch !== "master") {
    process.stderr.write(`Publish runs from master. This branch is ${branch}.\n`);
    process.exit(1);
  }

  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();

  if (dirty !== "") {
    process.stderr.write(
      "Publish needs a clean worktree. Commit or stash, then run it from master.\n",
    );
    process.exit(1);
  }
}

/** Arguments to `pnpm` for one package. `--no-git-checks` is dry-run only. */
export function publishArgs(name, { dryRun }) {
  const args = ["--filter", name, "publish", "--access", "public", "--yes"];

  if (dryRun) args.push("--no-git-checks", "--dry-run", "--json");

  return args;
}

function main() {
  armNpmrcCleanup();

  try {
    const dryRun = process.argv.includes("--dry-run");
    const pending = readdirSync(".changeset").filter(
      (name) => name.endsWith(".md") && name !== "README.md",
    );

    if (!dryRun && pending.length > 0) {
      process.stderr.write(
        `Unreleased changesets (${pending.join(", ")}). Run \`pnpm changeset version\` and merge that commit before publishing.\n`,
      );
      process.exit(1);
    }

    const listed = JSON.parse(
      execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], { encoding: "utf8" }),
    );
    const publics = listed.filter((pkg) => pkg.private !== true).map((pkg) => pkg.name);
    const same = publics.length === ORDER.length && publics.every((name) => ORDER.includes(name));

    if (!same) {
      process.stderr.write(`Public packages are ${publics.sort().join(", ")}.\n`);
      process.stderr.write(`This script publishes ${ORDER.join(", ")}.\n`);
      process.exit(1);
    }

    assertPublishable({ dryRun });

    const byName = new Map(listed.map((pkg) => [pkg.name, pkg]));
    const childEnv = publishEnv({ dryRun });

    for (const name of ORDER) {
      const pkg = byName.get(name);
      const version = pkg.version;

      if (!dryRun && alreadyPublished(name, version)) {
        process.stdout.write(`${name}@${version} is on the registry. Skipping.\n`);
        continue;
      }

      const args = publishArgs(name, { dryRun });

      process.stdout.write(`${dryRun ? "Dry run" : "Publishing"} ${name}@${version}.\n`);

      if (!dryRun) {
        execFileSync("pnpm", args, { stdio: "inherit", env: childEnv });
        continue;
      }

      const raw = execFileSync("pnpm", args, {
        encoding: "utf8",
        env: childEnv,
        stdio: ["inherit", "pipe", "inherit"],
      });
      const summary = JSON.parse(raw);
      const entry = Array.isArray(summary) ? summary.find((item) => item.name === name) : undefined;

      if (!entry || entry.version !== version || !Array.isArray(entry.files)) {
        process.stderr.write(
          `pnpm publish --dry-run returned no file list for ${name}@${version}.\n`,
        );
        process.exit(1);
      }

      for (const file of entry.files) {
        process.stdout.write(`${file.path}\n`);
      }

      process.stdout.write("\n");
    }
  } finally {
    removeNpmrc();
  }
}

function alreadyPublished(name, version) {
  try {
    execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      stdio: "ignore",
      env: { ...process.env, NPM_TOKEN: "", NODE_AUTH_TOKEN: "" },
    });
    return true;
  } catch {
    return false;
  }
}

const entry = process.argv[1];

if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main();
}
