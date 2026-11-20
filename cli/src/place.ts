import { isPlacement, PLACEMENTS } from "./api.js";
import { UsageError } from "./args.js";
import { type Command, done, helpBlock, requireApi } from "./command.js";
import { out } from "./print.js";

interface PlacementResult {
  executor: string;
  environments: { name: string }[];
}

export const place: Command<PlacementResult> = {
  name: "place",
  help: [
    helpBlock(200, [
      `  puppi place <${PLACEMENTS.join("|")}>    set this tenant's mode on every environment`,
    ]),
  ],
  async run(ctx) {
    const executor = ctx.args.positional[0];

    if (!isPlacement(executor)) {
      throw new UsageError(`puppi place needs ${PLACEMENTS.join(", ")}: \`puppi place hosted\``);
    }

    return done(await requireApi(ctx).post<PlacementResult>("/placement", { executor }));
  },
  render(placed) {
    const names = placed.environments.map((env) => env.name);

    out(
      names.length > 0
        ? `${placed.executor}: ${names.join(", ")}`
        : `${placed.executor}: no environments yet`,
    );
  },
};
