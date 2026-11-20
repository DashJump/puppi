/**
 * What a command file declares, and what `main` needs in order to run it.
 * Help, the flag check, the environment requirement and dispatch all read this
 * instead of a second list that can drift.
 */

import type { Api } from "./api.js";
import { type Args, UsageError } from "./args.js";

export interface Flag {
  name: string;
  /** Takes the next argument (`--env prod`), rather than standing alone. */
  valued?: boolean;
}

/** One slice of `puppi help`. `at` orders slices that belong to different commands. */
export interface HelpBlock {
  at: number;
  text: string;
}

export interface CommandContext {
  args: Args;
  dir: string;
  asJson: boolean;
  api: Api | undefined;
  engineUrl: string;
  environment: string | undefined;
  /** Every command name, so `puppi run build` can suggest `build`. */
  commandNames: readonly string[];
}

/** A command's result and the exit code that goes with it. `show` writes `data`. */
export interface Outcome<T = unknown> {
  data: T;
  code: number;
}

export function done<T>(data: T, code = 0): Outcome<T> {
  return { data, code };
}

/**
 * `Data` is the `Outcome.data` `run` returns and the value `render` prints.
 * Both are methods so commands with different results share one list.
 * A function property is contravariant under `strictFunctionTypes`.
 */
export interface Command<Data = unknown> {
  name: string;
  help: readonly HelpBlock[];
  flags?: readonly Flag[];
  /**
   * `--env` or `PUPPI_ENV` is required. A function sees the args, which is
   * how `logs` skips the environment when a run id is given.
   */
  scoped?: boolean | ((args: Args) => boolean);
  /**
   * `--env` and `PUPPI_ENV` may be omitted. The command uses the environment
   * `default`. `deploy` creates that hosted environment the first time.
   */
  defaultEnvironment?: boolean;
  /** The command never contacts the engine, so no client is opened. */
  offline?: boolean;
  /**
   * Stdout belongs to a child until the process exits, so there is no result
   * document to print afterwards. `worker start` is this.
   */
  stream?: boolean | ((args: Args) => boolean);
  run(ctx: CommandContext): Promise<Outcome<Data>>;
  /** Human layout for `data`. Skipped when `--json` is set. `render` does not use `this`. */
  render?(this: void, data: Data): void;
}

export function streams<Data>(command: Command<Data>, args: Args): boolean {
  if (typeof command.stream === "function") return command.stream(args);

  return command.stream === true;
}

export function helpBlock(at: number, lines: readonly string[]): HelpBlock {
  return { at, text: lines.join("\n") };
}

/** Flags every command accepts. They are read by `main` before dispatch. */
const GLOBAL_FLAGS: readonly Flag[] = [
  { name: "dir", valued: true },
  { name: "env", valued: true },
  { name: "engine-url", valued: true },
  { name: "json" },
  { name: "help" },
];

export function commandFlags<Data>(command: Command<Data>): readonly Flag[] {
  return [...GLOBAL_FLAGS, ...(command.flags ?? [])];
}

/** Names `parseArgs` treats as taking the next argument. */
export function valuedNames(flags: readonly Flag[]): string[] {
  return flags.filter((flag) => flag.valued).map((flag) => flag.name);
}

/** Every flag any command accepts. An unknown command is checked against this, so `--env prod` still parses. */
export function everyFlag(commands: readonly Command[]): Flag[] {
  const byName = new Map<string, Flag>();

  for (const flag of commands.flatMap((command) => commandFlags(command))) {
    const existing = byName.get(flag.name);

    byName.set(flag.name, { name: flag.name, valued: Boolean(flag.valued || existing?.valued) });
  }

  return [...byName.values()];
}

export function needsEnvironment<Data>(command: Command<Data>, args: Args): boolean {
  if (typeof command.scoped === "function") return command.scoped(args);

  return command.scoped === true;
}

export function renderHelp(commands: readonly Command[], footer: string): string {
  const body = commands
    .flatMap((command) => [...command.help])
    .sort((left, right) => left.at - right.at)
    .map((block) => block.text);

  return [
    "puppi — build a pipeline, deploy it, run it, and read what it did",
    "",
    ...body,
    "",
    footer,
    "",
  ].join("\n");
}

export function requireApi(ctx: CommandContext): Api {
  if (!ctx.api) throw new Error("this command talks to the engine");

  return ctx.api;
}

export function requireEnv(ctx: CommandContext): string {
  if (!ctx.environment) throw new UsageError("this needs --env <name> or PUPPI_ENV");

  return ctx.environment;
}

export function requirePositional(
  args: Args,
  command: string,
  what: string,
  example: string,
): string {
  const given = args.positional[0];

  if (!given) {
    throw new UsageError(`puppi ${command} needs ${what}: \`puppi ${command} ${example}\``);
  }

  return given;
}
