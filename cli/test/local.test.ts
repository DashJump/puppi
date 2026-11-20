/**
 * `puppi try`: the payload handed to the harness, and the refusals made
 * before anything is spawned. A dependency with no latest materialization is
 * refused before the bundle loads.
 *
 * The harness process is fake. The command is not: `main` builds the project
 * and writes the payload the executor would read on stdin.
 */

import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { main } from "../src/index.js";
import { type EngineCall, stubEngine } from "./support/engine.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const payloads = vi.hoisted(() => [] as string[]);

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");

  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const script = args[1]?.[0];

      if (typeof script !== "string" || !script.includes("/local/main.js")) {
        return actual.spawn(...args);
      }

      return harnessChild();
    },
  };
});

const RESULT = {
  event: "local_result",
  asset_key: "x",
  role: "source",
  row_count: 0,
  sample: [],
  observed_schema: [],
  declared_schema: null,
  contract: { result: "undeclared", detail: "no schema" },
  content_hash: "abc",
  check_results: [],
  checks_error: null,
};

function harnessChild(): ChildProcess.ChildProcess {
  let body = "";
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      body += String(chunk);
      callback();
    },
    final(callback) {
      payloads.push(body);
      callback();
    },
  });
  const stdout = new Readable({ read() {} });
  const child = new EventEmitter();

  setImmediate(() => {
    stdout.push(`${JSON.stringify(RESULT)}\n`);
    stdout.push(null);
    setImmediate(() => child.emit("close", 0));
  });

  return Object.assign(child, { stdin, stdout, stderr: null }) as ChildProcess.ChildProcess;
}

const PIPELINE = `import { model, source } from "@puppi/sdk";

source({
  key: "stripe/customers",
  mode: "full_refresh",
  run: async () => {},
});

model({
  key: "core/customer",
  deps: ["stripe/customers"],
  run: async (ctx) => {
    ctx.input("stripe/customers");
  },
});

model({
  key: "core/enriched",
  run: async (ctx) => {
    ctx.connection("enrichment");
  },
});
`;

const CONFIG = `import * as warehouse from "@acme/warehouse";
import { defineConfig } from "@puppi/sdk";

class Enrichment {
  constructor(
    readonly config: Record<string, unknown>,
    readonly secrets: Record<string, string>,
  ) {}
}

export default defineConfig({
  entry: "src/pipeline.ts",
  out: "dist",
  defaultStorage: "warehouse",
  connections: {
    warehouse: {
      ...warehouse,
      config_schema: { host: "string", port: "integer" },
      secret_fields: ["password"],
    },
    enrichment: {
      type: "clearbit",
      configSchema: {},
      secretFields: [],
      clientModule: "./src/clearbit.js",
      Client: Enrichment,
    },
  },
});
`;

interface Bindings {
  bindings: Record<string, unknown>;
  secrets?: Record<string, unknown>;
}

const BOUND: Bindings = {
  bindings: {
    warehouse: {
      config: { host: "127.0.0.1", port: 5432 },
      secret_refs: { password: "warehouse_password" },
      mode: "live",
    },
    enrichment: {
      config: { base_url: "https://x" },
      secret_refs: {},
      mode: "live",
    },
  },
  secrets: { warehouse_password: "hunter2" },
};

let dir: string;
let stderr: string;

