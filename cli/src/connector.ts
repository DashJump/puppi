/**
 * `puppi connector new <type> [dir]`: a connector package that already
 * exports the source interface, for a vendor this repository does not ship.
 * The files come from `connectorScaffold` in `@puppi/sdk`.
 */

import { resolve } from "node:path";

import { connectorScaffold } from "@puppi/sdk";

import { type Args, has, UsageError } from "./args.js";
import { sdkVersion } from "./bundle.js";
import { type Command, type Outcome, done, helpBlock } from "./command.js";
import { heading, note, out } from "./print.js";
import { writeScaffold } from "./scaffold.js";

interface ConnectorResult {
  target: string;
  files: string[];
}

async function connectorCommand(args: Args, dir: string): Promise<Outcome<ConnectorResult>> {
  const [sub, type, explicit, extra] = args.positional;

  if (sub !== "new" || !type || extra !== undefined) {
    throw new UsageError(
      "puppi connector new <type> [dir] writes a connector package. `--force` overwrites.",
    );
  }

  const target = resolve(dir, explicit ?? type);
  let files: Record<string, string>;

  try {
    files = connectorScaffold(type, sdkVersion());
  } catch (error: unknown) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  await writeScaffold(
    target,
    Object.entries(files),
    has(args, "force"),
    "`puppi connector new --force` overwrites, or pick another directory",
  );

  return done({ target, files: Object.keys(files).sort() });
}

function renderConnector(row: ConnectorResult): void {
  heading(
    "connector",
    "A package that exports the source interface. Replace openapi.json with the\nvendor spec, then npm run generate.",
  );

  for (const path of row.files) note(path);

  out();
  note(`next:  cd ${row.target}`);
  note("       npm install");
  note("       npm test");
  out();
}

export const connector: Command<ConnectorResult> = {
  name: "connector",
  help: [
    helpBlock(20, [
      "  puppi connector new <type> [dir]     a connector package that exports the source interface",
      "                                       [--force]",
    ]),
  ],
  flags: [{ name: "force" }],
  offline: true,
  run: (ctx) => connectorCommand(ctx.args, ctx.dir),
  render: renderConnector,
};
