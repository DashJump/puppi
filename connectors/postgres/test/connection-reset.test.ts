import { Client } from "pg";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { PostgresAdapter } from "../src/index.js";

/**
 * A reset during an insert must reject the write, leave the previous table,
 * and keep this process alive.
 */
const config = {
  host: process.env["PGHOST"] ?? "127.0.0.1",
  port: Number(process.env["PGPORT"] ?? 5432),
  database: process.env["PGDATABASE"] ?? "postgres",
  user: process.env["PGUSER"] ?? "postgres",
};
const secrets = { password: process.env["PGPASSWORD"] ?? "postgres" };

const SCHEMA = "reset_test";

afterAll(async () => {
  const adapter = new PostgresAdapter(config, secrets);

  try {
    await adapter.query(`drop schema if exists ${SCHEMA} cascade`);
  } finally {
    await adapter.close();
  }
});

describe("a connection reset during write", () => {
  it("rejects and keeps the previous table", async () => {
    const crashes: unknown[] = [];
    const onCrash = (error: unknown): void => {
      crashes.push(error);
    };

    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);

    const holder = new Client({ ...config, ...secrets });
    const observer = new Client({ ...config, ...secrets });
    const adapter = new PostgresAdapter(config, secrets);

    try {
      await holder.connect();
      await observer.connect();
      await holder.query(`drop schema if exists ${SCHEMA} cascade`);
      await holder.query(`create schema ${SCHEMA}`);
      await holder.query(`create table ${SCHEMA}.t (id bigint, note text)`);
      await holder.query("begin");
      await holder.query(`lock table ${SCHEMA}.t`);

      const writing = adapter.write(`${SCHEMA}.t`, [{ id: 1, note: "kept" }]);
      const pid = await waitingBackend(observer);

      await observer.query("select pg_terminate_backend($1)", [pid]);

      await expect(writing).rejects.toThrow(/connection terminated|terminating connection/i);
      expect(crashes).toEqual([]);

      await holder.query("rollback");
      expect(await adapter.query(`select count(*)::int as n from ${SCHEMA}.t`)).toEqual([{ n: 0 }]);
    } finally {
      process.off("uncaughtException", onCrash);
      process.off("unhandledRejection", onCrash);
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
      await observer.end();
      await adapter.close();
    }
  }, 15_000);
});

/**
 * The backend waiting to lock `reset_test.t`.
 *
 * Other test files share this database and run `drop table if exists` at
 * the same time. `pg_terminate_backend` on one of those ends that file's
 * connection. The ungranted relation lock belongs to this write.
 */
async function waitingBackend(observer: Client): Promise<number> {
  const started = Date.now();

  while (Date.now() - started < 5_000) {
    const found = await observer.query<{ pid: number }>(
      `select distinct a.pid
       from pg_stat_activity a
       join pg_locks l on l.pid = a.pid
       join pg_class c on c.oid = l.relation
       join pg_namespace n on n.oid = c.relnamespace
       where a.datname = current_database()
         and a.pid <> pg_backend_pid()
         and l.locktype = 'relation'
         and n.nspname = $1
         and c.relname = $2
         and not l.granted`,
      [SCHEMA, "t"],
    );
    const pid = found.rows[0]?.pid;

    if (pid !== undefined) return pid;

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("the write never waited on the locked table");
}
