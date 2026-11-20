import { createHash, createPublicKey, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { signingPayload } from "@puppi/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { Api, ApiError, type Deployment } from "../src/api.js";
import { pushDeployment, reportDeployment } from "../src/engine.js";
import { loadSigningKey, type SigningKey } from "../src/keys.js";
import type { Manifest } from "../src/manifest.js";
import { type EngineCall, type EngineReply, stubAnswers } from "./support/engine.js";
import { SIGNING_KEY } from "./support/signing-key.js";

const bytes = "export default { assets: {} };\n";
const hash = createHash("sha256").update(bytes).digest("hex");
const manifest: Manifest = {
  sdk_version: "0.2.0",
  lockfile_hash: "none",
  groups: [{ name: "default", visibility: "project" }],
  connections: {},
  assets: [],
};

let dir: string;
let bundlePath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "puppi-cli-"));
  bundlePath = join(dir, "bundle.js");
  await writeFile(bundlePath, bytes);
});

afterEach(() => {
  delete process.env["PUPPI_SIGNING_KEY"];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => rm(dir, { recursive: true, force: true }));

function engine(routes: Record<string, EngineReply>): EngineCall[] {
  const calls: EngineCall[] = [];

  stubAnswers(routes, calls);

  return calls;
}

const deployed = {
  id: "d1",
  status: "ready",
  active: true,
  validation: { errors: [], warnings: [] },
};

const head = (status: number): EngineReply => ({ status, body: undefined });

function deploy(
  api: Api,
  activate = true,
  allowContractChanges: string[] = [],
  signingKey?: SigningKey,
) {
  return pushDeployment(api, {
    environment: "prod",
    manifest,
    bundlePath,
    activate,
    allowContractChanges,
    git: { branch: "main", sha: "abc" },
    ...(signingKey ? { signingKey } : {}),
  });
}

describe("pushDeployment", () => {
  it("uploads a bundle the engine lacks, then posts the manifest referencing it", async () => {
    const calls = engine({
      [`HEAD /bundles/${hash}`]: head(404),
      [`PUT /bundles/${hash}`]: { status: 201, body: { ref: `sha256:${hash}`, created: true } },
      "POST /environments/prod/deployments": { status: 201, body: { data: deployed } },
    });
    const api = new Api({ url: "http://engine:4000/", token: "t0k" });

    expect(await deploy(api)).toEqual(deployed);
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "PUT", "POST"]);

    const [, put, post] = calls;

    expect(Buffer.from(put!.body as Uint8Array).toString()).toBe(bytes);
    expect(put!.headers["content-type"]).toBe("application/octet-stream");
    expect(put!.headers["authorization"]).toBe("Bearer t0k");
    expect(post!.body).toEqual({
      manifest,
      bundle_ref: `sha256:${hash}`,
      git: { branch: "main", sha: "abc" },
      sdk_version: "0.2.0",
      activate: true,
      allow_contract_changes: [],
      created_by: "cli",
    });
  });

  it("skips the upload when the engine already has the bundle", async () => {
    const calls = engine({
      [`HEAD /bundles/${hash}`]: head(200),
      "POST /environments/prod/deployments": { status: 201, body: { data: deployed } },
    });

    await deploy(new Api({ url: "http://engine:4000" }), false);

    expect(calls.map((call) => call.method)).toEqual(["HEAD", "POST"]);
    expect(calls[1]!.headers["authorization"]).toBeUndefined();
    expect((calls[1]!.body as { activate: boolean }).activate).toBe(false);
  });

  it("sends repeatable exact contract acknowledgements", async () => {
    const calls = engine({
      [`HEAD /bundles/${hash}`]: head(200),
      "POST /environments/prod/deployments": { status: 201, body: { data: deployed } },
    });

    await deploy(new Api({ url: "http://engine:4000" }), true, ["core/customer", "marts/revenue"]);

    expect(calls[1]!.body).toMatchObject({
      allow_contract_changes: ["core/customer", "marts/revenue"],
    });
  });

  it("returns a rejected deployment with its errors rather than throwing", async () => {
    const rejected = {
      ...deployed,
      status: "failed",
      active: false,
      validation: { errors: [{ kind: "unknown_role", message: "banana" }], warnings: [] },
    };
    engine({
      [`HEAD /bundles/${hash}`]: head(200),
      "POST /environments/prod/deployments": { status: 422, body: { data: rejected } },
    });

    expect(await deploy(new Api({ url: "http://engine:4000" }))).toEqual(rejected);
  });

  it("explains a refused token, a missing environment, and an engine that is down", async () => {
    engine({ [`HEAD /bundles/${hash}`]: { status: 401, body: { error: "unauthorized" } } });

    await expect(deploy(new Api({ url: "http://engine:4000" }))).rejects.toThrow(/puppi login/);

    engine({
      [`HEAD /bundles/${hash}`]: head(200),
      "POST /environments/prod/deployments": {
        status: 404,
        body: { error: "not found", detail: "no environment named prod" },
      },
    });

    await expect(deploy(new Api({ url: "http://engine:4000" }))).rejects.toThrow(
      "engine answered 404 not found: no environment named prod",
    );

    vi.unstubAllGlobals();

    const down = new Api({ url: "http://127.0.0.1:9" });

    await expect(deploy(down)).rejects.toThrow(ApiError);
    await expect(deploy(down)).rejects.toThrow(/unreachable at http:\/\/127\.0\.0\.1:9\/api\/v1/);
  });

  it("signs the bundle digest the worker will see", async () => {
    process.env["PUPPI_SIGNING_KEY"] = SIGNING_KEY;
    const key = await loadSigningKey(dir);

    if (!key) throw new Error("PUPPI_SIGNING_KEY was not read");

    const calls = engine({
      [`HEAD /bundles/${hash}`]: head(200),
      "POST /environments/prod/deployments": { status: 201, body: { data: deployed } },
    });

    await deploy(new Api({ url: "http://engine:4000" }), true, [], key);

    const body = calls[1]!.body as { signature: string; signing_key: string };
    const raw = Buffer.from(key.id.slice("ed25519:".length), "base64");
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
      format: "der",
      type: "spki",
    });

    expect(body.signing_key).toBe(key.id);
    expect(
      verify(
        null,
        Buffer.from(signingPayload({ kind: "deployment", bundle_digest: `sha256:${hash}` })),
        publicKey,
        Buffer.from(body.signature, "base64"),
      ),
    ).toBe(true);
  });
});

