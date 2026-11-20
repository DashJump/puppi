/**
 * The temp npmrc is deleted on exit, on a throw, and on SIGTERM.
 * A real publish from a branch other than master is refused.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptUrl = new URL("./publish-packages.mjs", import.meta.url);
const scriptHref = scriptUrl.href;
const root = fileURLToPath(new URL("../..", import.meta.url));
const TOKEN = "npm-token-for-cleanup-test";

void test("writes a mode-0600 npmrc and removeNpmrc deletes it", async () => {
  const { writeNpmrc, removeNpmrc } = await import("./publish-packages.mjs");
  const dir = writeNpmrc(TOKEN);

  try {
    const npmrc = join(dir, "npmrc");

    assert.equal(statSync(npmrc).mode & 0o777, 0o600);
    assert.equal(readFileSync(npmrc, "utf8"), `//registry.npmjs.org/:_authToken=${TOKEN}\n`);
  } finally {
    removeNpmrc();
  }

  assert.equal(existsSync(dir), false);
});

void test("a dry run copies no token and writes no npmrc", async () => {
  const { publishEnv } = await import("./publish-packages.mjs");
  const childEnv = publishEnv({ dryRun: true });

  assert.equal(childEnv.NPM_TOKEN, undefined);
  assert.equal(childEnv.NODE_AUTH_TOKEN, undefined);
  assert.equal(childEnv.NPM_CONFIG_USERCONFIG, undefined);
});

void test("publish arguments keep --no-git-checks and provenance off the real publish", async () => {
  const { publishArgs } = await import("./publish-packages.mjs");
  const real = publishArgs("@puppi/sdk", { dryRun: false });
  const dry = publishArgs("@puppi/sdk", { dryRun: true });

  assert.equal(real.includes("--no-git-checks"), false);
  assert.equal(real.includes("--provenance"), false);
  assert.equal(real.includes("--dry-run"), false);
  assert.deepEqual(dry.slice(-3), ["--no-git-checks", "--dry-run", "--json"]);
});

void test("a real publish from a branch other than master is refused before upload", async () => {
  // assertPublishable reads the git checkout of the process. This temp repo
  // is on the branch topic, so the refusal does not depend on the branch that
  // runs the test. The empty commit gives HEAD a revision for git rev-parse.
  const dir = mkdtempSync(join(tmpdir(), "puppi-publish-"));

  try {
    execFileSync("git", ["init", "-b", "topic"], { cwd: dir, stdio: "ignore" });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=publish-test@example.com",
        "-c",
        "user.name=Publish test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ],
      { cwd: dir, stdio: "ignore" },
    );

    const { code, stdout, stderr } = await runNode(
      `
      import { assertPublishable } from ${JSON.stringify(scriptHref)};
      assertPublishable({ dryRun: false });
      process.stdout.write("published\\n");
      `,
      { cwd: dir },
    );

    assert.equal(code, 1);
    assert.match(stderr, /Publish runs from master\. This branch is topic\./);
    assert.equal(stdout.includes("published"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

void test("a real publish without NPM_TOKEN exits before it writes an npmrc", async () => {
  const { code, stderr } = await runNode(
    `
    import { publishEnv } from ${JSON.stringify(scriptHref)};
    delete process.env.NPM_TOKEN;
    delete process.env.NODE_AUTH_TOKEN;
    publishEnv({ dryRun: false });
    process.stdout.write("published\\n");
    `,
    { env: { ...process.env, NPM_TOKEN: "", NODE_AUTH_TOKEN: "" } },
  );

  assert.equal(code, 1);
  assert.match(stderr, /Set NPM_TOKEN in the environment/);
});

void test("removes the npmrc directory on process.exit", async () => {
  const dir = await cleanupDir(`
    import { writeNpmrc, armNpmrcCleanup } from ${JSON.stringify(scriptHref)};
    armNpmrcCleanup();
    process.stdout.write(writeNpmrc(${JSON.stringify(TOKEN)}) + "\\n");
    process.exit(1);
  `);

  assert.equal(existsSync(dir), false);
});

void test("removes the npmrc directory when the process throws", async () => {
  const dir = await cleanupDir(`
    import { writeNpmrc, armNpmrcCleanup } from ${JSON.stringify(scriptHref)};
    armNpmrcCleanup();
    process.stdout.write(writeNpmrc(${JSON.stringify(TOKEN)}) + "\\n");
    throw new Error("publish failed");
  `);

  assert.equal(existsSync(dir), false);
});

void test("removes the npmrc directory on SIGTERM", async () => {
  const dir = await cleanupDir(
    `
    import { writeNpmrc, armNpmrcCleanup } from ${JSON.stringify(scriptHref)};
    armNpmrcCleanup();
    process.stdout.write(writeNpmrc(${JSON.stringify(TOKEN)}) + "\\n");
    setInterval(() => {}, 1000);
    `,
    (child) => child.kill("SIGTERM"),
  );

  assert.equal(existsSync(dir), false);
});

void test("publishEnv's npmrc is gone after the process exits", async () => {
  const { code, stdout } = await runNode(`
    import { publishEnv, armNpmrcCleanup } from ${JSON.stringify(scriptHref)};
    armNpmrcCleanup();
    process.env.NPM_TOKEN = ${JSON.stringify(TOKEN)};
    const childEnv = publishEnv({ dryRun: false });
    process.stdout.write(childEnv.NPM_CONFIG_USERCONFIG + "\\n");
    process.exit(0);
  `);
  const npmrc = stdout.trim();

  assert.equal(code, 0);
  assert.equal(npmrc.endsWith("/npmrc"), true);
  assert.equal(stdout.includes(TOKEN), false);
  assert.equal(existsSync(npmrc), false);
});

function runNode(source, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out\n${stdout}\n${stderr}`));
    }, 10_000);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function cleanupDir(source, afterLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let signaled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;

      if (afterLine && !signaled && stdout.includes("\n")) {
        signaled = true;
        afterLine(child);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out\n${stdout}\n${stderr}`));
    }, 10_000);

    child.on("exit", () => {
      clearTimeout(timer);
      const dir = stdout.split("\n")[0]?.trim();

      if (!dir) reject(new Error(`child printed no directory\n${stderr}`));
      else resolve(dir);
    });
  });
}
