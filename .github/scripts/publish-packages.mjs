/**
 * Publishes the public workspace packages to registry.npmjs.org.
 *
 * The first publish is this script, run from a checkout with `NPM_TOKEN`
 * set in the environment. `--dry-run` prints each package's name, version,
 * and file list and does not upload. The script never prints the token and
 * never passes it on the command line. Provenance stays off.
 *
 * The set is every workspace package that is not private, dependencies
 * first. `--build` runs that list's `build` script and does not upload.
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
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Public workspace packages, dependencies first.
 *
 * Private packages are left out. A package follows the public workspace
 * packages named in its `dependencies`. Ready packages keep the order they
 * were given, which is the `pnpm ls` order. A dependency on a private
 * workspace package is refused: that package is not on the registry.
 */
export function orderPublic(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const publics = packages.filter((pkg) => pkg.private !== true);
  const remaining = new Set(publics.map((pkg) => pkg.name));
  const blockedBy = new Map();

  for (const pkg of publics) {
    const blocked = new Set();

    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const other = byName.get(dep);

      if (!other || dep === pkg.name) continue;

      if (other.private === true) {
        throw new Error(`${pkg.name} depends on ${dep}, which is private and is not published.`);
      }

      blocked.add(dep);
    }

    blockedBy.set(pkg.name, blocked);
  }

  const order = [];

  const unblocked = (name) => {
    for (const dep of blockedBy.get(name) ?? []) {
      if (remaining.has(dep)) return false;
    }

    return true;
  };

  while (remaining.size > 0) {
    const ready = publics.filter((pkg) => remaining.has(pkg.name) && unblocked(pkg.name));

    if (ready.length === 0) {
      throw new Error(`Public packages have a dependency cycle: ${[...remaining].join(", ")}.`);
    }

    for (const pkg of ready) {
      order.push(pkg.name);
      remaining.delete(pkg.name);
    }
  }

  return order;
}

/** `pnpm -r --filter <name> … <script>` for the public packages. */
export function recursiveArgs(names, script) {
  return ["-r", ...names.flatMap((name) => ["--filter", name]), script];
}

/**
 * Workspace packages from `pnpm ls`, with `dependencies` read from each
 * package.json. `--depth -1` does not include that field.
 */
export function workspacePackages() {
  const listed = JSON.parse(
    execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], { encoding: "utf8" }),
  );

  if (!Array.isArray(listed)) throw new Error("pnpm ls --json did not return a package list.");

  return listed.map((pkg) => {
    if (typeof pkg.path !== "string" || pkg.path === "") {
      throw new Error(`pnpm ls returned no path for ${pkg.name}.`);
    }

    const manifest = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8"));

    return {
      name: pkg.name,
      version: manifest.version ?? pkg.version,
      path: pkg.path,
      private: pkg.private === true || manifest.private === true,
      dependencies: manifest.dependencies ?? {},
    };
  });
}

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

/**
 * `pnpm --dir` publish. Recursive `--filter` publish skips a version that is
 * already on the registry and prints no file list. The dry run uses this
 * when that happens, so the file list is still printed.
 */
export function publishDirArgs(dir, { dryRun }) {
  const args = ["--dir", dir, "publish", "--access", "public", "--yes"];

  if (dryRun) args.push("--no-git-checks", "--dry-run", "--json");

  return args;
}

/** The pack manifest for one package. pnpm returns an array from `--filter` and one object from `--dir`. */
export function publishEntry(summary, name, version) {
  const entries = Array.isArray(summary) ? summary : [summary];

  return entries.find(
    (item) => item && item.name === name && item.version === version && Array.isArray(item.files),
  );
}

function main() {
  const listed = workspacePackages();
  const order = orderPublic(listed);

  if (process.argv.includes("--build")) {
    execFileSync("pnpm", recursiveArgs(order, "build"), { stdio: "inherit" });
    return;
  }

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

    assertPublishable({ dryRun });

    const byName = new Map(listed.map((pkg) => [pkg.name, pkg]));
    const childEnv = publishEnv({ dryRun });

    for (const name of order) {
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
      let entry = publishEntry(JSON.parse(raw), name, version);

      if (!entry) {
        const packed = execFileSync("pnpm", publishDirArgs(pkg.path, { dryRun: true }), {
          encoding: "utf8",
          env: childEnv,
          stdio: ["inherit", "pipe", "inherit"],
        });

        entry = publishEntry(JSON.parse(packed), name, version);
      }

      if (!entry) {
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
