/**
 * `puppi env`: the three writes that make an environment usable — create it,
 * bind each declared connection to how it is reached here, and put the
 * secrets a binding must not carry. Values go in and never come back,
 * so `secret` prints a version, not a value.
 */

import { resolve } from "node:path";

import { canonicalJson } from "@puppi/sdk";

import {
  ApiError,
  type Api,
  type Binding,
  type Deployment,
  type Environment,
  type Secret,
  envPath,
  isPlacement,
  PLACEMENTS,
} from "./api.js";
import { type Args, every, flag, has, UsageError } from "./args.js";
import { importConfig } from "./bundle.js";
import { type Command, type Outcome, done, helpBlock, requireApi } from "./command.js";
import {
  loadSigningKey,
  signSubject,
  skipsSignatureCheck,
  warnUnsigned,
  type SigningKey,
} from "./keys.js";
import { note, out, table } from "./print.js";
import { declaredConnections, CONFIG_FILE, pathExists } from "./project.js";
import { suggest } from "./suggest.js";

/** `puppi env show`: the environment plus the bindings and secrets a deployment needs. */
interface EnvShowResult {
  origin: string;
  environment: Environment;
  bindings: Binding[];
  secrets: Secret[];
  deployment: Deployment | null;
}

/** `puppi env create`. `existed` and `updated` are the fields the other results lack. */
interface EnvCreateResult extends Environment {
  existed: boolean;
  updated: boolean;
}

/**
 * Pause and resume return the environment. `existed` is create's field, so
 * this result leaves it off and the two stay distinct.
 */
interface EnvScheduleResult extends Environment {
  existed?: undefined;
}

interface EnvUnbindResult {
  name: string;
  unbound: true;
}

interface EnvForgetResult {
  name: string;
  forgotten: true;
}

interface EnvWebhookResult {
  url: string;
  enabled: boolean;
  secret?: string;
  inserted_at: string;
}

interface EnvWebhookRemoved {
  removed: true;
}

interface EnvWebhookTest {
  ok: true;
}

type EnvResult =
  | Environment[]
  | EnvShowResult
  | EnvCreateResult
  | EnvScheduleResult
  | EnvUnbindResult
  | EnvForgetResult
  | EnvWebhookResult
  | EnvWebhookRemoved
  | EnvWebhookTest
  | Binding
  | Secret;

async function envCommand(
  api: Api,
  environment: string | undefined,
  args: Args,
  dir: string,
): Promise<Outcome<EnvResult>> {
  const [subcommand, ...rest] = args.positional;

  switch (subcommand) {
    case "list":
      return list(api);

    case "create":
      return create(api, rest[0] ?? environment, args, dir);

    case "show":
      return show(api, required(environment));

    case "bind":
      return bind(api, required(environment), rest[0], args, dir);

    case "unbind":
      return unbind(api, required(environment), rest[0]);

    case "secret":
      return secret(api, required(environment), rest[0], args);

    case "webhook":
      return webhook(api, required(environment), rest[0], args);

    case "pause":
      return schedules(api, required(environment), true);

    case "resume":
      return schedules(api, required(environment), false);

    default: {
      const meant = subcommand ? suggest(subcommand, ENV_COMMANDS) : undefined;

      throw new UsageError(
        `puppi env: expected list, create, show, bind, unbind, secret, webhook, pause or resume, got ${subcommand ?? "nothing"}` +
          (meant ? `. did you mean \`puppi env ${meant}\`?` : ""),
      );
    }
  }
}

const ENV_COMMANDS = [
  "list",
  "create",
  "show",
  "bind",
  "unbind",
  "secret",
  "webhook",
  "pause",
  "resume",
];

/** Every subcommand but `list` and `create` acts on one environment. */
function required(environment: string | undefined): string {
  if (!environment) throw new UsageError("this needs --env <name> or PUPPI_ENV");

  return environment;
}

/**
 * The executor, when the environment is there. A 404 is "we do not know":
 * hiding `NOT SIGNED` without knowing the executor would be the wrong
 * default. The write that follows reports the missing environment.
 */
export async function environmentExecutor(
  api: Api,
  environment: string,
): Promise<string | undefined> {
  try {
    return (await api.get<Environment>(envPath(environment))).executor;
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 404) return undefined;

    throw error;
  }
}

