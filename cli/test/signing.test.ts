/**
 * Signing, worker-held secrets, and the pool view.
 *
 * These cases drive `main`. A worker verifier rebuilds `type` from the
 * signed payload and calls `admit`.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { main } from "../src/index.js";
import { loadSigningKey, type SigningKey } from "../src/keys.js";
import { type EngineCall, stubDeploy, stubEngine } from "./support/engine.js";
import { copyProjectFixture, removeProjectFixture } from "./support/project-fixture.js";
import { OTHER_SIGNING_KEY, SIGNING_KEY } from "./support/signing-key.js";

type Call = EngineCall;

let calls: Call[];
let stdout: string;
let stderr: string;
let dir: string;

function engine(routes: Record<string, unknown>): void {
  stubEngine(routes, calls);
}

function run(...argv: string[]): Promise<number> {
  return main([...argv, "--engine-url", "http://engine:4000", "--env", "prod", "--dir", dir]);
}

/** The warning the CLI prints for an unsigned remote write. */
const REMOTE_UNSIGNED =
  "A remote worker with trusted keys will refuse this unsigned row until you set PUPPI_SIGNING_KEY, --signing-key, PUPPI_SIGNING_KEY_FILE, or puppi-signing-key.";

function expectNoSigningLine(): void {
  expect(stderr).not.toContain("unsigned");
  expect(stderr).not.toContain("NOT SIGNED");
  expect(stderr).not.toContain("signing");
  expect(stderr).not.toContain("refuse");
}

beforeEach(async () => {
  calls = [];
  stdout = "";
  stderr = "";
  dir = await mkdtemp(join(tmpdir(), "puppi-keys-"));
  delete process.env["PUPPI_SIGNING_KEY"];
  delete process.env["PUPPI_SIGNING_KEY_FILE"];
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
  vi.unstubAllGlobals();
  delete process.env["PUPPI_SIGNING_KEY"];
  delete process.env["PUPPI_SIGNING_KEY_FILE"];
  await rm(dir, { recursive: true, force: true });
});

