import { model, type RowOf } from "@puppi/sdk";
import { z } from "zod";

/**
 * Type-level assertions, compiled by `cli/test/build.test.ts` after a build
 * has written `puppi-env.d.ts`. Every `@ts-expect-error` is a claim that the
 * line is a type error; an unused directive fails the compile, so this file
 * pins both what is accepted and what is rejected.
 *
 * Not imported by `pipeline.ts`, so it is never bundled or collected.
 */
model({
  key: "core/typed",
  schema: z.object({ id: z.string(), n: z.int() }),
  run: async (ctx) => {
    // Declared keys are accepted, and their row types come along.
    const alpha = ctx.input("raw/alpha");
    const joined = ctx.input("core/joined");

    // @ts-expect-error a key that names no declared asset is a type error
    ctx.input("raw/typo");

    // raw/alpha declares no schema, so its rows are untyped.
    const untyped: RowOf<typeof alpha> = { anything: 1 };

    // core/joined's contract is { id: string }.
    type Joined = RowOf<typeof joined>;
    const row: Joined = { id: "x" };
    // @ts-expect-error `nope` is not a column of core/joined
    const wrong: Joined = { id: "x", nope: 1 };

    // A TableRef is still a string, so SQL embeds it.
    const { rows } = await ctx.query<Joined>(`select * from ${alpha} join ${joined}`);
    const first: Joined | undefined = rows[0];

    // emit is checked against this model's own schema.
    await ctx.emit(rows.map((r) => ({ id: r.id, n: 1 })));
    // @ts-expect-error declared `n`, emitted `org`
    await ctx.emit([{ id: "x", org: "y" }]);
    // @ts-expect-error rows of an upstream's shape do not satisfy this contract
    await ctx.emit(rows);

    // Connections: `warehouse` is the project's stub, typed from its
    // `clientModule`. `enrichment` is `clearbit`, also typed from the
    // `clientModule` its declaration names.
    const warehouse = ctx.connection("warehouse");
    const counted: Record<string, unknown>[] = await warehouse.query("select 1");
    const api: unknown = await ctx.connection("enrichment").get("/lookup");
    // @ts-expect-error the clearbit client has no `query`
    ctx.connection("enrichment").query("select 1");
    // @ts-expect-error a name that is not a declared connection is a type error
    ctx.connection("nope");

    void [untyped, row, wrong, first, counted, api];
  },
});