describe("reportDeployment", () => {
  it("prints an untrusted key as a warning and still succeeds", () => {
    const text = capture(() =>
      reportDeployment(
        {
          id: "d1",
          status: "ready",
          active: true,
          git: { branch: "main", sha: "abc" },
          created_by: "cli",
          validation: {
            errors: [],
            warnings: [
              {
                kind: "untrusted_signing_key",
                message: "no connected worker trusts abc",
              },
            ],
          },
          allow_contract_changes: [],
          inserted_at: "2026-10-16T00:00:00Z",
        },
        "prod",
      ),
    );

    expect(text.code).toBe(0);
    expect(text.stderr).toContain("warning: no connected worker trusts abc");
  });

  it("adds the bind command for an unbound connection, from its config_schema", () => {
    const text = capture(() =>
      reportDeployment(
        unbound("connection warehouse is declared but environment stage has no binding for it", {
          connection: "warehouse",
          environment: "stage",
        }),
        "stage",
        {
          connections: {
            warehouse: {
              type: "postgres",
              config_schema: {
                host: "string",
                port: "integer",
                database: "string",
                user: "string",
              },
              secret_fields: ["password"],
            },
          },
        },
      ),
    );

    expect(text.code).toBe(1);
    expect(text.stderr).toContain(
      'puppi env bind warehouse --env stage --config \'{"host":"YOUR_HOST","port":5432,"database":"YOUR_DATABASE","user":"YOUR_USER"}\' --secret-ref password=YOUR_PASSWORD',
    );
    expect(text.stderr).toContain(
      "puppi env secret YOUR_PASSWORD --env stage --from-env YOUR_PASSWORD",
    );
    expect(text.stderr).not.toMatch(/[<>…]/);
  });

  it("derives the bind command from whatever schema the connection declares", () => {
    const text = capture(() =>
      reportDeployment(
        unbound("connection stripe is declared but environment stage has no binding for it", {
          connection: "stripe",
        }),
        "stage",
        {
          connections: {
            stripe: {
              type: "http",
              config_schema: { base_url: "string" },
              secret_fields: ["api_key", "webhook"],
            },
          },
        },
      ),
    );

    expect(commands(text.stderr)).toEqual([
      'puppi env bind stripe --env stage --config \'{"base_url":"YOUR_BASE_URL"}\' --secret-ref api_key=YOUR_API_KEY --secret-ref webhook=YOUR_WEBHOOK',
      "puppi env secret YOUR_API_KEY --env stage --from-env YOUR_API_KEY",
      "puppi env secret YOUR_WEBHOOK --env stage --from-env YOUR_WEBHOOK",
    ]);
  });

  it("prints a config a shell can paste, with a value per field type", () => {
    const text = capture(() =>
      reportDeployment(
        unbound("connection lake is declared but environment stage has no binding for it", {
          connection: "lake",
        }),
        "stage",
        {
          connections: {
            lake: {
              type: "s3",
              config_schema: {
                bucket: "string",
                force_path_style: "boolean",
                port: "integer",
                timeout: "number",
                headers: "json",
              },
              secret_fields: ["access_key_id"],
            },
          },
        },
      ),
    );
    const [bind, ...secrets] = commands(text.stderr);
    const config = /--config '([^']*)'/.exec(bind ?? "")?.[1];

    expect(JSON.parse(config ?? "")).toEqual({
      bucket: "YOUR_BUCKET",
      force_path_style: false,
      port: 5432,
      timeout: 0,
      headers: {},
    });
    expect(secrets).toEqual([
      "puppi env secret YOUR_ACCESS_KEY_ID --env stage --from-env YOUR_ACCESS_KEY_ID",
    ]);
    expect(`${bind}\n${secrets.join("\n")}`).not.toMatch(/[<>…]/);
  });
});

function unbound(message: string, detail: Record<string, string>): Deployment {
  return {
    id: "d1",
    status: "failed",
    active: false,
    git: { branch: "main", sha: "abc" },
    created_by: "cli",
    validation: {
      errors: [{ kind: "unbound_connection", message, detail }],
      warnings: [],
    },
    allow_contract_changes: [],
    inserted_at: "2026-10-16T00:00:00Z",
  };
}

function capture(run: () => number): { code: number; stderr: string } {
  const stderr: string[] = [];

  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);

  try {
    return { code: run(), stderr: stderr.join("") };
  } finally {
    vi.restoreAllMocks();
  }
}

function commands(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => line.replace(/^ {2}/, ""))
    .filter((line) => line.startsWith("puppi env "));
}