describe("puppi keys create", () => {
  it("writes the seed and prints the public key", async () => {
    expect(await run("keys", "create")).toBe(0);

    const file = await readFile(join(dir, "puppi-signing-key"), "utf8");
    const printed = stdout.trim();
    const material = file.trim();

    expect(printed.startsWith("ed25519:")).toBe(true);
    expect(material.startsWith("ed25519:")).toBe(true);
    expect(printed).not.toBe(material);
    expect(file).not.toContain(printed);
    expect(stderr).toContain(
      createHash("sha256")
        .update(Buffer.from(printed.slice("ed25519:".length), "base64"))
        .digest("hex"),
    );
    expect((await stat(join(dir, "puppi-signing-key"))).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite a key, and reads PUPPI_SIGNING_KEY instead of minting one", async () => {
    expect(await run("keys", "create", "--out", join(dir, "key"))).toBe(0);

    const id = stdout.trim();
    const material = (await readFile(join(dir, "key"), "utf8")).trim();

    expect(await run("keys", "create", "--out", join(dir, "key"))).toBe(2);
    expect(stderr).toContain("already exists");

    stdout = "";
    stderr = "";
    process.env["PUPPI_SIGNING_KEY"] = material;

    expect(await main(["keys", "create", "--dir", dir, "--engine-url", "http://engine:4000"])).toBe(
      0,
    );
    expect(stdout.trim()).toBe(id);
    expect(stderr).toContain("read PUPPI_SIGNING_KEY");
  });
});

/** The key `PUPPI_SIGNING_KEY` makes the CLI load. */
async function useKey(material = SIGNING_KEY): Promise<SigningKey> {
  process.env["PUPPI_SIGNING_KEY"] = material;
  const key = await loadSigningKey(dir);

  if (!key) throw new Error("PUPPI_SIGNING_KEY was not read");

  return key;
}

describe("signed writes", () => {
  it("sends a signature for an environment and a binding", async () => {
    const key = await useKey();
    engine({
      "GET /environments": [],
      "POST /environments": {
        id: "e1",
        name: "prod",
        kind: "persistent",
        storage_prefix: "prod",
        strict: false,
        schedules_paused: false,
        executor: "remote",
        signature: "stored",
        signing_key: key.id,
        active_deployment_id: null,
        inserted_at: "2026-10-16T00:00:00Z",
      },
      "PUT /environments/prod/bindings/warehouse": {
        name: "warehouse",
        config: { host: "warehouse.internal" },
        secret_refs: { password: "warehouse_password" },
        mode: "live",
        signature: "stored",
        signing_key: key.id,
        updated_at: "2026-10-16T00:00:00Z",
      },
    });

    expect(await run("env", "create", "prod", "--executor", "remote")).toBe(0);

    const created = calls.find((call) => call.method === "POST")?.body as {
      signature: string;
      signing_key: string;
    };

    expect(created.signing_key).toBe(key.id);
    expect(created.signature).toEqual(expect.any(String));
    expect(created.signature.length).toBeGreaterThan(0);
    expect(stdout).toContain("signed by");

    await writeFile(
      join(dir, "puppi.config.ts"),
      [
        'import { defineConfig } from "@puppi/sdk";',
        "class Client { constructor(config, secrets) { this.config = config; this.secrets = secrets; } }",
        "export default defineConfig({",
        '  connections: { warehouse: { type: "postgres", Client, clientModule: "./warehouse.js" } },',
        "});",
        "",
      ].join("\n"),
    );

    expect(
      await run(
        "env",
        "bind",
        "warehouse",
        "--type",
        "postgres",
        "--config",
        '{"host":"warehouse.internal"}',
        "--secret-ref",
        "password=warehouse_password",
      ),
    ).toBe(0);

    const bound = calls.find((call) => call.method === "PUT")?.body as {
      signature: string;
      signing_key: string;
    };

    expect(bound.signing_key).toBe(key.id);
    expect(bound.signature).toEqual(expect.any(String));
    expect(bound.signature.length).toBeGreaterThan(0);
  });

  it("rejects --executor local before it reads the environment", async () => {
    await useKey();
    engine({ "GET /environments": [] });

    expect(await run("env", "create", "prod", "--executor", "local")).toBe(2);
    expect(stderr).toContain("--executor hosted|remote");
    expect(stderr).not.toContain("not signed by");
    expect(calls).toEqual([]);
  });

  it("exits 2 when an existing environment is not signed by this key", async () => {
    await useKey();
    engine({
      "GET /environments": [
        {
          id: "e1",
          name: "prod",
          kind: "persistent",
          storage_prefix: "prod",
          strict: false,
          schedules_paused: false,
          executor: "remote",
          signature: null,
          signing_key: null,
          active_deployment_id: null,
          inserted_at: "2026-10-16T00:00:00Z",
        },
      ],
    });

    expect(await run("env", "create", "prod", "--executor", "remote")).toBe(2);
    expect(stderr).toContain("not signed by");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("exits 2 before posting placement when the stored executor differs", async () => {
    await useKey();
    engine({
      "GET /environments": [
        {
          id: "e1",
          name: "prod",
          kind: "persistent",
          storage_prefix: "prod",
          strict: false,
          schedules_paused: false,
          executor: "local",
          signature: null,
          signing_key: null,
          active_deployment_id: null,
          inserted_at: "2026-10-16T00:00:00Z",
        },
      ],
      "POST /environments/prod/placement": {
        id: "e1",
        name: "prod",
        kind: "persistent",
        storage_prefix: "prod",
        strict: false,
        schedules_paused: false,
        executor: "remote",
        signature: null,
        signing_key: null,
        active_deployment_id: null,
        inserted_at: "2026-10-16T00:00:00Z",
      },
    });

    expect(await run("env", "create", "prod", "--executor", "remote")).toBe(2);
    expect(stderr).toContain("not signed by");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /environments"]);
  });

  it("places an existing unsigned environment on hosted without refusing the key", async () => {
    await useKey();
    const stored = {
      id: "e1",
      name: "prod",
      kind: "persistent",
      storage_prefix: "prod",
      strict: false,
      schedules_paused: false,
      executor: "local",
      signature: null,
      signing_key: null,
      active_deployment_id: null,
      inserted_at: "2026-10-16T00:00:00Z",
    };

    engine({
      "GET /environments": [stored],
      "POST /environments/prod/placement": { ...stored, executor: "hosted" },
    });

    expect(await run("env", "create", "prod", "--executor", "hosted")).toBe(0);
    expect(stderr).not.toContain("not signed by");
    expectNoSigningLine();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /environments",
      "POST /environments/prod/placement",
    ]);
    expect(calls[1]?.body).toEqual({ executor: "hosted" });
  });

  it("does not warn when an existing environment keeps its signature", async () => {
    engine({
      "GET /environments": [
        {
          id: "e1",
          name: "prod",
          kind: "persistent",
          storage_prefix: "prod",
          strict: false,
          schedules_paused: false,
          executor: "remote",
          signature: "sig",
          signing_key: "ed25519:kept",
          active_deployment_id: null,
          inserted_at: "2026-10-16T00:00:00Z",
        },
      ],
    });

    expect(await run("env", "create", "prod", "--executor", "remote")).toBe(0);
    expect(stderr).not.toContain("NOT SIGNED");
    expect(stderr).not.toContain(REMOTE_UNSIGNED);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("says so when no key is configured, and still creates the environment", async () => {
    engine({
      "GET /environments": [],
      "POST /environments": {
        id: "e1",
        name: "prod",
        kind: "persistent",
        storage_prefix: "prod",
        strict: false,
        schedules_paused: false,
        executor: "remote",
        signature: null,
        signing_key: null,
        active_deployment_id: null,
        inserted_at: "2026-10-16T00:00:00Z",
      },
    });

    expect(await run("env", "create", "prod", "--executor", "remote")).toBe(0);
    expect(stderr).toContain(REMOTE_UNSIGNED);
    expect(stderr).not.toContain("NOT SIGNED");
    expect(calls.find((call) => call.method === "POST")?.body).not.toHaveProperty("signature");
  });

  it("lets PUPPI_SIGNING_KEY beat --signing-key, and a missing key file is an error", async () => {
    const envKey = await useKey();
    const fileKey = await useKey(OTHER_SIGNING_KEY);

    await writeFile(join(dir, "file-key"), `${fileKey.material}\n`);
    process.env["PUPPI_SIGNING_KEY"] = envKey.material;
    engine({
      "GET /environments": [],
      "POST /environments": {
        id: "e1",
        name: "prod",
        kind: "persistent",
        storage_prefix: "prod",
        strict: false,
        schedules_paused: false,
        executor: "hosted",
        signature: "stored",
        signing_key: envKey.id,
        active_deployment_id: null,
        inserted_at: "2026-10-16T00:00:00Z",
      },
    });

    expect(await run("env", "create", "prod", "--signing-key", join(dir, "file-key"))).toBe(0);
    const created = calls.find((call) => call.method === "POST")?.body as
      | { signing_key?: string; executor?: string }
      | undefined;

    expect(created?.signing_key).toBe(envKey.id);
    expect(created).toMatchObject({ executor: "hosted" });

    delete process.env["PUPPI_SIGNING_KEY"];
    process.env["PUPPI_SIGNING_KEY_FILE"] = join(dir, "missing-key");
    expect(await run("env", "create", "prod")).toBe(2);
    expect(stderr).toContain("no signing key");
  });

  it("refuses a --type that is not the type puppi.config.ts declares", async () => {
    await useKey();
    await writeFile(
      join(dir, "puppi.config.ts"),
      [
        'import { defineConfig } from "@puppi/sdk";',
        "class Client { constructor(config, secrets) { this.config = config; this.secrets = secrets; } }",
        "export default defineConfig({",
        '  connections: { warehouse: { type: "postgres", Client, clientModule: "./warehouse.js" } },',
        "});",
        "",
      ].join("\n"),
    );
    engine({});

    expect(
      await run(
        "env",
        "bind",
        "warehouse",
        "--type",
        "clickhouse",
        "--config",
        '{"host":"warehouse.internal"}',
      ),
    ).toBe(2);
    expect(stderr).toContain("not the type in puppi.config.ts (postgres)");
    expect(calls).toEqual([]);
  });

  it("refuses a re-bind that would leave a signature over a new config", async () => {
    engine({
      "GET /environments/prod/bindings": [
        {
          name: "warehouse",
          config: { host: "warehouse.internal" },
          secret_refs: { password: "warehouse_password" },
          mode: "live",
          signature: "sig",
          signing_key: "ed25519:old",
          updated_at: "2026-10-16T00:00:00Z",
        },
      ],
    });

    expect(await run("env", "bind", "warehouse", "--config", '{"host":"evil.example"}')).toBe(2);
    expect(stderr).not.toContain("NOT SIGNED");
    expect(stderr).toContain("different config");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("keeps a signature when the config is unchanged and does not warn", async () => {
    const stored = {
      name: "warehouse",
      config: { host: "warehouse.internal" },
      secret_refs: { password: "warehouse_password" },
      mode: "live",
      signature: "sig",
      signing_key: "ed25519:old",
      updated_at: "2026-10-16T00:00:00Z",
    };

    engine({
      "GET /environments/prod/bindings": [stored],
      "PUT /environments/prod/bindings/warehouse": stored,
    });

    expect(
      await run(
        "env",
        "bind",
        "warehouse",
        "--json",
        "--config",
        '{"host":"warehouse.internal"}',
        "--secret-ref",
        "password=warehouse_password",
      ),
    ).toBe(0);
    expect(stderr).not.toContain("NOT SIGNED");

    const sent = calls.find((call) => call.method === "PUT")?.body as Record<string, unknown>;

    expect(sent).not.toHaveProperty("signature");
    expect(sent).not.toHaveProperty("signing_key");
    expect(JSON.parse(stdout)).toMatchObject({ signature: "sig", signing_key: "ed25519:old" });
  });

  it("refuses to sign a --type for a connection the project does not declare", async () => {
    const key = await useKey();
    await writeFile(
      join(dir, "puppi.config.ts"),
      [
        'import { defineConfig } from "@puppi/sdk";',
        "class Client { constructor(config, secrets) { this.config = config; this.secrets = secrets; } }",
        "export default defineConfig({",
        '  connections: { warehouse: { type: "postgres", Client, clientModule: "./warehouse.js" } },',
        "});",
        "",
      ].join("\n"),
    );
    engine({
      "PUT /environments/prod/bindings/other": {
        name: "other",
        config: {},
        secret_refs: {},
        mode: "live",
        signature: "would-not-verify",
        signing_key: key.id,
        updated_at: "2026-10-16T00:00:00Z",
      },
    });

    expect(await run("env", "bind", "other", "--type", "postgres", "--config", "{}")).toBe(2);
    expect(stderr).toContain("not declared in puppi.config.ts");
    expect(calls).toEqual([]);
  });

  it("warns and binds when nothing was signed yet", async () => {
    engine({
      "GET /environments/prod/bindings": [],
      "PUT /environments/prod/bindings/warehouse": {
        name: "warehouse",
        config: { host: "warehouse.internal" },
        secret_refs: {},
        mode: "live",
        signature: null,
        signing_key: null,
        updated_at: "2026-10-16T00:00:00Z",
      },
    });

    expect(await run("env", "bind", "warehouse", "--config", '{"host":"warehouse.internal"}')).toBe(
      0,
    );
    expect(stderr).toContain("NOT SIGNED");
    expect(calls.find((call) => call.method === "PUT")?.body).not.toHaveProperty("signature");
  });

  it("keeps env create and env bind --json parseable for each placement", async () => {
    const created = {
      id: "e1",
      name: "prod",
      kind: "persistent",
      storage_prefix: "prod",
      strict: false,
      schedules_paused: false,
      signature: null,
      signing_key: null,
      active_deployment_id: null,
      inserted_at: "2026-10-16T00:00:00Z",
    };
    const binding = {
      name: "warehouse",
      config: {},
      secret_refs: {},
      mode: "live",
      signature: null,
      signing_key: null,
      updated_at: "2026-10-16T00:00:00Z",
    };

    expect(await run("env", "create", "prod", "--executor", "local", "--json")).toBe(2);
    expect(stderr).toContain("--executor hosted|remote");
    expect(calls).toEqual([]);

    for (const executor of ["remote", "hosted"]) {
      calls = [];
      stdout = "";
      stderr = "";
      engine({
        "GET /environments": [],
        "POST /environments": { ...created, executor },
      });

      expect(await run("env", "create", "prod", "--executor", executor, "--json")).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ name: "prod", executor });
      expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ executor });

      if (executor === "hosted") expectNoSigningLine();
      else expect(stderr).toContain(REMOTE_UNSIGNED);

      calls = [];
      stdout = "";
      stderr = "";
      engine({
        "GET /environments/prod": { ...created, executor },
        "GET /environments/prod/bindings": [],
        "PUT /environments/prod/bindings/warehouse": binding,
      });

      expect(await run("env", "bind", "warehouse", "--json", "--config", "{}")).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ name: "warehouse" });

      if (executor === "hosted") expectNoSigningLine();
      else expect(stderr).toContain(REMOTE_UNSIGNED);
    }
  });

  it("declares a secret on the worker and shows placement, backend, and signing key", async () => {
    engine({
      "PUT /environments/prod/secrets/warehouse_password": {
        name: "warehouse_password",
        backend: "worker",
        version: null,
        rotated_at: null,
      },
      "GET /environments/prod": {
        id: "e1",
        name: "prod",
        kind: "persistent",
        storage_prefix: "out",
        strict: false,
        schedules_paused: false,
        executor: "remote",
        signature: "sig",
        signing_key: "ed25519:env",
        active_deployment_id: "d1",
        inserted_at: "2026-10-16T00:00:00Z",
      },
      "GET /environments/prod/bindings": [
        {
          name: "warehouse",
          config: { host: "warehouse.internal" },
          secret_refs: { password: "warehouse_password" },
          mode: "live",
          signature: "sig",
          signing_key: "ed25519:bind",
          updated_at: "2026-10-16T00:00:00Z",
        },
      ],
      "GET /environments/prod/secrets": [
        { name: "warehouse_password", backend: "worker", version: null, rotated_at: null },
      ],
      "GET /environments/prod/deployments?active=true": [
        {
          id: "d1",
          status: "ready",
          active: true,
          signing_key: "ed25519:deploy",
          validation: { errors: [], warnings: [] },
        },
      ],
    });

    expect(await run("env", "secret", "warehouse_password", "--on-worker")).toBe(0);
    expect(calls[0]?.body).toEqual({ on_worker: true });
    expect(stdout).toContain("declared on the worker");
    expect(stdout).not.toContain("version");

    stdout = "";
    expect(await run("env", "show")).toBe(0);
    expect(stdout).toContain("executor remote");
    expect(stdout).toContain("signed by ed25519:env");
    expect(stdout).toContain("signed by ed25519:deploy");
    expect(stdout).toContain("ed25519:bind");
    expect(stdout).toContain("worker");
    expect(stdout).toContain("on worker");
    expect(calls.some((call) => call.path === "/environments/prod/deployments?active=true")).toBe(
      true,
    );
  });

  it("refuses --on-worker together with a value", async () => {
    engine({});

    expect(await run("env", "secret", "warehouse_password", "--on-worker", "--value", "x")).toBe(2);
    expect(stderr).toContain("takes no value");
    expect(calls).toEqual([]);
  });
});