beforeEach(async () => {
  payloads.length = 0;
  stderr = "";
  delete process.env["PUPPI_ENV"];
  dir = await mkdtemp(join(CLI, ".local-test-"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env["PUPPI_ENV"];
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("the payload", () => {
  it("carries the storage connection and only the bindings the asset reaches", async () => {
    await project(BOUND);

    expect(await run("stripe/customers")).toBe(0);

    const input = sent();

    expect(input.storage_connection).toBe("warehouse");
    expect(input.bindings).toEqual({
      warehouse: {
        type: "warehouse",
        config: { host: "127.0.0.1", port: 5432 },
        secrets: { password: "hunter2" },
        mode: "live",
      },
    });

    expect(await run("core/enriched")).toBe(0);
    expect(Object.keys(sent().bindings).sort()).toEqual(["enrichment", "warehouse"]);
  });

  it("has no storage connection when the asset names none", async () => {
    await files(
      `import { defineConfig } from "@puppi/sdk";
export default defineConfig({
  entry: "src/pipeline.ts",
  out: "dist",
  connections: {},
});
`,
      `import { model } from "@puppi/sdk";

model({ key: "core/plain", run: async () => {} });
`,
      { bindings: {} },
    );

    expect(await run("core/plain")).toBe(0);
    expect(sent().storage_connection).toBeNull();
  });
});

describe("resolving inputs", () => {
  it("refuses a declared dependency when no environment is configured", async () => {
    await project(BOUND);

    expect(await run("core/customer")).toBe(2);
    expect(stderr).toContain(
      "core/customer reads stripe/customers, and needs a latest materialization.",
    );
    expect(stderr).toContain("Pass --inputs-from <env>, or set --env or PUPPI_ENV.");
    expect(stderr).not.toContain("not a declared dependency");
    expect(payloads).toEqual([]);
  });

  it("runs with no inputs when the asset declares no dependency", async () => {
    await project(BOUND);

    expect(await run("core/enriched")).toBe(0);
    expect(sent().inputs).toEqual({});
  });

  it("reads latest materializations from the default environment", async () => {
    await project(BOUND);
    const calls: EngineCall[] = [];

    stubEngine(
      {
        "GET /environments/prod/assets": [
          { key: "stripe/customers", latest: { id: "mat-1", storage_ref: "public.customers" } },
          { key: "hubspot/contacts", latest: { id: "mat-2", storage_ref: "public.contacts" } },
        ],
      },
      calls,
    );
    process.env["PUPPI_ENV"] = "prod";

    expect(await run("core/customer")).toBe(0);
    expect(sent().inputs).toEqual({
      "stripe/customers": { materialization_id: "mat-1", storage_ref: "public.customers" },
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /environments/prod/assets",
    ]);
  });

  it("lets --inputs-from name a different environment", async () => {
    await project(BOUND);
    const calls: EngineCall[] = [];

    stubEngine(
      {
        "GET /environments/stage/assets": [
          { key: "stripe/customers", latest: { id: "mat-9", storage_ref: "stage.customers" } },
        ],
      },
      calls,
    );
    process.env["PUPPI_ENV"] = "prod";

    expect(await run("core/customer", "--inputs-from", "stage")).toBe(0);
    expect(sent().inputs).toEqual({
      "stripe/customers": { materialization_id: "mat-9", storage_ref: "stage.customers" },
    });
    expect(calls[0]?.path).toBe("/environments/stage/assets");
  });

  it("names the environment when PUPPI_ENV is set and the engine cannot be reached", async () => {
    await project(BOUND);
    process.env["PUPPI_ENV"] = "prod";

    expect(await run("core/customer")).toBe(1);
    expect(stderr).toContain("could not read inputs from prod");
    expect(stderr).toContain("Unset PUPPI_ENV or pass --inputs-from to change it.");
    expect(payloads).toEqual([]);
  });

  it("refuses a dependency the environment has no latest for", async () => {
    await project(BOUND);
    stubEngine(
      { "GET /environments/prod/assets": [{ key: "stripe/customers", latest: null }] },
      [],
    );

    expect(await run("core/customer", "--inputs-from", "prod")).toBe(2);
    expect(stderr).toContain("stripe/customers");
    expect(stderr).toContain("prod has no latest materialization");
    expect(payloads).toEqual([]);
  });
});

describe("what it refuses before spawning anything", () => {
  it("names the assets this project has when the key is not one", async () => {
    await project(BOUND);

    expect(await run("nope/key")).toBe(2);
    expect(stderr).toMatch(
      /declares no nope\/key. It has: core\/customer, core\/enriched, stripe\/customers/,
    );
    expect(payloads).toEqual([]);
  });

  it("says which file binds a connection when nothing does", async () => {
    await project({ bindings: {} });

    expect(await run("stripe/customers")).toBe(2);
    expect(stderr).toMatch(
      /reaches connection "warehouse", which bindings.local.json does not bind/,
    );
  });

  it("says which secret is missing when a binding refers to one that is not there", async () => {
    await project({
      bindings: {
        warehouse: {
          config: { host: "127.0.0.1", port: 5432 },
          secret_refs: { password: "warehouse_password" },
          mode: "live",
        },
      },
      secrets: {},
    });

    expect(await run("stripe/customers")).toBe(2);
    expect(stderr).toMatch(
      /refers password to secret "warehouse_password", which bindings.local.json does not define/,
    );
  });
});

async function project(bindings: Bindings): Promise<void> {
  await files(CONFIG, PIPELINE, bindings);
}

async function files(config: string, pipeline: string, bindings: Bindings): Promise<void> {
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "node_modules/@acme/warehouse"), { recursive: true });
  await writeFile(
    join(dir, "node_modules/@acme/warehouse/package.json"),
    JSON.stringify({ name: "@acme/warehouse", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(dir, "node_modules/@acme/warehouse/index.d.ts"),
    `export class Client {
  constructor(config: Record<string, unknown>, secrets: Record<string, string>);
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
  type: "warehouse";
  configSchema: Record<string, string>;
  secretFields: readonly string[];
};
export default connector;
`,
  );
  await writeFile(
    join(dir, "node_modules/@acme/warehouse/index.js"),
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
export default { type: "warehouse", configSchema: {}, secretFields: ["password"] };
`,
  );
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" })}\n`,
  );
  await writeFile(join(dir, "puppi.config.ts"), config);
  await writeFile(join(dir, "src/pipeline.ts"), pipeline);
  await writeFile(
    join(dir, "src/clearbit.ts"),
    `export class Client {
  constructor(
    readonly config: Record<string, unknown>,
    readonly secrets: Record<string, string>,
  ) {}
}
`,
  );
  await writeFile(join(dir, "tsconfig.json"), TSCONFIG);
  await writeFile(join(dir, "bindings.local.json"), `${JSON.stringify(bindings)}\n`);
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*", "puppi.config.ts", "puppi-env.d.ts"]
}
`;

function run(...argv: string[]): Promise<number> {
  return main(["try", ...argv, "--dir", dir, "--engine-url", "http://127.0.0.1:9"]);
}

function sent(): {
  storage_connection: string | null;
  bindings: Record<string, unknown>;
  inputs: Record<string, unknown>;
} {
  const raw = payloads.at(-1);

  expect(raw).toBeTruthy();

  return JSON.parse(raw ?? "") as {
    storage_connection: string | null;
    bindings: Record<string, unknown>;
    inputs: Record<string, unknown>;
  };
}
