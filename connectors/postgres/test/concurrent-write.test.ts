import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresAdapter } from "../src/index.js";

/**
 * The engine runs attempts in parallel, and the first run in a fresh
 * environment has every source creating the same schema at once. Postgres
 * does not serialise `create schema if not exists`: the loser blocks on the
 * catalog's unique index until the winner commits, then fails with a
 * duplicate key. Reproduced deterministically here by holding the winner's
 * transaction open. Integration test against the local postgres.
 */
const config = {
  host: process.env["PGHOST"] ?? "127.0.0.1",
  port: Number(process.env["PGPORT"] ?? 5432),
  database: process.env["PGDATABASE"] ?? "postgres",
  user: process.env["PGUSER"] ?? "postgres",
};
const secrets = { password: process.env["PGPASSWORD"] ?? "postgres" };

const SCHEMA = "cw_test";

afterAll(async () => {
  const adapter = new PostgresAdapter(config, secrets);

  try {
    await adapter.query(`drop schema if exists ${SCHEMA} cascade`);
  } finally {
    await adapter.close();
  }
});

describe("a write that loses the race to create the schema", () => {
  it("still succeeds", async () => {
    const winner = new Client({ ...config, ...secrets });
    const adapter = new PostgresAdapter(config, secrets);

    try {
      await winner.connect();
      await winner.query(`drop schema if exists ${SCHEMA} cascade`);
      await winner.query("begin");
      await winner.query(`create schema ${SCHEMA}`);

      // Blocks inside `create schema if not exists` until the winner commits.
      const loser = adapter.write(`${SCHEMA}.t`, [{ id: 1 }]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await winner.query("commit");

      expect((await loser).stats.row_count).toBe(1);
      expect(await adapter.query(`select count(*)::int as n from ${SCHEMA}.t`)).toEqual([{ n: 1 }]);
    } finally {
      await winner.end();
      await adapter.close();
    }
  });
});