describe("unsigned deploy", () => {
  let fixture: string;

  beforeEach(async () => {
    fixture = await copyProjectFixture();
  });

  afterEach(async () => {
    await removeProjectFixture(fixture);
  });

  function deploy(): Promise<number> {
    return main([
      "deploy",
      "--dir",
      fixture,
      "--env",
      "prod",
      "--engine-url",
      "http://engine:4000",
    ]);
  }

  it("says the bundle is not signed when no key file is configured", async () => {
    let body: Record<string, unknown> | undefined;

    stubDeploy({
      onDeployment(parsed) {
        body = parsed;
      },
    });

    expect(await deploy()).toBe(0);
    expect(stderr).toContain("NOT SIGNED");
    expect(body).not.toHaveProperty("signature");
    expect(body).not.toHaveProperty("signing_key");
  });

  it("warns on deploy when the stored executor is not hosted", async () => {
    stubDeploy({ executor: "local" });

    expect(await deploy()).toBe(0);
    expect(stderr).toContain("NOT SIGNED");
    expect(stderr).not.toContain("does not check signatures");
  });

  it("prints nothing about signing on deploy when the executor is hosted", async () => {
    stubDeploy({ executor: "hosted" });

    expect(await deploy()).toBe(0);
    expectNoSigningLine();
    expect(stdout).not.toContain("does not check signatures");
    expect(stdout).not.toContain("NOT SIGNED");
  });

  it("prints NOT SIGNED when the stored placement is one this CLI does not know", async () => {
    stubDeploy({ executor: "edge" });

    expect(await deploy()).toBe(0);
    expect(stderr).toContain("NOT SIGNED");
    expect(stderr).not.toContain("does not check signatures");
  });
});

