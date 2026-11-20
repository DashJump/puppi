/**
 * `puppi connector new` writes a package that is not part of this repository.
 * The test that matters is the one that typechecks and runs what it wrote.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/index.js";

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

let project: string;
let stdout: string;
let stderr: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "puppi-connector-"));
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});

const scaffold = (...argv: string[]): Promise<number> =>
  main(["connector", "new", ...argv, "--dir", project]);

describe("puppi connector new", () => {
  it("lists the command", async () => {
    expect(await main(["help"])).toBe(0);
    expect(stdout).toContain("puppi connector new <type> [dir]");
  });

  it("writes a package pinned to the sdk version, without conformance", async () => {
    expect(await scaffold("acme")).toBe(0);

    const pkg = JSON.parse(readFileSync(join(project, "acme/package.json"), "utf8")) as {
      name: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const sdk = JSON.parse(readFileSync(join(root, "sdk/package.json"), "utf8")) as {
      version: string;
    };

    expect(pkg.name).toBe("@puppi/adapter-acme");
    expect(pkg.dependencies["@puppi/sdk"]).toBe(`^${sdk.version}`);
    expect(pkg.devDependencies["@puppi/conformance"]).toBeUndefined();
    expect(JSON.stringify(pkg)).not.toContain("@puppi/conformance");
    expect(readFileSync(join(project, "acme/test/client.test.ts"), "utf8")).not.toContain(
      "@puppi/conformance",
    );
    expect(readFileSync(join(project, "acme/README.md"), "utf8")).toContain(
      "# @puppi/adapter-acme",
    );
    expect(readFileSync(join(project, "acme/tsconfig.json"), "utf8")).toContain(
      '"types": ["node"]',
    );
    expect(readFileSync(join(project, "acme/src/define.ts"), "utf8")).not.toMatch(
      /from "\.\/(openapi|operations)\.js"/,
    );
    expect(stdout).toContain("npm test");
    expect(stdout).toContain(`cd ${join(project, "acme")}`);
  });

  it("resolves a positional directory under --dir", async () => {
    expect(await scaffold("acme", "vendors/acme")).toBe(0);

    const target = join(project, "vendors/acme");

    expect(readFileSync(join(target, "package.json"), "utf8")).toContain("@puppi/adapter-acme");
    expect(stdout).toContain(`cd ${target}`);
    expect(existsSync(resolve("vendors/acme/package.json"))).toBe(false);
  });

  it("refuses a name that is not a connection type name, and a second write", async () => {
    expect(await scaffold("Stripe")).toBe(2);
    expect(stderr).toContain("connection type name");

    expect(await scaffold("acme")).toBe(0);
    expect(await scaffold("acme")).toBe(2);
    expect(stderr).toContain("--force");
  });

  it("typechecks and passes the source interface check", async () => {
    expect(await scaffold("acme")).toBe(0);

    const dir = join(project, "acme");
    const modules = join(dir, "node_modules");
    const bin = join(root, "connectors/http/node_modules/.bin");

    link(dir);

    // The committed stubs have to pass before generate replaces operations.ts.
    await run(join(bin, "tsc"), ["-p", "tsconfig.json", "--noEmit"], { cwd: dir });
    await run(join(bin, "tsc"), ["-p", "test/tsconfig.json"], { cwd: dir });
    await run(join(bin, "vitest"), ["run"], { cwd: dir });

    mkdirSync(join(modules, ".bin"), { recursive: true });
    symlinkSync(
      join("..", "@puppi", "sdk", "dist", "write-operations.js"),
      join(modules, ".bin", "puppi-write-operations"),
    );
    await run("puppi-write-operations", ["openapi.json", "src/operations.ts"], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${join(modules, ".bin")}${delimiter}${process.env.PATH ?? ""}`,
      },
    });

    await run(join(bin, "tsc"), ["-p", "tsconfig.json", "--noEmit"], { cwd: dir });
    await run(join(bin, "tsc"), ["-p", "test/tsconfig.json"], { cwd: dir });
    await run(join(bin, "vitest"), ["run"], { cwd: dir });
  }, 120_000);
});

/** The package is not installed. Point its imports at packages this repo already built. */
function link(dir: string): void {
  const modules = join(dir, "node_modules");

  mkdirSync(join(modules, "@puppi"), { recursive: true });
  mkdirSync(join(modules, "@types"), { recursive: true });
  symlinkSync(join(root, "sdk"), join(modules, "@puppi/sdk"));

  const donor = join(root, "connectors/http/node_modules");

  symlinkSync(join(donor, "@types/node"), join(modules, "@types/node"));
  symlinkSync(join(donor, "typescript"), join(modules, "typescript"));
  symlinkSync(join(donor, "vitest"), join(modules, "vitest"));
}
