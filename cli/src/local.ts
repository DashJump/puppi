/**
 * `puppi try <key>`: one producer, the project's adapters, nothing written.
 *
 * Adapters and secrets come from `bindings.local.json`. Inputs are the latest
 * materializations of the environment named by `--env` or `PUPPI_ENV`.
 * `--inputs-from <env>` names a different one. An asset with dependencies and
 * none of those is refused: it needs a latest materialization. An asset with
 * no dependencies gets no inputs. `--inputs-from` is not `--from-env`. That
 * flag already means an environment variable on `puppi env secret`.
 */

import type { Binding, InputRef, LocalInput, LocalResultEvent } from "@puppi/sdk/protocol";

import { ApiError, type Api, type Asset, envPath } from "./api.js";
import { type Args, flag, UsageError } from "./args.js";
import { BINDINGS_FILE, readBindings, type Resolved, resolveBindings } from "./bindings.js";
import { buildProject } from "./build.js";
import { type Command, type Outcome, done, helpBlock, requireApi } from "./command.js";
import { harnessEntry, runHarness } from "./harness.js";
import { type Manifest, type ManifestAsset, reachedConnections } from "./manifest.js";
import { heading, note, out, table } from "./print.js";

const DEFAULT_SAMPLE = 10;

/**
 * The bindings for those connections, from `bindings.local.json` — the
 * config resolved against *this* process's environment, because in a local
 * run this process is where the producer runs, and the secrets resolved by
 * the same `secret_refs` the engine would follow.
 */
function bindingsFor(
  asset: ManifestAsset,
  manifest: Manifest,
  resolved: Resolved,
): Record<string, Binding> {
  const declared = new Map(resolved.bindings.map((binding) => [binding.name, binding]));
  const secrets = new Map(resolved.secrets.map((secret) => [secret.name, secret.value]));
  const bindings: Record<string, Binding> = {};

  for (const { name } of reachedConnections(asset)) {
    const binding = declared.get(name);
    const connection = manifest.connections[name];

    if (!connection) {
      throw new UsageError(
        `${asset.key} reaches connection "${name}", which puppi.config.ts does not declare`,
      );
    }

    if (!binding) {
      throw new UsageError(
        `${asset.key} reaches connection "${name}", which ${BINDINGS_FILE} does not bind. ` +
          `A local run reads its config and secrets from that file, not from the engine.`,
      );
    }

    bindings[name] = {
      type: connection.type,
      config: binding.config,
      secrets: Object.fromEntries(
        Object.entries(binding.secret_refs).map(([field, secret]) => [
          field,
          secrets.get(secret) ?? missingSecret(name, field, secret),
        ]),
      ),
      mode: binding.mode,
    };
  }

  return bindings;
}

function missingSecret(connection: string, field: string, secret: string): never {
  throw new UsageError(
    `binding "${connection}" refers ${field} to secret "${secret}", which ${BINDINGS_FILE} ` +
      `does not define`,
  );
}

/** The environment's latest materializations. An unreachable engine names `from`. */
async function readInputs(api: Api, from: string): Promise<Record<string, InputRef>> {
  try {
    return inputsFromEnvironment(await api.get<Asset[]>(envPath(from, "/assets")));
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 0) {
      throw new Error(
        `could not read inputs from ${from} (${error.message}). ` +
          "Unset PUPPI_ENV or pass --inputs-from to change it.",
        { cause: error },
      );
    }

    throw error;
  }
}

/** One read of an environment's assets. Nothing is written to it. */
function inputsFromEnvironment(assets: Asset[]): Record<string, InputRef> {
  const inputs: Record<string, InputRef> = {};

  for (const asset of assets) {
    if (asset.latest) {
      inputs[asset.key] = {
        materialization_id: asset.latest.id,
        storage_ref: asset.latest.storage_ref,
      };
    }
  }

  return inputs;
}

/**
 * Every dep needs a latest materialization. Checked before the bundle loads,
 * so a missing table is a usage error rather than a failure halfway through
 * the producer.
 */
