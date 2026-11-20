import { assertConformant, runStorageConformance } from "@puppi/conformance";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { PostgresAdapter } from "../src/index.js";

/**
 * The same suite a third-party adapter runs, against the one storage adapter
 * that is not built on the object-store base. Integration test against the
 * local postgres, like the others here.
 */
const config = {
  host: process.env["PGHOST"] ?? "127.0.0.1",
  port: Number(process.env["PGPORT"] ?? 5432),
  database: process.env["PGDATABASE"] ?? "postgres",
  user: process.env["PGUSER"] ?? "postgres",
};
const secrets = { password: process.env["PGPASSWORD"] ?? "postgres" };

const SCHEMA = "conf_test";
const adapter = new PostgresAdapter(config, secrets);

afterAll(async () => {
  try {
    await adapter.query(`drop schema if exists ${SCHEMA} cascade`);
  } finally {
    await adapter.close();
  }
});

describe("the postgres adapter", () => {
  it("does everything it declares", async () => {
    const checks = await runStorageConformance({
      adapter,
      prefix: SCHEMA,
      sharedDigest: true,
    });

    assertConformant(checks);

    // dropPrefix stays optional. drop removes one materialization and its pages.
    expect(checks.filter((check) => check.status === "skipped").map((check) => check.name)).toEqual(
      ["dropPrefix empties the whole prefix"],
    );
  }, 30_000);
});
