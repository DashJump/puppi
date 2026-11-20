/**
 * `@puppi/executor-js` is a dependency of the CLI. A copy in the project's
 * `node_modules` does not win.
 *
 * The adapter under test is installed only in the project. `puppi try`
 * loads the bundle from the project; `puppi worker start` downloads that same
 * bundle into a cache outside the project and runs it from the CLI's pool.
 */

import { execFileSync } from "node:child_process";
import type * as ChildProcess from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { stubDeploy } from "./support/engine.js";

const children: ChildProcess.ChildProcess[] = [];

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");

  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      children.push(child);
      return child;
    },
  };
});

const { harnessEntry, poolEntry } = await import("../src/harness.js");
const { main } = await import("../src/index.js");

const requireWs = createRequire(new URL("../../executor-js/package.json", import.meta.url));
const { WebSocketServer } = requireWs("ws") as {
  WebSocketServer: new (options: { noServer: true }) => {
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (socket: {
        readyState: number;
        send(data: string): void;
        on(event: "message", listener: (data: Buffer | string) => void): void;
        on(event: "error", listener: () => void): void;
      }) => void,
    ): void;
  };
};

const MARKER = "from-the-project";
const LOG = `project-adapter:${MARKER}`;

const EXECUTOR_EXPORTS = {
  name: "@puppi/executor-js",
  type: "module",
  exports: {
    "./local": "./dist/local/main.js",
    "./pool": "./dist/worker/pool.js",
  },
};

let scratch: string | undefined;

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env["PUPPI_WORKER_TOKEN"];

  for (const child of children.splice(0)) {
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
  }

  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe("a CLI install of @puppi/executor-js", () => {
  it("resolves from a hoisted global prefix, a nested install, and a pnpm dlx layout", async () => {
    scratch = await mkdtemp(join(tmpdir(), "puppi-executor-layout-"));

    const hoistedCli = join(scratch, "global/lib/node_modules/@puppi/cli");
    const nestedCli = join(scratch, "nested/node_modules/@puppi/cli");
    const dlxCli = join(scratch, "dlx/node_modules/.pnpm/@puppi+cli@0.1.0/node_modules/@puppi/cli");

    const layouts = [
      { cli: hoistedCli, executor: join(scratch, "global/lib/node_modules/@puppi/executor-js") },
      { cli: nestedCli, executor: join(nestedCli, "node_modules/@puppi/executor-js") },
      { cli: dlxCli, executor: join(dirname(dlxCli), "executor-js") },
    ];

    for (const layout of layouts) {
      await writeCli(layout.cli);
      await writeExecutor(layout.executor, "cli");
    }

    await mkdir(join(scratch, "dlx/node_modules/@puppi"), { recursive: true });
    await symlink(dlxCli, join(scratch, "dlx/node_modules/@puppi/cli"));

    const cliFiles = [
      join(hoistedCli, "dist/index.js"),
      join(nestedCli, "dist/index.js"),
      // What `pnpm dlx` puts on PATH: a symlink into the store.
      join(scratch, "dlx/node_modules/@puppi/cli/dist/index.js"),
    ];

    for (const [index, cliFile] of cliFiles.entries()) {
      const executor = layouts[index]!.executor;
      const stdout = execFileSync(process.execPath, [cliFile], { encoding: "utf8" });
      const resolved = JSON.parse(stdout) as { local: string; pool: string };

      expect(realpathSync(resolved.local)).toBe(realpathSync(join(executor, "dist/local/main.js")));
      expect(realpathSync(resolved.pool)).toBe(realpathSync(join(executor, "dist/worker/pool.js")));
    }
  });
});

