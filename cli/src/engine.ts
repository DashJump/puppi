import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { type Api, type Deployment, type Issue, envPath } from "./api.js";
import { signSubject, type SigningKey } from "./keys.js";
import type { Manifest } from "./manifest.js";
import { err, out } from "./print.js";

const run = promisify(execFile);

export interface GitProvenance {
  branch: string;
  sha: string;
}

export interface DeployOptions {
  environment: string;
  manifest: Manifest;
  bundlePath: string;
  activate: boolean;
  allowContractChanges?: string[];
  git: GitProvenance;
  /** When set, the deployment is signed over `sha256:<bundle hash>`. */
  signingKey?: SigningKey;
}

/**
 * A deployment is two artifacts: the bundle goes up by content hash, only
 * when the engine does not have it, and then the manifest references it.
 * A rejected manifest is still a deployment row — a 422 carrying its
 * validation errors — so it comes back rather than throwing.
 */
export async function pushDeployment(api: Api, options: DeployOptions): Promise<Deployment> {
  const bundleRef = await uploadBundle(api, options.bundlePath);
  const signed = options.signingKey
    ? signSubject({ kind: "deployment", bundle_digest: bundleRef }, options.signingKey)
    : undefined;

  return api.post<Deployment>(envPath(options.environment, "/deployments"), {
    manifest: options.manifest,
    bundle_ref: bundleRef,
    git: options.git,
    sdk_version: options.manifest.sdk_version,
    activate: options.activate,
    allow_contract_changes: options.allowContractChanges ?? [],
    created_by: "cli",
    ...signed,
  });
}

/** The sentence a successful deploy prints. `--json` keeps it out of stdout. */
export function deploymentLine(result: Deployment, environment: string): string {
  return result.active
    ? `deployed ${result.id} and activated it in ${environment}`
    : `deployed ${result.id} to ${environment} (not activated)`;
}

/**
 * What a deploy prints after its build summary. A warning, including
 * `untrusted_signing_key`, does not fail the command: the worker is what
 * refuses a key it does not trust. Errors stay on stderr.
 */
export function reportDeployment(
  result: Deployment,
  environment: string,
  manifest?: Pick<Manifest, "connections">,
): number {
  for (const warning of result.validation.warnings) err(`  warning: ${warning.message}`);

  if (result.status === "failed") {
    for (const error of result.validation.errors) {
      err(`  ${error.kind}: ${error.message}`);

      if (error.kind === "unbound_connection") {
        for (const line of bindingCommands(error, environment, manifest)) err(`  ${line}`);
      }
    }

    err(`deployment ${result.id} rejected; ${environment} is unchanged`);

    return 1;
  }

  out(deploymentLine(result, environment));

  return 0;
}

/**
 * The command that would bind this connection, built from the adapter's
 * `config_schema` and `secret_fields`. Someone can paste it. String fields
 * are quoted placeholders (`"YOUR_HOST"`). An integer `port` is 5432, the
 * postgres value a first warehouse bind needs; any other number is 0. A
 * boolean is `false`. A `json` field is `{}`. Secret names are `YOUR_PASSWORD`,
 * and the value is read from that environment variable, so the shell does
 * not treat the line as a redirection.
 */
function bindingCommands(
  error: Issue,
  environment: string,
  manifest?: Pick<Manifest, "connections">,
): string[] {
  const name = connectionName(error);
  const declared = manifest?.connections[name];
  const secrets = declared?.secret_fields ?? [];
  const config = exampleConfig(declared?.config_schema ?? {});
  const refs = secrets.map((field) => `--secret-ref ${field}=${placeholder(field)}`).join(" ");
  const bind =
    `puppi env bind ${name} --env ${environment} --config '${config}'` + (refs ? ` ${refs}` : "");
  const secretLines = secrets.map(
    (field) =>
      `puppi env secret ${placeholder(field)} --env ${environment} --from-env ${placeholder(field)}`,
  );

  return [bind, ...secretLines];
}

function connectionName(error: Issue): string {
  const detail = error.detail;

  if (typeof detail === "object" && detail !== null && "connection" in detail) {
    const name = detail.connection;

    if (typeof name === "string" && name !== "") return name;
  }

  const match = /connection (\S+) is declared/.exec(error.message);

  return match?.[1] ?? "YOUR_CONNECTION";
}

/** `YOUR_HOST` from `host`. A shell word, and a name `env secret` accepts. */
function placeholder(field: string): string {
  const token = field
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

  return `YOUR_${token || "VALUE"}`;
}

function exampleConfig(schema: Record<string, unknown>): string {
  const entries = Object.entries(schema);

  if (entries.length === 0) return "{}";

  return `{${entries.map(([key, type]) => `${JSON.stringify(key)}:${exampleValue(key, type)}`).join(",")}}`;
}

function exampleValue(key: string, type: unknown): string {
  if (type === "integer" || type === "number") return key === "port" ? "5432" : "0";
  if (type === "boolean") return "false";
  if (type === "json") return "{}";

  return JSON.stringify(placeholder(key));
}

/** Returns the `sha256:<hash>` ref, uploading only when the engine lacks it. */
export async function uploadBundle(api: Api, bundlePath: string): Promise<string> {
  const bytes = await readFile(bundlePath);
  const hash = createHash("sha256").update(bytes).digest("hex");

  if ((await api.head(`/bundles/${hash}`)) !== 200) await api.putBytes(`/bundles/${hash}`, bytes);

  return `sha256:${hash}`;
}

/** The branch and sha of `dir`, or `local` for both when it is not a checkout. */
export async function gitProvenance(dir: string): Promise<GitProvenance> {
  const capture = async (...args: string[]): Promise<string | undefined> => {
    try {
      const { stdout } = await run("git", args, {
        cwd: dir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });

      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  };

  return {
    branch: (await capture("rev-parse", "--abbrev-ref", "HEAD")) ?? "local",
    sha: (await capture("rev-parse", "HEAD")) ?? "local",
  };
}
