/**
 * `puppi worker`: tokens for a tenant's pool, the pool as it is connected,
 * and `start` for development.
 *
 * `start` runs the executor's pool entry in the foreground. The image, the
 * firewall and `--stop-timeout` are the droplet path.
 */

import { spawn, type ChildProcess } from "node:child_process";

import {
  type Api,
  type Environment,
  type PoolView,
  type PoolWorker,
  type Secret,
  type WorkerToken,
  envPath,
} from "./api.js";
import { type Args, flag, UsageError } from "./args.js";
import { type Command, type Outcome, done, helpBlock, requireApi } from "./command.js";
import { poolEntry } from "./harness.js";
import { err, note, out, table, zoned } from "./print.js";
import { suggest } from "./suggest.js";

interface WorkerListed {
  queue_depth: number;
  workers: (PoolWorker & { missing_secrets: string[] })[];
}

/** Revoke returns an id. `name` belongs to a created token, so it stays off here. */
interface WorkerRevoked {
  id: string;
  name?: undefined;
}

type WorkerResult = WorkerToken[] | WorkerToken | WorkerListed | WorkerRevoked | null;

async function workerCommand(
  api: Api,
  environment: string | undefined,
  args: Args,
  dir: string,
  engineUrl: string,
): Promise<Outcome<WorkerResult>> {
  const [subcommand, ...rest] = args.positional;

  switch (subcommand) {
    case "list":
      return listWorkers(api, environment);

    case "start":
      return done(null, await startWorker(dir, args, engineUrl));

    case "token":
      return tokenCommand(api, rest);

    default: {
      const meant = subcommand ? suggest(subcommand, ["list", "start", "token"]) : undefined;

      throw new UsageError(
        "puppi worker: expected list, start, or token create|list|revoke, " +
          `got ${subcommand ?? "nothing"}` +
          (meant ? `. did you mean \`puppi worker ${meant}\`?` : ""),
      );
    }
  }
}

async function tokenCommand(
  api: Api,
  rest: string[],
): Promise<Outcome<WorkerToken | WorkerToken[] | WorkerRevoked>> {
  const [action, name] = rest;

  switch (action) {
    case "create":
      return createToken(api, name);

    case "list":
      return listTokens(api);

    case "revoke":
      return revokeToken(api, name);

    default:
      throw new UsageError(
        "puppi worker token: expected create <name>, list, or revoke <id>, " +
          `got ${action ?? "nothing"}`,
      );
  }
}

async function createToken(api: Api, name: string | undefined): Promise<Outcome<WorkerToken>> {
  if (!name) {
    throw new UsageError(
      "puppi worker token create needs a name: `puppi worker token create droplet-1`",
    );
  }

  return done(await api.post<WorkerToken>("/worker-tokens", { name }));
}

async function listTokens(api: Api): Promise<Outcome<WorkerToken[]>> {
  return done(await api.get<WorkerToken[]>("/worker-tokens"));
}

async function revokeToken(api: Api, id: string | undefined): Promise<Outcome<WorkerRevoked>> {
  if (!id) {
    throw new UsageError("puppi worker token revoke needs the token id");
  }

  return done(await api.delete<{ id: string }>(`/worker-tokens/${encodeURIComponent(id)}`));
}

/**
 * Connected workers, plus any worker-held secret this environment declared
 * that the worker did not list. The engine reports the names a worker holds.
 * The missing ones are the declared `backend: worker` secrets it does not.
 */
async function listWorkers(
  api: Api,
  environment: string | undefined,
): Promise<Outcome<WorkerListed>> {
  const [pool, declared] = await Promise.all([
    api.get<PoolView>("/workers"),
    declaredSecrets(api, environment),
  ]);

  return done({
    queue_depth: pool.queue_depth,
    workers: pool.workers.map((worker) => ({
      ...worker,
      missing_secrets: missingSecrets(worker, declared),
    })),
  });
}

function renderWorker(data: WorkerResult): void {
  // `worker start` streams, so `show` does not render this null result.
  if (data === null) return;

  if (Array.isArray(data)) {
    table(
      ["id", "name", "last used"],
      data.map((token) => [
        token.id,
        token.name,
        token.last_used_at ? zoned(token.last_used_at) : "never",
      ]),
    );
    return;
  }

  if ("queue_depth" in data) {
    out(`queue depth ${data.queue_depth}`);
    out();
    table(
      ["worker", "free slots", "version", "residency", "trusted key", "missing"],
      data.workers.map((worker) => [
        worker.id,
        worker.free_slots,
        worker.version ?? "",
        worker.residency,
        worker.trusted_keys.join(", "),
        worker.missing_secrets.join(", "),
      ]),
      80,
    );

    if (data.workers.length === 0) note("no workers connected");
    return;
  }

  if ("name" in data && typeof data.name === "string") {
    // The plaintext is shown once. On its own line so a script can take it.
    out(typeof data.token === "string" ? data.token : "");
    err(`token ${data.id} (${data.name}) shown once`);
    return;
  }

  const revoked: WorkerRevoked = data;

  note(`revoked ${revoked.id}`);
}

