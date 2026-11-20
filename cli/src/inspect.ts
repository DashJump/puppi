/**
 * The read commands: `assets`, `logs`, `lineage`. Everything they show is
 * derived by the engine from materializations — no status is stored — so
 * these are `GET`s and a table.
 */

import {
  type Api,
  type Asset,
  type Environment,
  type Materialization,
  type Run,
  assetPath,
  envPath,
} from "./api.js";
import {
  type Command,
  type Outcome,
  done,
  helpBlock,
  requireApi,
  requireEnv,
  requirePositional,
} from "./command.js";
import { note, out, seconds, short, table, zoned } from "./print.js";
import { formatLog, timeline } from "./run.js";

interface AssetList {
  environment: string;
  assets: Asset[];
  deployed: boolean;
}

/** `puppi assets`: every active asset, its latest materialization and its staleness verdict. */
async function assetsCommand(
  api: Api,
  environment: string,
  key: string | undefined,
): Promise<Outcome<Asset | AssetList>> {
  if (key) return done(await api.get<Asset>(assetPath(environment, key)));

  const rows = await api.get<Asset[]>(envPath(environment, "/assets"));

  return done({
    environment,
    assets: rows,
    deployed: rows.length > 0 || (await hasDeployment(api, environment)),
  });
}

function renderAssets(data: Asset | AssetList): void {
  if (isAssetList(data)) {
    if (data.assets.length === 0 && !data.deployed) {
      out(`No active deployment in ${data.environment}. Run \`puppi deploy\`.`);
      return;
    }

    table(
      ["asset", "role", "deps", "latest", "rows", "state", "reasons", "next run"],
      data.assets.map(row),
    );
    return;
  }

  renderAsset(data);
}

function isAssetList(data: Asset | AssetList): data is AssetList {
  return "assets" in data && "deployed" in data;
}

function renderAsset(asset: Asset): void {
  const { definition } = asset;

  note(`${asset.key}  ${definition.role}  code_version ${short(definition.code_version)}`);
  if (definition.deps.length > 0) note(`deps         ${definition.deps.join(", ")}`);
  const connections = Object.entries(definition.connections);

  if (connections.length > 0) {
    note(
      `connections  ${connections.map(([name, direction]) => `${name} (${direction})`).join(", ")}`,
    );
  }
  if (asset.next_run_at) note(`next run     ${zoned(asset.next_run_at)}`);

  out();
  table(
    ["partition", "state", "reasons"],
    asset.staleness.map((verdict) => [
      verdict.partition,
      verdict.state,
      verdict.reasons
        .map((reason) => (reason.dep ? `${reason.reason} (${reason.dep})` : reason.reason))
        .join(", "),
    ]),
    72,
  );

  const history = asset.history ?? [];

  if (history.length === 0) {
    out();
    note("no materializations yet");
    return;
  }

  out();
  table(
    ["materialization", "created", "rows", "bytes", "checks", "state"],
    history.map((m) => [
      short(m.id),
      zoned(m.created_at),
      m.stats.row_count,
      m.stats.bytes ?? "",
      checkLabel(m),
      [m.state?.state, m.quarantined ? "quarantined" : null].filter(Boolean).join(", "),
    ]),
  );
}

/** Staleness is per partition; the unpartitioned case is the first and only verdict. */
function row(asset: Asset): (string | number)[] {
  const verdict = asset.staleness[0];
  const state = verdict?.state ?? "";

  return [
    asset.key,
    asset.definition.role,
    asset.definition.deps.join(", "),
    asset.latest ? short(asset.latest.id) : "none",
    asset.latest?.stats.row_count ?? "",
    asset.latest?.quarantined ? `${state} + quarantined` : state,
    verdict?.reasons.map((reason) => reason.reason).join(", ") ?? "",
    zoned(asset.next_run_at),
  ];
}

/** An empty asset list is "nothing deployed" only when the environment has no active deployment. */
async function hasDeployment(api: Api, environment: string): Promise<boolean> {
  const env = await api.get<Environment>(envPath(environment));

  return env.active_deployment_id !== null;
}

function checkLabel(m: Materialization): string {
  const failed = m.checks.filter((check) => check.result === "fail");

  if (failed.length > 0) return `${failed.map((check) => check.name).join(", ")} failed`;

  return m.checks.length > 0 ? `${m.checks.length} pass` : "";
}