describe("a project-local adapter", () => {
  it("runs from the CLI's executor for puppi try and puppi worker start", async () => {
    scratch = await mkdtemp(join(tmpdir(), "puppi-project-adapter-"));
    const project = join(scratch, "project");
    await writeProject(project);

    const resolve = createRequire(new URL("../src/harness.ts", import.meta.url));
    const cliLocal = resolve.resolve("@puppi/executor-js/local");
    const cliPool = resolve.resolve("@puppi/executor-js/pool");

    // The project has its own copy. It must not be the one that runs.
    expect(harnessEntry(project)).toBe(cliLocal);
    expect(poolEntry(project)).toBe(cliPool);
    expect(cliLocal.startsWith(project)).toBe(false);

    const stdout = spy();

    expect(await main(["try", "acme/things", "--dir", project])).toBe(0);
    expect(stdout()).toContain(LOG);
    expect(stdout()).not.toContain("stub-executor");

    const bundlePath = join(project, "out/bundle.js");
    const bundle = await readFile(bundlePath);
    const digest = `sha256:${createHash("sha256").update(bundle).digest("hex")}`;
    const engine = await fakeEngine(bundle);

    process.env["PUPPI_WORKER_TOKEN"] = "pwt_test";
    const pending = main([
      "worker",
      "start",
      "--dir",
      project,
      "--engine-url",
      `http://127.0.0.1:${engine.port}`,
    ]);

    try {
      await waitFor("ready", () => engine.frames.some((frame) => frame["message"] === "ready"));
      engine.send(lease(digest, join(scratch, "lake")));
      await waitFor("complete", () =>
        engine.frames.some((frame) => frame["message"] === "complete"),
      );

      expect(engine.frames.some((frame) => logLines(eventOf(frame)).includes(LOG))).toBe(true);

      const complete = engine.frames.find((frame) => frame["message"] === "complete");
      expect(complete?.["result"]).toEqual(expect.objectContaining({ event: "result" }));

      for (const child of children) child.kill("SIGTERM");
      expect(await pending).toBe(0);
    } finally {
      engine.close();
      for (const child of children) {
        if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      }
    }
  }, 20_000);

  it("compiles, bundles, and deploys without a project dependency on @puppi/executor-js", async () => {
    scratch = await mkdtemp(join(tmpdir(), "puppi-project-adapter-"));
    const project = join(scratch, "project");
    await writeProject(project);

    const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.dependencies ?? {}).not.toHaveProperty("@puppi/executor-js");
    expect(pkg.devDependencies ?? {}).not.toHaveProperty("@puppi/executor-js");

    const stdout = spy();

    stubDeploy();

    expect(
      await main([
        "deploy",
        "--dir",
        project,
        "--env",
        "dev",
        "--engine-url",
        "http://engine:4000",
      ]),
    ).toBe(0);
    expect(stdout()).toContain("deployed d1");
    expect(stdout()).toContain("acme/things");
  });
});

function spy(): () => string {
  let text = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    text += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  return () => text;
}

async function writeCli(dir: string): Promise<void> {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "@puppi/cli", type: "module" }),
  );
  await writeFile(
    join(dir, "dist/index.js"),
    [
      'import { createRequire } from "node:module";',
      "const resolve = createRequire(import.meta.url);",
      'const local = resolve.resolve("@puppi/executor-js/local");',
      'const pool = resolve.resolve("@puppi/executor-js/pool");',
      "process.stdout.write(JSON.stringify({ local, pool }));",
      "",
    ].join("\n"),
  );
}