async function list(api: Api): Promise<Outcome<Environment[]>> {
  return done(await api.get<Environment[]>("/environments"));
}

const EXECUTOR_USAGE = `--executor ${PLACEMENTS.join("|")}`;

/** The environment `deploy`, `run` and `status` use when `--env` and `PUPPI_ENV` are omitted. */
export const DEFAULT_ENVIRONMENT = "default";

/** `--env`, or `PUPPI_ENV`. An empty value is omitted. */
export function namedEnvironment(args: Args): string | undefined {
  const named = flag(args, "env") ?? process.env["PUPPI_ENV"];

  return named || undefined;
}

/**
 * The hosted environment those commands share. The first call creates it.
 * A later call returns the row that is already there and leaves its executor.
 */
export async function ensureDefaultEnvironment(
  api: Api,
  options: { signingKey?: SigningKey | undefined } = {},
): Promise<{ environment: Environment; existed: boolean }> {
  const existing = (await api.get<Environment[]>("/environments")).find(
    (env) => env.name === DEFAULT_ENVIRONMENT,
  );

  if (existing) return { environment: existing, existed: true };

  const { environment } = await ensureEnvironment(api, DEFAULT_ENVIRONMENT, {
    executor: "hosted",
    ...(options.signingKey ? { signingKey: options.signingKey } : {}),
  });

  return { environment, existed: false };
}

/**
 * The CLI creates the environment, or returns the row that is already there.
 * It moves that row when `executor` is hosted or remote and the stored value
 * differs. A new environment is hosted when `executor` is omitted.
 */
async function ensureEnvironment(
  api: Api,
  name: string,
  options: {
    executor?: string | undefined;
    storagePrefix?: string | undefined;
    kind?: string | undefined;
    /** Signs a new environment. An existing one keeps the signature it has. */
    signingKey?: SigningKey | undefined;
  } = {},
): Promise<{ environment: Environment; existed: boolean; updated: boolean }> {
  const existing = (await api.get<Environment[]>("/environments")).find((env) => env.name === name);

  if (existing) {
    if (isPlacement(options.executor) && existing.executor !== options.executor) {
      const environment = await api.post<Environment>(envPath(name, "/placement"), {
        executor: options.executor,
      });

      return { environment, existed: true, updated: true };
    }

    return { environment: existing, existed: true, updated: false };
  }

  const executor = options.executor ?? "hosted";

  if (!isPlacement(executor)) {
    throw new UsageError(
      `puppi env create ${name} needs ${EXECUTOR_USAGE}.\n  puppi env create ${name}`,
    );
  }

  const storagePrefix = options.storagePrefix ?? defaultPrefix(name);

  return {
    existed: false,
    updated: false,
    environment: await api.post<Environment>("/environments", {
      name,
      executor,
      storage_prefix: storagePrefix,
      ...(options.kind ? { kind: options.kind } : {}),
      ...(options.signingKey
        ? signSubject(
            { kind: "environment", name, storage_prefix: storagePrefix },
            options.signingKey,
          )
        : {}),
    }),
  };
}

function missingCreate(name: string | undefined, executor: string | undefined): string | undefined {
  const example = name ?? "prod";
  const badExecutor = executor !== undefined && !isPlacement(executor);

  if (!name && badExecutor) {
    return `puppi env create needs a name and ${EXECUTOR_USAGE}.\n  puppi env create ${example}`;
  }

  if (!name) return `puppi env create needs a name.\n  puppi env create ${example}`;

  if (badExecutor) {
    return `puppi env create ${name} needs ${EXECUTOR_USAGE}.\n  puppi env create ${name}`;
  }

  return undefined;
}