function requireInputs(
  asset: ManifestAsset,
  inputs: Record<string, InputRef>,
  environment: string | undefined,
): void {
  const missing = asset.deps.filter((key) => !inputs[key]);

  if (missing.length === 0) return;

  if (!environment) {
    throw new UsageError(
      `${asset.key} reads ${missing.join(", ")}, and needs a latest materialization. ` +
        "Pass --inputs-from <env>, or set --env or PUPPI_ENV.",
    );
  }

  const noun = missing.length === 1 ? "it" : "them";

  throw new UsageError(
    `${asset.key} reads ${missing.join(", ")}, and ${environment} has no latest materialization for ${noun}.`,
  );
}

function localInput(options: {
  asset: ManifestAsset;
  manifest: Manifest;
  bundlePath: string;
  resolved: Resolved;
  inputs: Record<string, InputRef>;
  sample: number;
}): LocalInput {
  const { asset } = options;

  return {
    bundle_ref: options.bundlePath,
    asset_key: asset.key,
    partition: "default",
    // Only the declared deps, so `ctx.input()` refuses the same keys it would
    // refuse on the engine even when the read handed over every asset.
    inputs: Object.fromEntries(
      asset.deps.filter((key) => options.inputs[key]).map((key) => [key, options.inputs[key]!]),
    ),
    checkpoint: null,
    cursor_from: null,
    bindings: bindingsFor(asset, options.manifest, options.resolved),
    storage_connection: asset.storage.connection ?? null,
    connections: asset.connections ?? {},
    sample: options.sample,
  };
}

function findAsset(manifest: Manifest, key: string): ManifestAsset {
  const asset = manifest.assets.find((candidate) => candidate.key === key);

  if (asset) return asset;

  throw new UsageError(
    `this project declares no ${key}. It has: ${manifest.assets.map((a) => a.key).join(", ")}`,
  );
}

/** A cell a terminal can show: a nested value is its JSON, not `[object Object]`. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";

  return typeof value === "string" ? value : JSON.stringify(value);
}

function rowsTable(result: LocalResultEvent): void {
  if (result.row_count === 0) {
    note("no rows emitted");
    return;
  }

  const columns = result.observed_schema.map((column) => column.name);

  const emitted = `${result.row_count} ${result.row_count === 1 ? "row" : "rows"} emitted`;

  out();
  note(
    result.sample.length < result.row_count
      ? `${emitted}, first ${result.sample.length} shown`
      : emitted,
  );
  out();
  table(
    columns,
    result.sample.map((row) => columns.map((column) => cell(row[column]))),
    24,
  );
}

/**
 * Observed against declared, column by column. The verdict is the same one
 * `schema_contract` makes after a deploy, which is the point: a contract
 * break costs seconds here and a quarantine there.
 */
function schemaTable(result: LocalResultEvent): void {
  const declared = new Map((result.declared_schema ?? []).map((column) => [column.name, column]));
  const observed = new Map(result.observed_schema.map((column) => [column.name, column]));
  const names = [...new Set([...declared.keys(), ...observed.keys()])];

  out();
  table(
    ["column", "observed", "declared"],
    names.map((name) => [
      name,
      observed.get(name)?.type ?? "—",
      result.declared_schema === null ? "" : (declared.get(name)?.type ?? "not declared"),
    ]),
  );
}

const VERDICT: Record<string, string> = {
  pass: "contract  ✓",
  fail: "contract  ✗",
  undeclared: "contract  –",
};

type LocalFailure = { error: string; asset_key: string };

export function renderLocal(row: LocalResultEvent | LocalFailure): void {
  if ("error" in row) {
    out();
    note(`${row.asset_key} did not finish: ${row.error}`);
    out();
    return;
  }

  report(row);
}

