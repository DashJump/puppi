import { contentHash, deriveSchema } from "@puppi/adapter-storage";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresAdapter } from "../src/index.js";

/**
 * The observed schema and the digest are computed in the storage base, so
 * a materialization moved between postgres and an object store keeps its
 * `schema_contract` verdicts and its skip behaviour. Pinned through a real
 * write, like the other tests here, so the postgres adapter cannot quietly
 * grow its own copy again. Integration test against the local postgres.
 */
const config = {
  host: process.env["PGHOST"] ?? "127.0.0.1",
  port: Number(process.env["PGPORT"] ?? 5432),
  database: process.env["PGDATABASE"] ?? "postgres",
  user: process.env["PGUSER"] ?? "postgres",
};
const secrets = { password: process.env["PGPASSWORD"] ?? "postgres" };

const SCHEMA = "ag_test";
const adapter = new PostgresAdapter(config, secrets);

afterAll(async () => {
  try {
    await adapter.query(`drop schema if exists ${SCHEMA} cascade`);
  } finally {
    await adapter.close();
  }
});

describe("postgres and the storage base", () => {
  it("report the same observed schema and content hash for the same rows", async () => {
    const rows = [
      { id: "a", n: 7, f: 1.5, ok: true, tags: ["x"], nothing: null },
      { id: "b", n: 8.5, f: 2, ok: null, tags: "y", nothing: null },
    ];

    const written = await adapter.write(`${SCHEMA}.same`, rows);

    expect(written.observed_schema).toEqual(deriveSchema(rows));
    expect(written.stats.content_hash).toBe(contentHash(rows));
  });
});
