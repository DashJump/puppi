/**
 * The `puppi` command. Each command file declares itself; this array is the
 * only place a new command is added. Help, flag checks, the environment
 * requirement and dispatch are derived from it.
 */

import { resolve } from "node:path";

import { Api } from "./api.js";
import { type Args, flag, has, parseArgs, UsageError } from "./args.js";
import { build } from "./build.js";
import {
  type Command,
  type CommandContext,
  commandFlags,
  done,
  everyFlag,
  needsEnvironment,
  renderHelp,
  streams,
  valuedNames,
} from "./command.js";
import { connector } from "./connector.js";
import { DEFAULT_SERVER, resolveServer, resolveToken } from "./credentials.js";
import { activate, deploy, deployments } from "./deploy.js";
import { doctor } from "./doctor.js";
import { DEFAULT_ENVIRONMENT, env, namedEnvironment } from "./env.js";
import { init } from "./init.js";
import { assets, lineage, logs } from "./inspect.js";
import { keys } from "./keys.js";
import { tryCommand } from "./local.js";
import { login, logout, whoami } from "./login.js";
import { place } from "./place.js";
import { err, out, show } from "./print.js";
import { rollback } from "./rollback.js";
import { run, status } from "./run.js";
import { suggest } from "./suggest.js";
import { worker } from "./worker.js";

/** In the name list so a near miss can suggest it. `main` prints help before dispatch. */
const help: Command = {
  name: "help",
  help: [],
  offline: true,
  run: async () => done(null),
};

const commands: readonly Command[] = [
  init,
  connector,
  login,
  whoami,
  logout,
  doctor,
  build,
  deploy,
  deployments,
  run,
  tryCommand,
  status,
  assets,
  logs,
  lineage,
  activate,
  rollback,
  env,
  place,
  keys,
  worker,
  help,
];

const FOOTER = [
  "  --env <name> names the environment, or PUPPI_ENV does. --dir . is the project.",
  "  --engine-url or PUPPI_ENGINE_URL says where the engine is (default",
  `  ${DEFAULT_SERVER}).`,
  "  puppi login stores a key for that server.",
  "  A signing key (puppi-signing-key, --signing-key, PUPPI_SIGNING_KEY_FILE,",
  "  or PUPPI_SIGNING_KEY) signs deploy, env create and env bind.",
  "  Every command takes --json and prints its result. Warnings stay on stderr.",
  "",
  "  Exit codes: 0 fine, 1 the engine refused or the run did not succeed",
  "  (failed, blocked downstream, or a quarantined materialization), 2 usage,",
  "  3 `puppi run --wait --timeout` returned while the run was still going,",
  "  4 the run was cancelled.",
].join("\n");

/** The `puppi` command. Returns the exit code; `bin/puppi.js` is the process wrapper. */
export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const command = name ? commands.find((candidate) => candidate.name === name) : undefined;
  const args = parseArgs(rest, valuedNames(command ? commandFlags(command) : everyFlag(commands)));
  const dir = resolve(flag(args, "dir") ?? ".");
  const asJson = has(args, "json");

  if (!name || name === "help" || name === "--help" || has(args, "help")) {
    out(renderHelp(commands, FOOTER));
    return 0;
  }

  try {
    if (!command) {
      const unknown = unknownFlags(args, everyFlag(commands));

      if (unknown) throw new UsageError(unknown);

      const meant = suggest(
        name,
        commands.map((candidate) => candidate.name),
      );

      throw new UsageError(
        meant
          ? `puppi: no command "${name}". did you mean \`puppi ${meant}\`?`
          : `puppi: no command "${name}". \`puppi help\` lists them.`,
      );
    }

    const unknown = unknownFlags(args, commandFlags(command));

    if (unknown) throw new UsageError(unknown);

    const named = namedEnvironment(args);
    const ctx: CommandContext = {
      args,
      dir,
      asJson,
      api: undefined,
      engineUrl: "",
      environment: named ?? (command.defaultEnvironment ? DEFAULT_ENVIRONMENT : undefined),
      commandNames: commands.map((candidate) => candidate.name),
    };

    if (!command.offline) {
      const engineUrl = resolveServer(args);

      ctx.engineUrl = engineUrl;
      ctx.api = new Api({
        url: engineUrl,
        token: resolveToken(engineUrl),
      });
    }

    if (needsEnvironment(command, args) && !ctx.environment) {
      throw new UsageError("this needs --env <name> or PUPPI_ENV");
    }

    const outcome = await command.run(ctx);

    if (!streams(command, args)) show(outcome.data, asJson, command.render);

    return outcome.code;
  } catch (error: unknown) {
    if (error instanceof UsageError) {
      err(error.message);
      return 2;
    }

    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function unknownFlags(args: Args, flags: readonly { name: string }[]): string | undefined {
  const names = flags.map((declared) => declared.name);
  const known = new Set(names);
  const unknown = [...args.values.keys()].filter((flagName) => !known.has(flagName));

  if (unknown.length === 0) return undefined;

  return unknown
    .map((flagName) => {
      const meant = suggest(flagName, names);

      return meant
        ? `unknown flag --${flagName}. did you mean \`--${meant}\`?`
        : `unknown flag --${flagName}. \`puppi help\` lists the flags.`;
    })
    .join("\n");
}