function report(result: LocalResultEvent): void {
  rowsTable(result);
  schemaTable(result);

  out();
  note(`${VERDICT[result.contract.result]}  ${result.contract.detail}`);
  note(`content   ${result.content_hash.slice(0, 16)}… (an unchanged hash is what skips a run)`);

  for (const check of result.check_results) {
    note(
      `check     ${check.result === "pass" ? "✓" : "✗"} ${check.name} (${check.severity})` +
        (check.detail ? `: ${check.detail}` : ""),
    );
  }

  if (result.checks_error) {
    note(`check     ! threw: ${result.checks_error}`);
    note("          the engine fails an attempt on this; nothing after it ran");
  }

  out();
  note("Ran locally. Nothing was written. Run puppi deploy && puppi run to run on the engine.");
  out();
}

/**
 * Non-zero on anything a deploy would have caught: the producer threw, the
 * contract broke, a blocking check failed, or a check could not reach a
 * verdict. A local run that exits 0 is not a promise that a deploy is green,
 * but one that exits 1 is a promise that it is not.
 */
function exitCode(result: LocalResultEvent): number {
  const blocked = result.check_results.some(
    (check) => check.result === "fail" && check.severity === "block",
  );

  return result.contract.result === "fail" || blocked || result.checks_error ? 1 : 0;
}

async function localRunCommand(
  api: Api,
  args: Args,
  dir: string,
  asJson: boolean,
  /** `--env` or `PUPPI_ENV`. */
  environment: string | undefined,
): Promise<Outcome<LocalResultEvent | LocalFailure>> {
  const key = args.positional[0];

  if (!key) {
    throw new UsageError("puppi try needs an asset key: `puppi try pokeapi/pokemon`");
  }

  const sample = Number(flag(args, "limit") ?? DEFAULT_SAMPLE);

  if (!Number.isInteger(sample) || sample < 0) {
    throw new UsageError(`--limit takes a whole number of rows, not ${flag(args, "limit")}`);
  }

  const entry = harnessEntry(dir);
  const { manifest, bundlePath } = await buildProject(dir);
  const asset = findAsset(manifest, key);
  const from = flag(args, "inputs-from") ?? environment;
  const inputs = from && asset.deps.length > 0 ? await readInputs(api, from) : {};

  if (asset.deps.length > 0) requireInputs(asset, inputs, from);

  const input = localInput({
    asset,
    manifest,
    bundlePath,
    resolved: resolveBindings(await readBindings(dir), process.env),
    inputs,
    sample,
  });

  if (!asJson) {
    heading(
      "try",
      `${asset.key} (${asset.role}), with this project's adapters and\n` +
        `${BINDINGS_FILE}. Nothing is written.`,
    );
  }

  return render(entry, input, asJson);
}

export const tryCommand: Command<LocalResultEvent | LocalFailure> = {
  name: "try",
  help: [
    helpBlock(125, [
      "  puppi try <key>                      one producer here; nothing is written",
      "                                       [--limit <rows>] [--inputs-from <env>]",
    ]),
  ],
  flags: [
    { name: "limit", valued: true },
    { name: "inputs-from", valued: true },
  ],
  run: (ctx) => localRunCommand(requireApi(ctx), ctx.args, ctx.dir, ctx.asJson, ctx.environment),
  render: renderLocal,
};

async function render(
  entry: string,
  input: LocalInput,
  asJson: boolean,
): Promise<Outcome<LocalResultEvent | LocalFailure>> {
  let result: LocalResultEvent | null = null;
  let failure: string | null = null;

  await runHarness(entry, input, (event) => {
    switch (event["event"]) {
      case "local_result":
        result = event as unknown as LocalResultEvent;
        break;

      case "error":
        failure = String(event["message"]);
        break;

      case "log":
        if (!asJson) note(`log       ${String(event["message"])}`);
        break;

      case "checkpoint":
        if (!asJson) note(`checkpoint ${JSON.stringify(event["state"])}`);
        break;

      // `read` and `span` are the shim's own instrumentation. The engine
      // keeps them; a person watching one producer does not need them.
      default:
        break;
    }
  });

  if (failure !== null) return done({ error: failure, asset_key: input.asset_key }, 1);

  if (result === null) {
    throw new Error("the local harness ended without a result and without an error");
  }

  return done(result, exitCode(result));
}