/**
 * `puppi logs <run-id>`: every attempt's timeline and its `ctx.log` lines.
 * The timings come from the attempt row, so where the time went is answered
 * without a query over events.
 */
async function logsCommand(api: Api, runId: string): Promise<Outcome<Run>> {
  return done(await api.get<Run>(`/runs/${runId}`));
}

function renderLogs(run: Run): void {
  note(`run ${run.id} ${run.status} in ${seconds(run.started_at, run.finished_at)}`);

  for (const attempt of run.attempts) {
    out();
    note(
      `${attempt.asset_key} #${attempt.number} ${attempt.status} ` +
        seconds(attempt.started_at, attempt.finished_at) +
        (attempt.error_class ? `  ${attempt.error_class}` : ""),
    );

    const steps = timeline(attempt);

    if (steps.length > 0) {
      out();
      table(
        ["step", "took"],
        steps.map((step) => [step.step, step.took]),
      );
    }

    if (attempt.error_message) note(`  error: ${attempt.error_message}`);

    for (const log of attempt.logs) note(formatLog(log));
  }
}

/**
 * `puppi lineage <key>`: the transitive inputs of an asset's latest
 * materialization, as ids rather than asset names — exactly which upstream
 * rows it was built from.
 */
interface LineageNode {
  key: string;
  id: string;
  rows: number;
  created_at: string;
  flags: string;
  inputs: LineageNode[];
}

type LineageResult = LineageNode | { key: string; materialization: null };

async function lineageCommand(
  api: Api,
  environment: string,
  key: string,
): Promise<Outcome<LineageResult>> {
  const asset = await api.get<Asset>(assetPath(environment, key));

  if (!asset.latest) return done({ key, materialization: null });

  return done(await lineageTree(api, asset.latest.id, key));
}

function renderLineage(shown: LineageResult): void {
  if ("materialization" in shown) {
    note(`${shown.key} has no materialization yet`);
    return;
  }

  renderTree(shown, "");
}

function renderTree(node: LineageNode, indent: string): void {
  note(
    `${indent}${node.key}  ${short(node.id)}  ${node.rows} rows  ${zoned(node.created_at)}  ${node.flags}`,
  );

  for (const input of node.inputs) renderTree(input, `${indent}  └ `);
}

export const assets: Command<Asset | AssetList> = {
  name: "assets",
  help: [
    helpBlock(140, [
      "  puppi assets [key]                   role, deps, latest, staleness and its reasons",
    ]),
  ],
  scoped: true,
  run: (ctx) => assetsCommand(requireApi(ctx), requireEnv(ctx), ctx.args.positional[0]),
  render: renderAssets,
};

export const logs: Command<Run> = {
  name: "logs",
  help: [
    helpBlock(150, [
      "  puppi logs <run-id>                  each attempt's timeline and its ctx.log lines",
    ]),
  ],
  scoped: true,
  run: (ctx) =>
    logsCommand(requireApi(ctx), requirePositional(ctx.args, "logs", "a run id", "<run-id>")),
  render: renderLogs,
};

export const lineage: Command<LineageResult> = {
  name: "lineage",
  help: [
    helpBlock(160, [
      "  puppi lineage <key>                  the materialization ids behind an asset",
    ]),
  ],
  scoped: true,
  run: (ctx) =>
    lineageCommand(
      requireApi(ctx),
      requireEnv(ctx),
      requirePositional(ctx.args, "lineage", "an asset key", "core/customer"),
    ),
  render: renderLineage,
};

async function lineageTree(api: Api, id: string, key: string): Promise<LineageNode> {
  const m = await api.get<Materialization>(`/materializations/${id}`);
  const flags = [m.quarantined ? "quarantined" : null, m.state?.state].filter(Boolean).join(", ");
  const inputs: LineageNode[] = [];

  for (const input of m.inputs_of ?? []) {
    inputs.push(await lineageTree(api, input.materialization_id, input.asset_key));
  }

  return {
    key,
    id: m.id,
    rows: m.stats.row_count,
    created_at: m.created_at,
    flags,
    inputs,
  };
}