async function writeExecutor(dir: string, kind: "cli" | "stub"): Promise<void> {
  await mkdir(join(dir, "dist/local"), { recursive: true });
  await mkdir(join(dir, "dist/worker"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(EXECUTOR_EXPORTS));

  const body =
    kind === "stub" ? `process.stderr.write("stub-executor\\n"); process.exit(1);\n` : "";

  await writeFile(join(dir, "dist/local/main.js"), body);
  await writeFile(join(dir, "dist/worker/pool.js"), body);
}

async function writeProject(project: string): Promise<void> {
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "node_modules/@acme/widget"), { recursive: true });
  await writeExecutor(join(project, "node_modules/@puppi/executor-js"), "stub");

  await writeFile(
    join(project, "package.json"),
    JSON.stringify(
      {
        name: "acme-pipeline",
        private: true,
        type: "module",
        dependencies: { "@puppi/sdk": "0.1.0" },
        devDependencies: { "@puppi/cli": "0.1.0" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(project, "node_modules/@acme/widget/package.json"),
    JSON.stringify({ name: "@acme/widget", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(project, "node_modules/@acme/widget/index.d.ts"),
    `export class Client {
  constructor(config: Record<string, unknown>, secrets?: Record<string, string>);
  ping(): string;
}
`,
  );
  await writeFile(
    join(project, "node_modules/@acme/widget/index.js"),
    `export class Client {
  constructor(config) {
    this.marker = String(config.marker ?? "");
  }
  ping() {
    return "project-adapter:" + this.marker;
  }
}
`,
  );
  await mkdir(join(project, "node_modules/@acme/lake"), { recursive: true });
  await writeFile(
    join(project, "node_modules/@acme/lake/package.json"),
    JSON.stringify({ name: "@acme/lake", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(project, "node_modules/@acme/lake/index.d.ts"),
    `export class Client {
  constructor(config: Record<string, unknown>, secrets: Record<string, string>);
  write(storageRef: string, rows: unknown): Promise<{
    storage_ref: string;
    observed_schema: [];
    stats: { row_count: number; bytes: null; content_hash: null };
  }>;
  read(): Promise<unknown[]>;
  query(): Promise<unknown[]>;
  drop(): Promise<void>;
  close(): Promise<void>;
}
`,
  );
  await writeFile(
    join(project, "node_modules/@acme/lake/index.js"),
    `export class Client {
  async write(storageRef, rows) {
    const rowCount = Array.isArray(rows) ? rows.length : 0;
    return {
      storage_ref: storageRef,
      observed_schema: [],
      stats: { row_count: rowCount, bytes: null, content_hash: null },
    };
  }
  async read() {
    return [];
  }
  async query() {
    return [];
  }
  async drop() {}
  async close() {}
}
`,
  );
  await writeFile(
    join(project, "puppi.config.ts"),
    `import { defineConfig } from "@puppi/sdk";
import { Client as Lake } from "@acme/lake";
import { Client } from "@acme/widget";

export default defineConfig({
  entry: "src/pipeline.ts",
  out: "out",
  connections: {
    lake: {
      type: "lake",
      configSchema: {},
      secretFields: [],
      clientModule: "@acme/lake",
      Client: Lake,
    },
    acme: {
      type: "acme",
      configSchema: { marker: "string" },
      secretFields: [],
      clientModule: "@acme/widget",
      Client,
    },
  },
});
`,
  );
  await writeFile(
    join(project, "src/pipeline.ts"),
    `import { source } from "@puppi/sdk";
import { type Client } from "@acme/widget";

export const things = source({
  key: "acme/things",
  run: async (ctx) => {
    const api = ctx.connection("acme") as Client;
    ctx.log(api.ping());
    await ctx.emit([{ id: "1" }]);
  },
});
`,
  );
  await mkdir(join(project, "node_modules/@puppi"), { recursive: true });
  const resolvePackage = createRequire(import.meta.url);

  await symlink(
    dirname(resolvePackage.resolve("@puppi/sdk/package.json")),
    join(project, "node_modules/@puppi/sdk"),
  );
  await symlink(
    dirname(resolvePackage.resolve("typescript/package.json")),
    join(project, "node_modules/typescript"),
  );
  await writeFile(
    join(project, "tsconfig.json"),
    `{
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
`,
  );
  await writeFile(
    join(project, "bindings.local.json"),
    JSON.stringify({
      environment: "dev",
      bindings: {
        acme: { config: { marker: MARKER }, secret_refs: {} },
      },
      secrets: {},
    }),
  );
}

interface Engine {
  port: number;
  frames: Record<string, unknown>[];
  send(frame: unknown): void;
  close(): void;
}

async function fakeEngine(bundle: Buffer): Promise<Engine> {
  const frames: Record<string, unknown>[] = [];
  const sockets: { readyState: number; send(data: string): void }[] = [];
  const server = createServer((request, response) => {
    onRequest(request, response);
  });
  const socketsServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    socketsServer.handleUpgrade(request, socket, head, (ws) => {
      sockets.push(ws);
      ws.on("message", (data) => {
        const text = typeof data === "string" ? data : data.toString("utf8");
        const parsed: unknown = JSON.parse(text);
        if (!isRecord(parsed)) return;

        frames.push(parsed);

        if (parsed["message"] === "event") {
          ws.send(
            JSON.stringify({
              message: "settled",
              attempt_id: parsed["attempt_id"],
              fence: parsed["fence"],
              fenced: false,
            }),
          );
        }

        if (parsed["message"] === "complete") {
          ws.send(
            JSON.stringify({
              message: "settled",
              attempt_id: parsed["attempt_id"],
              fence: parsed["fence"],
              outcome: "recorded",
            }),
          );
        }
      });
      ws.on("error", () => undefined);
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no TCP address");

  return {
    port: address.port,
    frames,
    send(frame: unknown) {
      const open = sockets.filter((socket) => socket.readyState === 1);
      const current = open[open.length - 1];
      if (!current) throw new Error("no worker socket");
      current.send(JSON.stringify(frame));
    },
    close() {
      server.close();
    },
  };

  function onRequest(request: IncomingMessage, response: ServerResponse): void {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

    if (request.url === "/api/v1/executor/claims/bundle" && token === "claim-acme") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(bundle);
      return;
    }

    response.writeHead(404);
    response.end();
  }
}

function lease(digest: string, root: string): Record<string, unknown> {
  return {
    message: "lease",
    claim_token: "claim-acme",
    execution: {
      attempt_id: "attempt-1",
      run_id: "run-1",
      fence: 1,
      runtime_profile: "remote-node",
      bundle_digest: digest,
      output_materialization_id: "mat-attempt-1",
      lease_expires_at: null,
      deadline_at: null,
    },
    input: {
      bundle_ref: "engine-local",
      sdk_version: "0.1.0",
      asset_key: "acme/things",
      partition: "",
      inputs: {},
      checkpoint: null,
      cursor_from: null,
      bindings: {
        lake: { type: "lake", config: { root }, secrets: {}, mode: "live" },
        acme: { type: "acme", config: { marker: MARKER }, secrets: {}, mode: "live" },
      },
      storage_connection: "lake",
      output_storage_ref: "out.acme",
    },
  };
}

function eventOf(frame: Record<string, unknown>): Record<string, unknown> {
  const event = frame["event"];
  return isRecord(event) ? event : {};
}

function logLines(event: Record<string, unknown>): string[] {
  if (event["event"] !== "logs" || !Array.isArray(event["lines"])) return [];

  return event["lines"].flatMap((line) =>
    isRecord(line) && typeof line["message"] === "string" ? [line["message"]] : [],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitFor(label: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}
