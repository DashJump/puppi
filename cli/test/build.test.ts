import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { buildProject } from "../src/build.js";
import { connectionTypes } from "../src/typegen.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "fixtures/project");
const heightFixture = resolve(here, "fixtures/height");
const fromTest = createRequire(import.meta.url);

afterAll(async () => {
  await rm(resolve(fixture, "dist"), { recursive: true, force: true });
  await rm(resolve(fixture, "puppi-env.d.ts"), { force: true });
});

describe("puppi build", () => {
  it("bundles, collects and compiles a real project", async () => {
    const output = await buildProject(fixture);
    const { manifest } = output;

    // Declarations came from executing the bundle, so the loop produced two.
    expect(manifest.assets.map((a) => a.key)).toEqual([
      "core/enriched",
      "core/joined",
      "core/ordered",
      "raw/alpha",
      "raw/beta",
    ]);

    // Deps came from the compile pass over the producers — nothing in the
    // source declares them.
    const joined = manifest.assets.find((a) => a.key === "core/joined")!;
    expect(joined.deps).toEqual(["raw/alpha", "raw/beta"]);

    // And an ordering-only dep survives, since compiled edges are a union
    // with the explicit ones rather than a replacement.
    const ordered = manifest.assets.find((a) => a.key === "core/ordered")!;
    expect(ordered.deps).toEqual(["core/joined"]);

    // Connections a producer reaches are compiled too; the rest carry none.
    const enriched = manifest.assets.find((a) => a.key === "core/enriched")!;
    expect(enriched.connections).toEqual({ enrichment: "read" });
    expect(enriched.deps).toEqual(["core/joined"]);
    expect(joined).not.toHaveProperty("connections");

    // A narrower binding on the connection wins over the adapter's schema.
    expect(manifest.connections["warehouse"]).toEqual({
      type: "warehouse-stub",
      config_schema: { database: "string" },
      secret_fields: ["password"],
    });

    // `enrichment` is still an `adapter()` in the pipeline. `rates` is a
    // module in `puppi.config.ts`. The technical fields come from that
    // registration, so the manifest and the client cannot drift.
    expect(manifest.connections["enrichment"]).toEqual({
      type: "clearbit",
      config_schema: { base_url: "string" },
      secret_fields: ["api_key"],
    });
    expect(manifest.connections["rates"]).toEqual({
      type: "rates",
      config_schema: { base_url: "string" },
      secret_fields: ["api_key"],
    });
    const sdk = JSON.parse(readFileSync(resolve(here, "../../sdk/package.json"), "utf8")) as {
      version: string;
    };

    expect(manifest.sdk_version).toBe(sdk.version);
    expect(output.warnings).toEqual([]);

    for (const asset of manifest.assets) {
      expect(asset.code_version).toMatch(/^cli-[0-9a-f]{16}$/);
      expect(asset.storage).toEqual({ connection: "warehouse" });
    }

    // The Standard Schema on core/joined reached the manifest as the column
    // list the engine validates — the contract's shape is unchanged.
    expect(joined.schema).toEqual({ columns: [{ name: "id", type: "string" }] });
  }, 60_000);

  it("writes puppi-env.d.ts, mapping every asset key to its row type", async () => {
    const { typesPath } = await buildProject(fixture);

    expect(typesPath).toBe(resolve(fixture, "puppi-env.d.ts"));

    const generated = await readFile(typesPath, "utf8");

    expect(generated).toContain('declare module "@puppi/sdk"');
    expect(generated).toContain("interface PuppiAssets");
    expect(generated).toContain('"core/joined": { id: string };');
    // No schema, still a valid key: untyped rows rather than a missing entry.
    expect(generated).toContain('"raw/alpha": Record<string, unknown>;');
    expect(generated).toContain('"core/ordered": Record<string, unknown>;');

    // Connections: `warehouse` is the project's stub, so its client comes from
    // the module its declaration names. `clearbit` is the same kind of client.
    expect(generated).toContain("interface PuppiConnections");
    expect(generated).toContain('"warehouse": import("./src/warehouse.js").Client;');
    expect(generated).toContain('"enrichment": import("./src/clearbit.js").Client;');
    expect(generated).toContain('"rates": import("./src/rates.js").Client;');
  }, 60_000);

  it("makes ctx.input() keys and ctx.emit() rows type errors, not build warnings", async () => {
    await buildProject(fixture);

    // `src/types.ts` in the fixture is a set of @ts-expect-error claims about
    // what the generated types reject, compiled here with the real compiler.
    // An unused directive is itself an error, so this pins both directions.
    const diagnostics = typecheck(fixture);

    expect(diagnostics).toEqual([]);
  }, 60_000);

  it("produces a bundle the executor can load", async () => {
    const { bundlePath } = await buildProject(fixture);
    const module = (await import(`${bundlePath}?t=${Date.now()}`)) as {
      default: {
        assets: Record<string, { key: string; run?: unknown }>;
        adapters: Record<string, { Client?: { bundled?: string }; client_module?: string }>;
      };
    };

    // The contract the executor relies on: one ES module, default-exporting
    // the collect-mode registry, producers intact.
    expect(Object.keys(module.default.assets).sort()).toEqual([
      "core/enriched",
      "core/joined",
      "core/ordered",
      "raw/alpha",
      "raw/beta",
    ]);
    expect(typeof module.default.assets["raw/alpha"]?.run).toBe("function");

    // The Client on the registry is the class this bundle evaluated, which
    // is the one the executor constructs.
    expect(typeof module.default.adapters["warehouse-stub"]?.Client).toBe("function");
    expect(module.default.adapters["warehouse-stub"]?.client_module).toBe("./src/warehouse.js");
    expect(module.default.adapters["rates"]?.Client?.bundled).toBe("rates");
    expect(module.default.adapters["rates"]?.client_module).toBe("./src/rates.js");
    expect(typeof module.default.adapters["rates"]?.Client).toBe("function");
    expect(module.default.adapters["clearbit"]?.client_module).toBe("./src/clearbit.js");
  }, 60_000);

  it("fails when ctx.emit drops a declared column, and passes once the row matches", async () => {
    const parent = await mkdtemp(join(here, ".puppi-fixture-height-"));
    const dir = join(parent, "project");

    try {
      await cp(heightFixture, dir, { recursive: true });

      await expect(buildProject(dir)).rejects.toThrow(/error TS[\s\S]*height_m/);

      const pipeline = join(dir, "src/pipeline.ts");

      await writeFile(
        pipeline,
        (await readFile(pipeline, "utf8")).replace("{ height: 1 }", "{ height_m: 1 }"),
      );

      const output = await buildProject(dir);

      expect(output.manifest.assets.map((asset) => asset.key)).toEqual(["raw/reading"]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("names a missing tsconfig.json and not a missing TypeScript", async () => {
    const dir = await minimalProject({ typescript: true, tsconfig: false });

    try {
      const error = await failedBuild(dir);

      expect(error.message).toMatch(/no tsconfig\.json in/);
      expect(error.message).toMatch(/puppi-env\.d\.ts/);
      expect(error.message).not.toMatch(/TypeScript is not installed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("names a missing TypeScript install and not a missing tsconfig", async () => {
    const dir = await minimalProject({ typescript: false, tsconfig: true });

    try {
      const error = await failedBuild(dir);

      expect(error.message).toMatch(/TypeScript is not installed/);
      expect(error.message).toMatch(/npm install --save-dev typescript/);
      expect(error.message).not.toMatch(/no tsconfig\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("connectionTypes", () => {
  class Client {
    constructor(
      readonly config: Record<string, unknown>,
      readonly secrets: Record<string, string>,
    ) {}
  }

  it("emits the client module when that package resolves, and unknown when it does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "puppi-connection-types-"));

    mkdirSync(join(dir, "node_modules/@acme/widget"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "resolvable", type: "module" }),
    );
    writeFileSync(
      join(dir, "node_modules/@acme/widget/package.json"),
      JSON.stringify({ name: "@acme/widget", type: "module", exports: "./index.js" }),
    );
    writeFileSync(join(dir, "node_modules/@acme/widget/index.js"), "export class Client {}\n");

    try {
      const resolved = connectionTypes(
        dir,
        { warehouse: { type: "widget" }, local: { type: "rates" } },
        {
          widget: {
            type: "widget",
            config_schema: {},
            secret_fields: [],
            client_module: "@acme/widget",
            Client,
          },
          rates: {
            type: "rates",
            config_schema: {},
            secret_fields: [],
            client_module: "./src/rates.js",
            Client,
          },
        },
      );

      expect(resolved["warehouse"]).toBe('import("@acme/widget").Client');
      expect(resolved["local"]).toBe('import("./src/rates.js").Client');

      const missing = connectionTypes(
        dir,
        { fx: { type: "missing" }, bare: { type: "widget" } },
        {
          missing: {
            type: "missing",
            config_schema: {},
            secret_fields: [],
            client_module: "@acme/missing",
            Client,
          },
        },
      );

      // The package is not installed, so the generated import would not resolve.
      expect(missing["fx"]).toBe("unknown");
      // The bundle did not register a client, so the import is not guessed.
      expect(missing["bare"]).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function minimalProject(options: {
  typescript: boolean;
  tsconfig: boolean;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "puppi-typecheck-"));

  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" })}\n`,
  );
  await writeFile(
    join(dir, "puppi.config.ts"),
    `import { defineConfig } from "@puppi/sdk";

export default defineConfig({
  entry: "src/pipeline.ts",
  out: "out",
});
`,
  );
  await writeFile(
    join(dir, "src/pipeline.ts"),
    `import { source } from "@puppi/sdk";

export const rows = source({
  key: "raw/rows",
  run: async (ctx) => {
    await ctx.emit([{ id: "1" }]);
  },
});
`,
  );

  if (options.tsconfig) {
    await writeFile(
      join(dir, "tsconfig.json"),
      await readFile(join(heightFixture, "tsconfig.json")),
    );
  }

  if (options.typescript) {
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await symlink(
      dirname(fromTest.resolve("typescript/package.json")),
      join(dir, "node_modules/typescript"),
    );
  }

  return dir;
}

async function failedBuild(dir: string): Promise<Error> {
  try {
    await buildProject(dir);
  } catch (error: unknown) {
    if (error instanceof Error) return error;
  }

  throw new Error("build succeeded");
}

function typecheck(dir: string): string[] {
  const configPath = resolve(dir, "tsconfig.json");
  const { config, error } = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));

  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));

  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dir);
  const program = ts.createProgram(parsed.fileNames, parsed.options);

  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const where = diagnostic.file
      ? `${diagnostic.file.fileName}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1}`
      : "global";

    return `${where}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  });
}