async function declaredSecrets(api: Api, environment: string | undefined): Promise<string[]> {
  const names = environment
    ? [environment]
    : (await api.get<Environment[]>("/environments")).map((env) => env.name);
  const lists = await Promise.all(
    names.map((name) => api.get<Secret[]>(envPath(name, "/secrets"))),
  );

  return [
    ...new Set(
      lists.flatMap((secrets) =>
        secrets.filter((secret) => secret.backend === "worker").map((secret) => secret.name),
      ),
    ),
  ].sort();
}

function missingSecrets(worker: PoolWorker, declared: string[]): string[] {
  const held = new Set(worker.secrets);

  return declared.filter((name) => !held.has(name));
}

/**
 * Runs the pool worker until it exits. `--slots` sets `PUPPI_WORKER_SLOTS`
 * for the child. The engine URL is the one this command resolved, so
 * `--engine-url` reaches the process the pool reads.
 */
async function startWorker(dir: string, args: Args, engineUrl: string): Promise<number> {
  if (args.positional.length > 1) {
    throw new UsageError("puppi worker start takes no other arguments");
  }

  const slots = flag(args, "slots");

  if (slots !== undefined && !/^[1-9]\d*$/.test(slots)) {
    throw new UsageError("--slots is a positive integer");
  }

  if (!process.env["PUPPI_WORKER_TOKEN"] && !process.env["PUPPI_WORKER_TOKEN_FILE"]) {
    throw new UsageError("puppi worker start needs PUPPI_WORKER_TOKEN or PUPPI_WORKER_TOKEN_FILE");
  }

  const entry = poolEntry(dir);
  const child: ChildProcess = spawn(process.execPath, [entry], {
    stdio: "inherit",
    env: supervisorEnv(process.env, engineUrl, slots),
  });
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

  return code ?? 1;
}

/** What the pool process itself reads. Anything else named `PUPPI_*` is dropped. */
const WORKER_ENV = new Set([
  "PUPPI_ENGINE_URL",
  "PUPPI_WORKER_TOKEN",
  "PUPPI_WORKER_TOKEN_FILE",
  "PUPPI_WORKER_ID",
  "PUPPI_WORKER_SLOTS",
  "PUPPI_RESIDENCY",
  "PUPPI_BUNDLE_CACHE",
  "PUPPI_SECRETS_DIR",
  "PUPPI_TRUSTED_KEYS",
]);

/** Server secret-store settings. They are not worker-held pipeline secrets. */
const ENGINE_SECRET = new Set([
  "PUPPI_SECRET_KEY",
  "PUPPI_SECRET_KEY_PREVIOUS",
  "PUPPI_SECRET_BACKEND",
]);

/**
 * The pool supervisor's environment. A child can read this process through
 * `/proc/<ppid>/environ`, so the signing seed does not cross.
 * Worker-held `PUPPI_SECRET_<NAME>` values stay; the server master key does not.
 */
function supervisorEnv(
  source: NodeJS.ProcessEnv,
  engineUrl: string,
  slots: string | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...source,
    PUPPI_ENGINE_URL: engineUrl,
    ...(slots ? { PUPPI_WORKER_SLOTS: slots } : {}),
  };

  for (const key of Object.keys(env)) {
    if (!key.startsWith("PUPPI_")) continue;
    if (key.startsWith("PUPPI_SECRET_") && !ENGINE_SECRET.has(key)) continue;
    if (WORKER_ENV.has(key)) continue;

    delete env[key];
  }

  return env;
}

export const worker: Command<WorkerResult> = {
  name: "worker",
  help: [
    helpBlock(250, [
      "  puppi worker token create <name>     a pool token, printed once",
      "  puppi worker token list              this tenant's tokens",
      "  puppi worker token revoke <id>       revoke one, and close its sockets",
      "  puppi worker list                    connected workers, and secrets they are missing",
      "  puppi worker start [--slots N]       the pool worker, for development",
    ]),
  ],
  flags: [{ name: "slots", valued: true }],
  stream: (args) => args.positional[0] === "start",
  run: (ctx) => workerCommand(requireApi(ctx), ctx.environment, ctx.args, ctx.dir, ctx.engineUrl),
  render: renderWorker,
};