async function create(
  api: Api,
  name: string | undefined,
  args: Args,
  dir: string,
): Promise<Outcome<EnvCreateResult>> {
  const executor = flag(args, "executor");
  const usage = missingCreate(name, executor);

  if (!name || usage) throw new UsageError(usage ?? "puppi env create needs a name");

  const signingKey = await loadSigningKey(dir, flag(args, "signing-key"));

  // The CLI compares the signing key before this write. Moving an environment
  // onto an executor that checks signatures does not re-sign the existing row.
  if (executor !== undefined && !skipsSignatureCheck(executor) && signingKey) {
    const stored = (await api.get<Environment[]>("/environments")).find((env) => env.name === name);

    if (stored && stored.signing_key !== signingKey.id) {
      throw new UsageError(
        `environment ${stored.name} is not signed by ${signingKey.id}. ` +
          "A worker that requires signatures will refuse it. " +
          "puppi env create signs a new environment; this one already exists.",
      );
    }
  }

  const { environment, existed, updated } = await ensureEnvironment(api, name, {
    ...(isPlacement(executor) ? { executor } : {}),
    storagePrefix: flag(args, "storage-prefix"),
    kind: flag(args, "kind"),
    ...(signingKey ? { signingKey } : {}),
  });

  if (!environment.signature || !environment.signing_key) warnUnsigned(environment.executor);

  return done({ ...environment, existed, updated });
}

/** One row per binding: how each connection is reached here, and which secrets it references. */
function bindingsTable(bindings: Binding[], options?: { signingKey?: boolean }): void {
  const signingKey = options?.signingKey ?? false;

  table(
    ["binding", "mode", "config", "secret_refs", ...(signingKey ? ["signing key"] : [])],
    bindings.map((binding) => [
      binding.name,
      binding.mode,
      JSON.stringify(binding.config),
      Object.entries(binding.secret_refs)
        .map(([field, name]) => `${field}=${name}`)
        .join(", "),
      ...(signingKey ? [binding.signing_key ?? "unsigned"] : []),
    ]),
    72,
  );
}

/** The environment's own bindings and secrets, which is what a deployment needs to exist. */
async function show(api: Api, environment: string): Promise<Outcome<EnvShowResult>> {
  const [env, bindings, secrets] = await Promise.all([
    api.get<Environment>(envPath(environment)),
    api.get<Binding[]>(envPath(environment, "/bindings")),
    api.get<Secret[]>(envPath(environment, "/secrets")),
  ]);
  const deployment = env.active_deployment_id
    ? (await api.get<Deployment[]>(envPath(environment, "/deployments?active=true")))[0]
    : undefined;

  return done({
    origin: api.origin,
    environment: env,
    bindings,
    secrets,
    deployment: deployment ?? null,
  });
}

/**
 * What `env show` means by a backend name. `local` is the default and the
 * one a first project sees, and the name alone does not say where the
 * value went.
 */
function explainBackend(backend: string): string {
  switch (backend) {
    case "local":
      return "local: this engine stores AES-256-GCM ciphertext. The key is engine-managed; in prod, PUPPI_SECRET_KEY sets it. The value is write-only.";

    case "plaintext":
      return "plaintext: a legacy row. It can be read and will not be written.";

    case "vault":
      return "vault: HashiCorp Vault KV v2. The version is pinned in the ref.";

    case "aws_secrets_manager":
      return "aws_secrets_manager: AWS Secrets Manager. The version id is pinned in the ref.";

    case "worker":
      return "worker: the value stays on the worker. This engine stores the name only.";

    default:
      return `${backend}: this engine stores the secret there. The value is not returned.`;
  }
}

async function bind(
  api: Api,
  environment: string,
  name: string | undefined,
  args: Args,
  dir: string,
): Promise<Outcome<Binding>> {
  if (!name) {
    throw new UsageError(
      "puppi env bind needs the connection to bind: " +
        `\`puppi env bind warehouse --config '{"host":"127.0.0.1"}'\``,
    );
  }

  const config = parseConfig(flag(args, "config"));
  const secretRefs = parsePairs(every(args, "secret-ref"));
  const mode = flag(args, "mode") ?? "live";
  const signingKey = await loadSigningKey(dir, flag(args, "signing-key"));
  const flagged = flag(args, "type");
  const fromConfig = signingKey ? await declaredType(dir, name) : undefined;

  if (signingKey && flagged && fromConfig && flagged !== fromConfig) {
    throw new UsageError(
      `--type ${flagged} is not the type in ${CONFIG_FILE} (${fromConfig}). ` +
        "The worker verifies the signature against the deployed connection type.",
    );
  }

  // The engine rebuilds `type` from the deployment manifest
  // (`get_in(declared, [name, "type"]) || ""`). A `--type` the project
  // does not declare is not that string, and `admit` rejects the lease.
  const type = fromConfig;

  if (signingKey && !type) {
    throw new UsageError(
      `connection "${name}" is not declared in ${CONFIG_FILE}. ` +
        "The worker verifies the signature against that type.",
    );
  }

  if (!signingKey) {
    const existing = (await api.get<Binding[]>(envPath(environment, "/bindings"))).find(
      (binding) => binding.name === name,
    );

    if (existing?.signature && !preservesSignature(existing, config, secretRefs, mode)) {
      throw new UsageError(
        `puppi env bind ${name} would keep a signature over a different config. ` +
          "A worker with trusted keys will refuse the lease. " +
          "Sign the bind, or leave the signed config unchanged.",
      );
    }

    if (!existing?.signature) warnUnsigned(await environmentExecutor(api, environment));
  }

  const binding = await api.put<Binding>(envPath(environment, `/bindings/${name}`), {
    config,
    secret_refs: secretRefs,
    mode,
    ...(signingKey && type
      ? signSubject(
          { kind: "binding", name, type, config, secret_refs: secretRefs, mode },
          signingKey,
        )
      : {}),
  });

  return done(binding);
}