describe("puppi worker", () => {
  it("creates, lists and revokes tokens, and the token is not in the list", async () => {
    engine({
      "POST /worker-tokens": {
        id: "t1",
        name: "droplet-1",
        token: "pwt_once",
        last_used_at: null,
        inserted_at: null,
      },
      "GET /worker-tokens": [
        { id: "t1", name: "droplet-1", last_used_at: null, inserted_at: "2026-10-16T00:00:00Z" },
      ],
      "DELETE /worker-tokens/t1": { id: "t1" },
    });

    expect(await run("worker", "token", "create", "droplet-1")).toBe(0);
    expect(stdout.trim()).toBe("pwt_once");
    expect(stderr).toContain("shown once");
    expect(calls[0]?.body).toEqual({ name: "droplet-1" });

    stdout = "";
    expect(await run("worker", "token", "list")).toBe(0);
    expect(stdout).toContain("droplet-1");
    expect(stdout).not.toContain("pwt_once");

    expect(await run("worker", "token", "revoke", "t1")).toBe(0);
    expect(stdout).toContain("revoked t1");
  });

  it("prints last used with its zone, and --json keeps the full value", async () => {
    const lastUsedAt = "2026-10-16T00:00:00.654321Z";
    const insertedAt = "2026-10-19T18:30:00.654321+02:00";

    engine({
      "GET /worker-tokens": [
        { id: "t1", name: "droplet-1", last_used_at: lastUsedAt, inserted_at: insertedAt },
      ],
    });

    expect(await run("worker", "token", "list")).toBe(0);
    expect(stdout).toContain("2026-10-16T00:00:00Z");
    expect(stdout).not.toContain(lastUsedAt);

    stdout = "";
    expect(await run("worker", "token", "list", "--json")).toBe(0);

    const printed = JSON.parse(stdout) as { last_used_at: string; inserted_at: string }[];

    expect(printed[0]?.last_used_at).toBe(lastUsedAt);
    expect(printed[0]?.inserted_at).toBe(insertedAt);
  });

  it("shows slots, version, residency, the trusted key, and a missing secret", async () => {
    engine({
      "GET /environments/prod/secrets": [
        { name: "warehouse_password", backend: "worker", version: null, rotated_at: null },
        { name: "api_token", backend: "local", version: 1, rotated_at: null },
      ],
      "GET /workers": {
        queue_depth: 2,
        workers: [
          {
            id: "droplet-1",
            version: "0.4",
            residency: "strict",
            free_slots: 3,
            attempts: [],
            secrets: [],
            trusted_keys: ["b24c9f16c4d63525a874cf87f63011b1b88a7bf279a3b6f35726d62e75c890bc"],
          },
        ],
      },
    });

    expect(await run("worker", "list")).toBe(0);
    expect(stdout).toContain("queue depth 2");
    expect(stdout).toContain("droplet-1");
    expect(stdout).toContain("0.4");
    expect(stdout).toContain("strict");
    expect(stdout).toContain("b24c9f16c4d63525a874cf87f63011b1b88a7bf279a3b6f35726d62e75c890bc");
    expect(stdout).toContain("warehouse_password");
    expect(stdout).not.toContain("api_token");
  });

  it("is a usage error without a token name", async () => {
    engine({});

    expect(await run("worker", "token", "create")).toBe(2);
    expect(stderr).toContain("needs a name");
  });
});
