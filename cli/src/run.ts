/**
 * `puppi run` and `puppi status`. `puppi run` triggers and prints the run id.
 * `--wait` polls until the run settles and then shows what each asset did.
 * `POST …/runs` returns 202.
 */

import {
  type Api,
  type Asset,
  type Attempt,
  type Materialization,
  type Run,
  envPath,
} from "./api.js";
import { type Args, flag, has, UsageError } from "./args.js";
import { type Command, type Outcome, done, helpBlock, requireApi, requireEnv } from "./command.js";
import { counted, note, out, seconds, short, table, zoned } from "./print.js";
import { suggest } from "./suggest.js";

export interface RunOptions {
  force?: boolean;
}

const POLL_MS = 750;

/**
 * Exit code when `--wait --timeout` returns and the run is still going.
 * 1 means the run failed, so a deadline stays distinguishable from a bad run.
 */
const STILL_GOING = 3;
const CANCELLED = 4;

async function trigger(api: Api, environment: string, options: RunOptions): Promise<Run> {
  const body: Record<string, unknown> = {};

  if (options.force) body["force"] = true;

  return api.post<Run>(envPath(environment, "/runs"), body);
}

export interface WaitedRun {
  run: Run;
  /** The deadline passed. The run is still `queued` or `running`. */
  timedOut: boolean;
}

/**
 * Polls `GET /runs/:id` until the run leaves `queued` and `running`.
 * No `timeoutMs` waits until it settles: a fixed deadline that threw made a
 * live run look like a failure. `onPoll` sees each body, which already carries
 * the attempt rows `--wait` prints.
 */