async function unbind(
  api: Api,
  environment: string,
  name: string | undefined,
): Promise<Outcome<EnvUnbindResult>> {
  if (!name) {
    throw new UsageError("puppi env unbind needs the connection: `puppi env unbind warehouse`");
  }

  const removed = await api.delete<{ name: string }>(envPath(environment, `/bindings/${name}`));

  return done({ ...removed, unbound: true as const });
}

async function schedules(
  api: Api,
  environment: string,
  paused: boolean,
): Promise<Outcome<EnvScheduleResult>> {
  return done(
    await api.post<Environment>(
      envPath(environment, paused ? "/schedules/pause" : "/schedules/resume"),
      {},
    ),
  );
}

async function secret(
  api: Api,
  environment: string,
  name: string | undefined,
  args: Args,
): Promise<Outcome<Secret | EnvForgetResult>> {
  if (!name)
    throw new UsageError("puppi env secret needs a name: `puppi env secret pg_password …`");

  const fromEnv = flag(args, "from-env");

  if (has(args, "on-worker")) {
    if (has(args, "forget") || flag(args, "value") !== undefined || fromEnv) {
      throw new UsageError(
        `puppi env secret ${name} --on-worker declares a name and takes no value`,
      );
    }

    const written = await api.put<Secret>(envPath(environment, `/secrets/${name}`), {
      on_worker: true,
    });

    return done(written);
  }

  if (has(args, "forget")) {
    const removed = await api.delete<{ name: string }>(envPath(environment, `/secrets/${name}`));

    return done({ ...removed, forgotten: true as const });
  }

  const value = readSecret(name, flag(args, "value"), fromEnv);
  const written = await api.put<Secret>(envPath(environment, `/secrets/${name}`), { value });

  return done(written);
}

/**
 * `--from-env` stores whatever the shell has, including nothing. An unset
 * variable and an empty one are both refused, so a missing export cannot
 * become a secret the engine will later hand to Postgres.
 */
function readSecret(name: string, given: string | undefined, fromEnv: string | undefined): string {
  if (given !== undefined) return given;

  if (!fromEnv) {
    throw new UsageError(
      `puppi env secret ${name} needs --value <value>, --from-env <VAR>, --on-worker, or --forget`,
    );
  }

  const from = process.env[fromEnv];

  if (from === undefined) {
    throw new UsageError(`puppi env secret ${name} --from-env ${fromEnv}: ${fromEnv} is not set`);
  }

  if (from.trim() === "") {
    throw new UsageError(`puppi env secret ${name} --from-env ${fromEnv}: ${fromEnv} is empty`);
  }

  return from;
}

/** One line for an environment that was just created, updated, or already there. */
export function environmentLine(
  environment: Environment,
  existed: boolean,
  updated: boolean,
): string {
  const state = updated
    ? `updated to ${environment.executor}`
    : existed
      ? "already exists"
      : "created";

  return `environment ${environment.name} ${state} (storage prefix ${environment.storage_prefix})`;
}

/** A storage prefix is a path segment, and an environment name is not constrained to be one. */
function defaultPrefix(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "_");
}

