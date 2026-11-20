/**
 * `puppi rollback`: data rollback is a pointer move. `latest` for the asset
 * goes back to a materialization it already has. A destination cannot be
 * repointed — the external system already has the newer rows — so the engine
 * queues a run to re-deliver it, and this waits for that run too.
 */

import {
  type Api,
  type Asset,
  type RollbackOutcome,
  type Run,
  assetPath,
  envPath,
  rollbackTarget,
} from "./api.js";
import { flag } from "./args.js";
import {
  type Command,
  type Outcome,
  done,
  helpBlock,
  requireApi,
  requireEnv,
  requirePositional,
} from "./command.js";
import { note, out, short, table } from "./print.js";
import { assets, exitCode, reportRun, waitForRun } from "./run.js";

interface RollbackView extends RollbackOutcome {
  latest: string | null;
  target: string;
  run: Run | null;
  assets: Asset[];
}

interface RollbackRefused {
  asset_key: string;
  rolled_back: false;
  reason: string;
}

type RollbackResult = RollbackView | RollbackRefused;

async function rollbackCommand(
  api: Api,
  environment: string,
  key: string,
  options: { to: string | undefined; asJson: boolean },
): Promise<Outcome<RollbackResult>> {
  const asset = await api.get<Asset>(assetPath(environment, key));
  const target = options.to ?? rollbackTarget(asset);

  if (!target) {
    return done(
      {
        asset_key: key,
        rolled_back: false,
        reason:
          `${key} has no retained, unquarantined materialization behind latest, so there ` +
          `is nothing to roll back to. \`puppi assets ${key}\` lists its history.`,
      },
      1,
    );
  }

  // Said before the call: the re-delivery wait can take as long as a run.
  if (!options.asJson) {
    note(`latest is ${short(asset.latest?.id)}; rolling back to ${short(target)}`);
  }

  const outcome = await api.post<RollbackOutcome>(envPath(environment, "/rollbacks"), {
    asset_key: key,
    materialization_id: target,
  });
  const waited = outcome.run_id ? await waitForRun(api, outcome.run_id) : null;
  const run = waited?.run ?? null;
  const after = run ? await assets(api, environment) : [];

  return done(
    {
      ...outcome,
      latest: asset.latest?.id ?? null,
      target,
      run,
      assets: after,
    },
    run ? exitCode(run, after) : 0,
  );
}

function renderRollback(row: RollbackResult): void {
  if (row.rolled_back === false) {
    note(row.reason ?? "");
    return;
  }

  out();
  table(
    ["asset", "what happened", "materialization"],
    [
      [row.rolled_back.asset_key, "rolled back", short(row.rolled_back.materialization_id)],
      ...row.repointed.map((moved) => [
        moved.asset_key,
        "repointed",
        short(moved.materialization_id),
      ]),
      ...row.rebuilding.map((assetKey) => [assetKey, "rebuilding", ""]),
      ...row.unchanged.map((assetKey) => [assetKey, "unchanged", ""]),
    ],
  );

  if (!row.run_id || !row.run) return;

  out();
  note(`re-delivery run ${row.run_id}`);
  reportRun(row.run, row.assets);
}

export const rollback: Command<RollbackResult> = {
  name: "rollback",
  help: [
    helpBlock(170, [
      "  puppi rollback <key> [--to <id>]     repoint `latest`; destinations re-deliver",
      "                                       code rollback is `puppi activate`",
    ]),
    helpBlock(180, [""]),
  ],
  flags: [{ name: "to", valued: true }],
  scoped: true,
  run: (ctx) =>
    rollbackCommand(
      requireApi(ctx),
      requireEnv(ctx),
      requirePositional(ctx.args, "rollback", "an asset key", "core/customer"),
      { to: flag(ctx.args, "to"), asJson: ctx.asJson },
    ),
  render: renderRollback,
};