export async function waitForRun(
  api: Api,
  id: string,
  options: { timeoutMs?: number; onPoll?: (run: Run) => void } = {},
): Promise<WaitedRun> {
  const started = Date.now();

  for (;;) {
    const current = await api.get<Run>(`/runs/${id}`);

    options.onPoll?.(current);

    if (current.status !== "running" && current.status !== "queued") {
      return { run: current, timedOut: false };
    }

    if (options.timeoutMs !== undefined && Date.now() - started > options.timeoutMs) {
      return { run: current, timedOut: true };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Lines for what changed between two polls of `GET /runs/:id`.
 * A failed attempt's line carries its error, and the next attempt says
 * `retrying`. Each new `ctx.log` line is printed under its attempt.
 * Row counts are not on this payload — they live on the
 * materialization — so a settled line carries duration, and the summary
 * table reads rows from the assets once the run has settled.
 */
function progressLines(before: Run, after: Run): string[] {
  const lines: string[] = [];

  if (before.status !== after.status) {
    lines.push(`run ${after.id} ${before.status} -> ${after.status}`);
  }

  const seen = new Map(before.attempts.map((attempt) => [attempt.id, attempt]));

  for (const attempt of after.attempts) {
    const prior = seen.get(attempt.id);
    const fresh = prior === undefined;
    const terminal = attempt.status !== "running" && (fresh || prior.status === "running");

    if (fresh && attempt.status === "running" && attempt.number === 1) {
      lines.push(`starting ${label(attempt)}`);
    }

    if (fresh && attempt.number > 1) lines.push(`retrying ${label(attempt)}`);

    for (const log of attempt.logs.slice(prior?.logs.length ?? 0)) {
      lines.push(`${label(attempt)} ${formatLog(log).trimStart()}`);
    }

    if (terminal) lines.push(settledLine(attempt));
  }

  return lines;
}

/**
 * One `ctx.log` line, indented. A withheld line says which worker kept the text.
 * Control characters are removed so the line cannot rewrite the terminal.
 */
export function formatLog(log: Attempt["logs"][number]): string {
  if (log.withheld && log.withheld.length > 0) {
    const where = log.worker_id ? `worker ${log.worker_id}` : "the worker";
    return `  ${log.level.padEnd(5)} kept on ${where}`;
  }

  return `  ${log.level.padEnd(5)} ${plainLog(log.message ?? "")}`;
}

/**
 * Removes CSI, OSC, and the other C0 and C1 controls. Tab and newline stay.
 * The patterns are escape text passed to `RegExp`, so the source has no
 * control character for the linter to reject.
 */
function plainLog(text: string): string {
  return text
    .replace(controlPattern(String.raw`(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\)`), "")
    .replace(controlPattern(String.raw`(?:\u001b\[|\u009b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]`), "")
    .replace(controlPattern(String.raw`[\u0000-\u0008\u000b-\u001f\u007f-\u009f]`), "");
}

function controlPattern(source: string): RegExp {
  return new RegExp(source, "g");
}

function label(attempt: Attempt): string {
  const partition = attempt.partition ? ` ${attempt.partition}` : "";

  return `${attempt.asset_key}${partition} #${attempt.number}`;
}

function settledLine(attempt: Attempt): string {
  const took = seconds(attempt.started_at, attempt.finished_at);
  const duration = took ? ` in ${took}` : "";
  const klass = attempt.error_class ? ` [${attempt.error_class}]` : "";
  const error = attempt.error_message ? `: ${attempt.error_message}` : "";

  return `${label(attempt)} ${attempt.status}${klass}${duration}${error}`;
}

function followCommand(environment: string, id: string): string {
  return `puppi status --env ${environment} --run ${id}`;
}

/** The most recent run of an environment, or null when it has never run. */
async function latestRun(api: Api, environment: string): Promise<Run | null> {
  const runs = await api.get<Run[]>(envPath(environment, "/runs"));
  const newest = runs.at(0);

  return newest ? api.get<Run>(`/runs/${newest.id}`) : null;
}

/**
 * One row per asset in the plan: what its last attempt did, how long it
 * took, and whether `latest` moved. `before` is the assets as they were at
 * trigger time, which is what makes "new" and "kept" distinguishable.
 */
export function reportRun(settled: Run, after: Asset[], before: Asset[] = []): void {
  const wasLatest = new Map(before.map((asset) => [asset.key, asset.latest?.id ?? null]));
  const byKey = new Map(after.map((asset) => [asset.key, asset]));
  // Attempts arrive in order, so the last one written per key is the retry
  // that settled it.
  const lastAttempt = new Map(settled.attempts.map((attempt) => [attempt.asset_key, attempt]));

  out();
  table(
    ["asset", "attempt", "status", "took", "rows", "materialization", "checks / error"],
    settled.plan.map((key) =>
      row(
        key,
        lastAttempt.get(key),
        byKey.get(key)?.latest ?? null,
        wasLatest.has(key) ? wasLatest.get(key)! : undefined,
      ),
    ),
  );

  // The table clips long cells; a failure's whole message is what a reader needs.
  for (const attempt of settled.attempts) {
    if (attempt.error_message && attempt.status !== "blocked") {
      out();
      note(`${attempt.asset_key} #${attempt.number} ${attempt.status}: ${attempt.error_message}`);
    }
  }

  out();
  note(
    `run ${settled.id} ${settled.status} in ${seconds(settled.started_at, settled.finished_at)}`,
  );

  for (const line of verdicts(settled, after)) note(line);
}

/**
 * The exit code: 0 only when the run succeeded, nothing downstream was
 * blocked and no latest is quarantined. These are the three ways a run that
 * "finished" is not a run you can trust, and CI should see all of them.
 */
export function exitCode(settled: Run, after: Asset[]): number {
  if (settled.status === "cancelled") return CANCELLED;

  return verdicts(settled, after).length > 0 ? 1 : 0;
}

function verdicts(settled: Run, after: Asset[]): string[] {
  const found: string[] = [];

  if (settled.status !== "success") found.push(`run ${settled.status}`);

  const blocked = Object.entries(settled.outcome)
    .filter(([, status]) => status === "blocked")
    .map(([key]) => key);

  if (blocked.length > 0) found.push(`blocked by an upstream: ${blocked.join(", ")}`);

  const quarantined = after
    .filter((asset) => settled.plan.includes(asset.key) && asset.latest?.quarantined)
    .map((asset) => asset.key);

  if (quarantined.length > 0) {
    found.push(`quarantined, so \`latest\` did not move: ${quarantined.join(", ")}`);
  }

  return found;
}

/**
 * `was` is the materialization this asset pointed at when the run was
 * triggered, and `undefined` when that was not read — which is what makes
 * "new" and "kept" distinguishable, and why `status` shows neither.
 */
function row(
  key: string,
  last: Attempt | undefined,
  latest: Materialization | null,
  was: string | null | undefined,
): (string | number)[] {
  return [
    key,
    last ? `#${last.number}` : "",
    last?.status ?? "not started",
    last ? seconds(last.started_at, last.finished_at) : "",
    latest?.stats.row_count ?? "",
    pointer(latest, was),
    last?.error_message ?? checksSummary(latest),
  ];
}

/** What happened to `latest`: a new materialization, the one that was already there, or none. */
function pointer(latest: Materialization | null, was: string | null | undefined): string {
  if (!latest) return "none";

  const moved = was !== undefined && latest.id !== was;

  return `${moved ? "new " : "kept"} ${short(latest.id)}${latest.quarantined ? " quarantined" : ""}`;
}

function checksSummary(materialization: Materialization | null): string {
  if (!materialization) return "";

  const failed = materialization.checks.filter((check) => check.result === "fail");

  if (failed.length === 0) {
    return materialization.checks.length ? `${materialization.checks.length} checks pass` : "";
  }

  return failed
    .map((check) => `${check.name} ${check.severity}: ${check.detail ?? "fail"}`)
    .join("; ");
}

export async function assets(api: Api, environment: string): Promise<Asset[]> {
  return api.get<Asset[]>(envPath(environment, "/assets"));
}

type RunState =
  | { kind: "queued"; run: Run; follow: string }
  | { kind: "settled"; run: Run; before: Asset[]; after: Asset[] }
  | { kind: "timedOut"; run: Run; before: Asset[]; follow: string; message: string }
  | { kind: "cancelRequested"; run: Run; cancelRequested: boolean };

interface RunResult {
  run: Run;
  before: Asset[];
  after: Asset[];
  waited: boolean;
  follow?: string;
  timedOut?: boolean;
  message?: string;
  cancelRequested?: boolean;
}

function publish(result: RunState): RunResult {
  switch (result.kind) {
    case "queued":
      return { run: result.run, before: [], after: [], waited: false, follow: result.follow };
    case "settled":
      return { run: result.run, before: result.before, after: result.after, waited: true };
    case "timedOut":
      return {
        run: result.run,
        before: result.before,
        after: [],
        waited: true,
        timedOut: true,
        follow: result.follow,
        message: result.message,
      };
    case "cancelRequested":
      return {
        run: result.run,
        before: [],
        after: [],
        waited: false,
        cancelRequested: result.cancelRequested,
      };
  }
}

/** `puppi run`: manual runs always execute the whole active graph. */
async function runCommand(
  api: Api,
  environment: string,
  runOptions: RunOptions,
  options: { wait: boolean; timeoutMs?: number; asJson: boolean },
): Promise<Outcome<RunResult>> {
  const before = options.wait ? await assets(api, environment) : [];
  const queued = await trigger(api, environment, runOptions);
  const follow = followCommand(environment, queued.id);

  if (!options.wait) return done(publish({ kind: "queued", run: queued, follow }));

  // Said before the poll: a run can take minutes, and this is the id to look up.
  if (!options.asJson) {
    note(
      `run ${queued.id} ${queued.status}: ${counted(queued.plan.length, "asset")} in plan, ` +
        `trigger ${JSON.stringify(queued.trigger)}`,
    );
  }

  let previous = queued;
  const waited = await waitForRun(api, queued.id, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    onPoll: options.asJson
      ? undefined
      : (current) => {
          for (const line of progressLines(previous, current)) note(line);
          previous = current;
        },
  });

  if (waited.timedOut) {
    const message = `run ${waited.run.id} is still ${waited.run.status}. Follow it with \`${follow}\`.`;

    return done(
      publish({ kind: "timedOut", run: waited.run, before, follow, message }),
      STILL_GOING,
    );
  }

  const settled = waited.run;
  const after = await assets(api, environment);

  return done(publish({ kind: "settled", run: settled, before, after }), exitCode(settled, after));
}

function renderRun(result: RunResult): void {
  if (result.cancelRequested !== undefined) {
    const pending = result.cancelRequested ? ", cancel requested" : "";
    note(`run ${result.run.id} ${result.run.status}${pending}`);
    return;
  }

  if (result.timedOut) {
    note(result.message ?? "");
    return;
  }

  if (result.waited) {
    reportRun(result.run, result.after, result.before);
    return;
  }

  note(
    `run ${result.run.id} ${result.run.status}: ${counted(result.run.plan.length, "asset")} in plan`,
  );

  if (result.follow) note(result.follow);
}

interface StatusResult {
  environment: string;
  run: Run | null;
  assets: Asset[];
}

/** `puppi status`: the last run, or the one named by `--run`. */
async function statusCommand(
  api: Api,
  environment: string,
  runId: string | undefined,
): Promise<Outcome<StatusResult>> {
  const settled = runId ? await api.get<Run>(`/runs/${runId}`) : await latestRun(api, environment);

  if (!settled) return done({ environment, run: null, assets: [] });

  const after = await assets(api, environment);

  return done({ environment, run: settled, assets: after }, exitCode(settled, after));
}

function renderStatus(result: StatusResult): void {
  if (!result.run) {
    note(`${result.environment} has no runs yet; \`puppi run\` starts one`);
    return;
  }

  note(
    `run ${result.run.id} ${result.run.status}, triggered ${zoned(result.run.inserted_at)} ` +
      `by ${JSON.stringify(result.run.trigger)}`,
  );
  reportRun(result.run, result.assets);
}

/** The per-attempt timeline `logs` prints; exported for the shared shape. */
export function timeline(attempt: Attempt): { step: string; took: string }[] {
  const t = attempt.timings;

  return [
    { step: "gate", took: seconds(attempt.started_at, t.gated_at) },
    { step: "resolve inputs", took: seconds(t.gated_at, t.inputs_resolved_at) },
    { step: "start executor", took: seconds(t.inputs_resolved_at, t.executor_started_at) },
    { step: "produce", took: seconds(t.executor_started_at, t.producer_done_at) },
    { step: "write + checks", took: seconds(t.producer_done_at, t.checks_done_at) },
    { step: "settle", took: seconds(t.checks_done_at, attempt.finished_at) },
  ].filter((step) => step.took !== "");
}

export const run: Command<RunResult> = {
  name: "run",
  help: [
    helpBlock(120, [
      "  puppi run                            trigger the whole graph and print the run id",
      "                                       [--force] [--wait] [--timeout <seconds>]",
      "  puppi run cancel <run-id>            cancel a queued or running run",
    ]),
  ],
  flags: [
    { name: "force" },
    { name: "wait" },
    { name: "timeout", valued: true },
    // Removed flags stay recognized so the error can name what replaced them.
    { name: "no-wait" },
    { name: "local" },
    { name: "upstream" },
    { name: "downstream" },
  ],
  scoped: true,
  defaultEnvironment: true,
  run: (ctx) => manualRun(requireApi(ctx), requireEnv(ctx), ctx.args, ctx.asJson, ctx.commandNames),
  render: renderRun,
};

export const status: Command<StatusResult> = {
  name: "status",
  help: [
    helpBlock(130, [
      "  puppi status                         the last run, per attempt [--run <id>]",
    ]),
  ],
  flags: [{ name: "run", valued: true }],
  scoped: true,
  defaultEnvironment: true,
  run: (ctx) => statusCommand(requireApi(ctx), requireEnv(ctx), flag(ctx.args, "run")),
  render: renderStatus,
};

/**
 * `puppi run build` is a typo for `puppi build`. The suggestion leads when
 * the extra word is a command. A run still cannot target one asset.
 */
function selectionError(args: Args, names: readonly string[]): string {
  const word = args.positional[0];
  const meant = word
    ? suggest(
        word,
        names.filter((command) => command !== "run"),
      )
    : undefined;
  const suggestion = meant ? `did you mean \`puppi ${meant}\`? ` : "";

  return (
    suggestion +
    "manual runs execute the whole active graph. " +
    "Engine runs cannot target one asset yet."
  );
}

function manualRun(
  api: Api,
  environment: string,
  args: Args,
  asJson: boolean,
  names: readonly string[],
): Promise<Outcome<RunResult>> {
  if (has(args, "local")) {
    throw new UsageError("`puppi run --local` is gone. Run one producer with `puppi try <key>`.");
  }

  const [word, ...rest] = args.positional;

  if (word === "cancel") return cancelRun(api, args, rest);

  if (args.positional.length > 0 || has(args, "upstream") || has(args, "downstream")) {
    throw new UsageError(selectionError(args, names));
  }

  if (has(args, "no-wait")) {
    throw new UsageError(
      "`--no-wait` is gone. `puppi run` returns once the run is queued; `--wait` blocks until it settles.",
    );
  }

  const wait = has(args, "wait");

  if (!wait && has(args, "timeout")) {
    throw new UsageError("`--timeout` applies to `puppi run --wait`");
  }

  return runCommand(
    api,
    environment,
    { force: has(args, "force") },
    { wait, timeoutMs: wait ? timeoutMs(args) : undefined, asJson },
  );
}

async function cancelRun(
  api: Api,
  args: Args,
  words: readonly string[],
): Promise<Outcome<RunResult>> {
  if (has(args, "wait") || has(args, "force") || has(args, "timeout")) {
    throw new UsageError(
      "`puppi run cancel` takes a run id, not `--wait`, `--force`, or `--timeout`",
    );
  }

  const [id, ...extra] = words;
  if (!id || extra.length > 0) {
    throw new UsageError("puppi run cancel needs a run id: `puppi run cancel <run-id>`");
  }

  const current = await api.post<Run>(`/runs/${id}/cancel`);

  return done(
    publish({
      kind: "cancelRequested",
      run: current,
      cancelRequested: current.status !== "cancelled",
    }),
  );
}

/** Seconds. Omitted means wait until the run settles. */
function timeoutMs(args: Args): number | undefined {
  if (!has(args, "timeout")) return undefined;

  const given = flag(args, "timeout");
  const parsed = Number(given);

  if (given === undefined || !Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`--timeout is a number of seconds, got "${given ?? ""}"`);
  }

  return parsed * 1000;
}