function parseConfig(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }

    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    throw new UsageError(
      `--config is a JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The connection's declared type, or undefined when this directory does not
 * declare it. The engine rebuilds the signed subject from the deployment
 * manifest (`get_in(declared, [name, "type"]) || ""`), which is this declaration.
 */
async function declaredType(dir: string, name: string): Promise<string | undefined> {
  const configPath = resolve(dir, CONFIG_FILE);

  if (!(await pathExists(configPath))) return undefined;

  const defined: unknown = await importConfig(configPath);
  const connections = declaredConnections(
    typeof defined === "object" && defined !== null && "connections" in defined
      ? defined.connections
      : undefined,
  );

  return connections[name]?.type;
}

function preservesSignature(
  existing: Binding,
  config: Record<string, unknown>,
  secretRefs: Record<string, string>,
  mode: string,
): boolean {
  return (
    existing.mode === mode &&
    canonicalJson(existing.config) === canonicalJson(config) &&
    canonicalJson(existing.secret_refs) === canonicalJson(secretRefs)
  );
}

async function webhook(
  api: Api,
  environment: string,
  action: string | undefined,
  args: Args,
): Promise<Outcome<EnvWebhookResult | EnvWebhookRemoved | EnvWebhookTest>> {
  switch (action) {
    case "set":
      return webhookSet(api, environment, args);

    case "test":
      return done(await api.post<EnvWebhookTest>(envPath(environment, "/webhook/test"), {}));

    case "rm":
      return done(await api.delete<EnvWebhookRemoved>(envPath(environment, "/webhook")));

    default: {
      const meant = action ? suggest(action, ["set", "test", "rm"]) : undefined;

      throw new UsageError(
        `puppi env webhook: expected set, test or rm, got ${action ?? "nothing"}` +
          (meant ? `. did you mean \`puppi env webhook ${meant}\`?` : ""),
      );
    }
  }
}

async function webhookSet(
  api: Api,
  environment: string,
  args: Args,
): Promise<Outcome<EnvWebhookResult>> {
  const url = flag(args, "url");
  const rotate = has(args, "rotate");

  if (!url && !rotate) {
    throw new UsageError("puppi env webhook set needs --url <https://…> or --rotate");
  }

  if (url && !url.startsWith("https://")) {
    throw new UsageError("puppi env webhook set --url must start with https://");
  }

  if (has(args, "disable") && !url) {
    throw new UsageError("puppi env webhook set --disable needs --url <https://…>");
  }

  let stored: EnvWebhookResult | undefined;

  if (url) {
    stored = await api.put<EnvWebhookResult>(envPath(environment, "/webhook"), {
      url,
      enabled: !has(args, "disable"),
    });
  }

  // A new webhook already has a secret. Rotating again would throw that one away.
  if (rotate && !stored?.secret) {
    stored = await api.post<EnvWebhookResult>(envPath(environment, "/webhook/rotation"), {});
  }

  if (!stored) throw new UsageError("puppi env webhook set needs --url <https://…> or --rotate");

  return done(stored);
}

