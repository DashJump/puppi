import { model, source } from "@puppi/sdk";
import { z } from "zod";

// Declarations from a loop: this is why collect mode executes the code
// instead of parsing it.
for (const name of ["alpha", "beta"]) {
  source({
    key: `raw/${name}`,
    mode: "full_refresh",
    run: async (ctx) => {
      await ctx.emit([{ id: name }]);
    },
  });
}

model({
  key: "core/joined",
  // A Standard Schema: the manifest gets its column list, the generated
  // types get its row type.
  schema: z.object({ id: z.string() }),
  // Neither dep is declared. Both are compiled from the reads below, and the
  // method shorthand is the producer form the compile pass once rejected.
  async run(ctx) {
    const a = ctx.input("raw/alpha");
    const b = ctx.input("raw/beta");
    const { rows } = await ctx.query<{ id: string }>(
      `select * from ${a} union all select * from ${b}`,
    );
    await ctx.emit(rows);
  },
});

model({
  key: "core/ordered",
  // Ordering-only: never read, so it has to be declared.
  deps: ["core/joined"],
  run: async () => {},
});

model({
  key: "core/enriched",
  // Reaches a connection: compiled into `connections`, the same way the
  // `ctx.input()` above is compiled into `deps`.
  run: async (ctx) => {
    const joined = ctx.input("core/joined");
    const api = ctx.connection("enrichment");
    await api.get(`/lookup?table=${joined}`);
  },
});
