/**
 * `puppi init`, and the one thing it has to be: an init whose output fails
 * `puppi build` is worse than no init, so the test that matters is the one
 * that builds what it wrote.
 *
 * The scaffold is written inside `cli/` so `@puppi/sdk` resolves the way it
 * would in a project that has installed it. The build resolves the connector
 * from that project's `node_modules`, so the test writes a stub there.
 */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { buildProject } from "../src/build.js";
import { main } from "../src/index.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let project: string;
let stdout: string;
let stderr: string;

beforeEach(async () => {
  project = await mkdtemp(join(CLI, ".init-test-"));
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

const init = (...argv: string[]): Promise<number> => main(["init", project, ...argv]);

/** The module the scaffold imports. It is not `@puppi/adapter-filesystem` from the workspace. */
async function installConnector(): Promise<void> {
  const dest = join(project, "node_modules/@puppi/adapter-filesystem");

  await mkdir(dest, { recursive: true });
  await writeFile(
    join(dest, "package.json"),
    JSON.stringify({ name: "@puppi/adapter-filesystem", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(dest, "index.d.ts"),
    `export class Client {
  constructor(config: Record<string, unknown>, secrets?: Record<string, string>);
  write(storageRef: string, rows: unknown): Promise<{
    storage_ref: string;
    observed_schema: [];
    stats: { row_count: number; bytes: null; content_hash: null };
  }>;
  read(): Promise<never[]>;
  query(): Promise<never[]>;
  drop(): Promise<void>;
  close(): Promise<void>;
}
declare const connector: {
  type: "filesystem";
  configSchema: { root: "string" };
  secretFields: readonly string[];
};
export default connector;
`,
  );
  await writeFile(
    join(dest, "index.js"),
    `export class Client {
  constructor(config, secrets) {}
  async write(storageRef, rows) {
    return {
      storage_ref: storageRef,
      observed_schema: [],
      stats: { row_count: Array.isArray(rows) ? rows.length : 0, bytes: null, content_hash: null },
    };
  }
  async read() { return []; }
  async query() { return []; }
  async drop() {}
  async close() {}
}
export default { type: "filesystem", configSchema: { root: "string" }, secretFields: [] };
`,
  );
}

const read = (path: string): Promise<string> => readFile(join(project, path), "utf8");

function packageVersion(path: string): string {
  const file = join(resolve(CLI, ".."), path);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: string };

  if (!parsed.version) throw new Error(`${path} has no version`);

  return parsed.version;
}

const json = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await read(path)) as Record<string, unknown>;

describe("puppi init", () => {
  it("writes a project that builds and typechecks, with no edits", async () => {
    expect(await init()).toBe(0);
    await installConnector();

    const output = await buildProject(project);

    expect(output.warnings).toEqual([]);
    expect(output.manifest.assets.map((asset) => asset.key).sort()).toEqual([
      "core/person",
      "example/people",
    ]);
    expect(output.manifest.assets.find((a) => a.key === "core/person")?.deps).toEqual([]);
    expect(await read("src/pipeline.ts")).not.toContain("ctx.query");
    expect(await read("src/pipeline.ts")).not.toContain("ctx.input");

    // Fabricated rows: no source-system connection. Storage is the default,
    // which must not leak into config.connection.
    const people = output.manifest.assets.find((a) => a.key === "example/people");

    expect(people?.storage).toEqual({ connection: "files" });
    expect(people?.config).not.toHaveProperty("connection");
    expect(await read("src/pipeline.ts")).not.toContain('connection: "files"');
  });

  it("names a connection and its type, and lets the build complete the rest", async () => {
    await init();

    const source = await read("puppi.config.ts");

    expect(source).toContain('defaultStorage: "files"');
    expect(source).toContain('import * as filesystem from "@puppi/adapter-filesystem"');
    expect(source).toContain('"files": filesystem');
    expect(source).toContain("defineConfig");

    await installConnector();

    const { manifest } = await buildProject(project);

    // The fields the build copies out of the module the project installed.
    expect(manifest.connections["files"]).toEqual({
      type: "filesystem",
      config_schema: { root: "string" },
      secret_fields: [],
    });
  });

  it("writes the local binding with root set", async () => {
    await init();

    const bindings = await json("bindings.local.json");

    expect(bindings).toMatchObject({
      bindings: {
        files: { config: { root: "out/files" } },
      },
      secrets: {},
    });
    expect(JSON.stringify(bindings)).not.toContain("postgres");

    const pkg = await json("package.json");

    expect(pkg["devDependencies"]).toMatchObject({
      "@puppi/adapter-filesystem": expect.stringMatching(/^\^/),
    });
    expect(pkg["dependencies"]).not.toHaveProperty("@puppi/adapter-filesystem");
  });

  it("pins @puppi packages to the releases this checkout has", async () => {
    await init();

    const pkg = await json("package.json");
    const deps = pkg["dependencies"] as Record<string, string>;
    const dev = pkg["devDependencies"] as Record<string, string>;

    expect(deps["@puppi/sdk"]).toBe(`^${packageVersion("sdk/package.json")}`);
    expect(dev["@puppi/cli"]).toBe(`^${packageVersion("cli/package.json")}`);
    expect(dev["@puppi/adapter-filesystem"]).toBe(
      `^${packageVersion("connectors/filesystem/package.json")}`,
    );
  });

  it("writes the hosted quickstart", async () => {
    await init();

    const readme = await read("README.md");

    expect(readme).toContain("puppi login");
    expect(readme).toContain("puppi deploy");
    expect(readme).toContain("puppi run");
    expect(readme).toContain("puppi status");
    expect(readme).toContain("A Postgres source is the next step.");
    expect(readme).not.toContain("puppi dev");
    expect(readme).not.toContain("puppi worker");
    expect(readme).not.toContain("TODO");
    expect(readme).not.toMatch(/Tzelon/);
  });

  it("scaffolds a producer that runs before anything is installed or started", async () => {
    // The shallow end, end to end: `init` then `try`, with no
    // install, no engine, no database and no deploy in between. The executor
    // ships with the CLI (`executor-js/dist`, which `pnpm -r build` writes
    // before the tests run); the scaffold does not depend on it.
    await init();
    await installConnector();

    const pkg = await json("package.json");
    const deps = {
      ...(pkg["dependencies"] as Record<string, string>),
      ...(pkg["devDependencies"] as Record<string, string>),
    };

    expect(deps).not.toHaveProperty("@puppi/executor-js");
    expect(await main(["try", "example/people", "--dir", project])).toBe(0);
    expect(stdout).toContain("Ada");
    expect(stdout).toContain("Grace");
    expect(stdout).toContain("2 rows emitted");
    expect(stdout).toContain("contract  \u2713");
    expect(stdout).toContain(
      "Ran locally. Nothing was written. Run puppi deploy && puppi run to run on the engine.",
    );
    expect(stdout).not.toContain("no quarantine");

    stdout = "";
    stderr = "";

    expect(await main(["try", "core/person", "--dir", project])).toBe(0);
    expect(stdout).toContain("ADA");
    expect(stdout).toContain("GRACE");
    expect(stdout).toContain("2 rows emitted");
    expect(stdout).toContain("contract  \u2713");
    expect(stderr).not.toContain("ctx.query");
    expect(stderr).not.toContain("needs a latest materialization");
  });

  it("puts puppi-env.d.ts in the tsconfig, which is the arrow that silently does nothing", async () => {
    await init();

    expect(await json("tsconfig.json")).toMatchObject({
      include: ["src/**/*", "puppi.config.ts", "puppi-env.d.ts"],
    });
  });

  it("refuses to scaffold over what is there, and --force says otherwise", async () => {
    await init();
    await writeFile(join(project, "src/pipeline.ts"), "// mine\n");

    expect(await init()).toBe(2);
    expect(await read("src/pipeline.ts")).toBe("// mine\n");

    expect(await init("--force")).toBe(0);
    expect(await read("src/pipeline.ts")).toContain("example/people");
  });

  it("refuses a role default that names a connection that holds nothing", async () => {
    await init();
    await writeFile(
      join(project, "puppi.config.ts"),
      `import { defineConfig } from "@puppi/sdk";

class Warehouse {
  constructor(
    readonly config: Record<string, unknown>,
    readonly secrets: Record<string, string>,
  ) {}
  async write(): Promise<void> {}
  async read(): Promise<never[]> { return []; }
  async query(): Promise<never[]> { return []; }
  async drop(): Promise<void> {}
}

class Stripe {
  constructor(
    readonly config: Record<string, unknown>,
    readonly secrets: Record<string, string>,
  ) {}
}

export default defineConfig({
  entry: "src/pipeline.ts",
  out: "out",
  defaultStorage: { source: "stripe" },
  connections: {
    warehouse: { type: "warehouse", Client: Warehouse, clientModule: "./src/warehouse.js" },
    stripe: { type: "stripe", Client: Stripe, clientModule: "./src/stripe.js" },
  },
});
`,
    );

    await expect(buildProject(project)).rejects.toThrow(
      /defaultStorage.source is "stripe", which holds no materialization/,
    );
  });

  it("fails a connection whose type the bundle does not register", async () => {
    await init();
    await writeFile(
      join(project, "puppi.config.ts"),
      `import { defineConfig } from "@puppi/sdk";

export default defineConfig({
  entry: "src/pipeline.ts",
  out: "out",
  defaultStorage: "warehouse",
  connections: { warehouse: { type: "acme" } },
});
`,
    );

    await expect(buildProject(project)).rejects.toThrow(/@puppi\/adapter-acme/);
  });
});