/** `--secret-ref password=warehouse_password`, repeated. */
function parsePairs(pairs: string[]): Record<string, string> {
  return Object.fromEntries(
    pairs.map((pair) => {
      const at = pair.indexOf("=");

      if (at <= 0) throw new UsageError(`--secret-ref is <field>=<secret>, got "${pair}"`);

      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
}

export const env: Command<EnvResult> = {
  name: "env",
  help: [
    helpBlock(190, [
      "  puppi env list                       every environment",
      "  puppi env show                       one environment's bindings and secrets",
      `  puppi env create <name>              [${EXECUTOR_USAGE}]`,
      "                                       The CLI creates a hosted environment when --executor is omitted.",
      "                                       [--storage-prefix <p>] [--kind preview]",
    ]),
    helpBlock(210, [
      "  puppi env bind <connection>          --config '<json>' [--secret-ref f=name] [--mode live]",
      "                                       [--type <type>] signs with the connection's type",
      "  puppi env unbind <connection>        remove one binding",
      "  puppi env secret <name>              --value <v> | --from-env <VAR> | --on-worker | --forget",
      "  puppi env webhook set               --url <https://…> [--rotate] [--disable]",
      "  puppi env webhook test              send one alert.test event",
      "  puppi env webhook rm                remove the webhook",
      "  puppi env pause                      stop schedules in this environment",
      "  puppi env resume                     let schedules fire again",
    ]),
    helpBlock(220, [""]),
  ],
  flags: [
    { name: "executor", valued: true },
    { name: "storage-prefix", valued: true },
    { name: "kind", valued: true },
    { name: "config", valued: true },
    { name: "secret-ref", valued: true },
    { name: "mode", valued: true },
    { name: "type", valued: true },
    { name: "signing-key", valued: true },
    { name: "value", valued: true },
    { name: "from-env", valued: true },
    { name: "on-worker" },
    { name: "forget" },
    { name: "url", valued: true },
    { name: "rotate" },
    { name: "disable" },
  ],
  run: (ctx) => envCommand(requireApi(ctx), ctx.environment, ctx.args, ctx.dir),
  render: renderEnv,
};

function renderEnv(data: EnvResult): void {
  if (Array.isArray(data)) {
    table(
      ["environment", "kind", "storage prefix", "active deployment", "schedules"],
      data.map((environment) => [
        environment.name,
        environment.kind,
        environment.storage_prefix,
        environment.active_deployment_id ?? "none",
        environment.schedules_paused ? "paused" : "running",
      ]),
    );
    return;
  }

  if ("bindings" in data && "environment" in data && "secrets" in data) {
    renderShow(data);
    return;
  }

  if ("existed" in data && typeof data.existed === "boolean") {
    note(environmentLine(data, data.existed, data.updated));

    if (!data.existed && data.signing_key) note(`signed by ${data.signing_key}`);

    return;
  }

  if ("unbound" in data) {
    note(`unbound ${data.name}`);
    return;
  }

  if ("forgotten" in data) {
    note(`secret ${data.name} removed`);
    return;
  }

  if ("config" in data && "mode" in data) {
    note(
      `bound ${data.name} (${data.mode}) to ${JSON.stringify(data.config)}` +
        (Object.keys(data.secret_refs).length > 0
          ? ` with ${Object.keys(data.secret_refs).join(", ")}`
          : ""),
    );
    return;
  }

  if ("backend" in data) {
    if (data.backend === "worker") {
      note(`secret ${data.name} declared on the worker (${data.backend})`);
      return;
    }

    note(`secret ${data.name} written to ${data.backend} at version ${data.version ?? "unpinned"}`);
    return;
  }

  if ("removed" in data) {
    note("webhook removed");
    return;
  }

  if ("ok" in data) {
    note("test event sent");
    return;
  }

  if ("url" in data && "enabled" in data && "inserted_at" in data) {
    note(`webhook ${data.enabled ? "on" : "off"} ${data.url}`);

    if (data.secret) {
      note(`secret ${data.secret}`);
      note("copy this secret now; it is not shown again");
    }

    return;
  }

  const environment: EnvScheduleResult = data;

  note(`schedules ${environment.schedules_paused ? "paused" : "running"} on ${environment.name}`);
}

function renderShow(shown: {
  origin: string;
  environment: Environment;
  bindings: Binding[];
  secrets: Secret[];
  deployment: Deployment | null;
}): void {
  const { environment, bindings, secrets, deployment } = shown;

  note(`engine ${shown.origin}`);
  note(
    `${environment.name}  ${environment.kind}  executor ${environment.executor}  storage prefix ${environment.storage_prefix}`,
  );
  note(
    `environment ${environment.signing_key ? `signed by ${environment.signing_key}` : "unsigned"}`,
  );
  note(
    `active deployment ${environment.active_deployment_id ?? "none"}` +
      (deployment
        ? ` ${deployment.signing_key ? `signed by ${deployment.signing_key}` : "unsigned"}`
        : ""),
  );

  out();
  bindingsTable(bindings, { signingKey: true });

  out();
  table(
    ["secret", "backend", "version"],
    secrets.map((stored) => [
      stored.name,
      stored.backend,
      stored.backend === "worker" ? "on worker" : (stored.version ?? "unpinned"),
    ]),
  );

  const backends = [...new Set(secrets.map((stored) => stored.backend))];

  if (backends.length > 0) {
    out();
    for (const backend of backends) note(explainBackend(backend));
  }
}
