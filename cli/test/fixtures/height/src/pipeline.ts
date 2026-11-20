import { source } from "@puppi/sdk";
import { z } from "zod";

const Reading = z.object({
  height_m: z.number(),
});

export const reading = source({
  key: "raw/reading",
  schema: Reading,
  run: async (ctx) => {
    await ctx.emit([{ height: 1 }]);
  },
});
