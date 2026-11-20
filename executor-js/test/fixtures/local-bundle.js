/**
 * A collect-mode bundle, written by hand.
 *
 * `puppi build` produces these with rolldown from a user's `src/pipeline.ts`;
 * the local harness only ever sees the result, which is this shape. Writing
 * one directly keeps `local.test.ts` a test of the harness rather than of the
 * bundler.
 */

const asset = (over) => ({
  role: "source",
  producer: "ts",
  deps: [],
  connections: [],
  partitioning: { by: "none" },
  checks: {},
  config: {},
  ...over,
});

export default {
  adapters: {},
  assets: {
    "api/people": asset({
      key: "api/people",
      schema: {
        columns: [
          { name: "id", type: "integer" },
          { name: "name", type: "string" },
        ],
      },
      checks: { custom: { not_empty: { severity: "block" } } },
      customChecks: {
        not_empty: async ({ rows }) =>
          rows.length > 0 ? { result: "pass" } : { result: "fail", detail: "no rows" },
      },
      run: async (ctx) => {
        ctx.log("fetching people");
        ctx.checkpoint({ page: 1 });
        await ctx.emit([
          { id: 1, name: "Ada" },
          { id: 2, name: "Grace" },
          { id: 3, name: "Alan" },
        ]);
      },
    }),

    // The contract break a deploy would turn into a quarantine: `id` is
    // declared integer and emitted as a string.
    "api/drifted": asset({
      key: "api/drifted",
      schema: { columns: [{ name: "id", type: "integer" }] },
      run: async (ctx) => {
        await ctx.emit([{ id: "1" }]);
      },
    }),

    // Reads, with nothing bound to read from.
    "core/joined": asset({
      key: "core/joined",
      role: "model",
      deps: ["api/people"],
      run: async (ctx) => {
        const people = ctx.input("api/people");
        const { rows } = await ctx.query(`select * from ${people}`);
        await ctx.emit(rows);
      },
    }),

    // A check that throws rather than returning a verdict.
    "api/unverifiable": asset({
      key: "api/unverifiable",
      checks: { custom: { reachable: { severity: "block" } } },
      customChecks: {
        reachable: async () => {
          throw new Error("the verification API is down");
        },
      },
      run: async (ctx) => {
        await ctx.emit([{ id: 1 }]);
      },
    }),
  },
};
