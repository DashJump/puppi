import {
  baseType,
  commitStorageRef,
  isPageKey,
  PAGE_MARK,
  pageIndexRef,
  pageStorageRef,
  RowDigest,
} from "@puppi/adapter-storage";
import { type Column, type Destination, read, type Row, write, type WriteResult } from "@puppi/sdk";
import { Pool, type PoolClient, type PoolConfig, types as pgTypes } from "pg";

import connector from "./define.js";

export default connector;

/** Postgres allows 65535 bind parameters per statement. */
const MAX_PARAMS = 65_535;

/** The `int8` type oid: what this adapter writes an integer column as. */
const INT8 = 20;

/**
 * pg hands `bigint` back as a string, which would turn an integer column
 * into a string one the moment a model or destination reads it. Parsed back
 * to a number while it is safe, so a materialization round-trips as written.
 */
const TYPE_PARSERS = {
  getTypeParser(oid: number, format?: "text" | "binary"): (value: string) => unknown {
    if (oid === INT8 && format !== "binary") return parseInt8;

    return pgTypes.getTypeParser(oid, format) as (value: string) => unknown;
  },
};

function parseInt8(value: string): number | string {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : value;
}

/** The row, column and result shapes are the storage base's, so every storage adapter reports one thing. */
export type { Column, Row, WriteResult };

export interface StorageRef {
  schema: string;
  table: string;
}

/**
 * `if not exists` does not serialise the check, so two attempts creating the
 * same prefix at once leave the loser with a duplicate-key error. Either way
 * the schema exists afterwards, which is all the caller asked for. Outside
 * the write transaction, so the error cannot abort it.
 */
async function ensureSchema(client: PoolClient, schema: string): Promise<void> {
  try {
    await client.query(`create schema if not exists ${quote(schema)}`);
  } catch (error: unknown) {
    if (!isDuplicateSchema(error)) throw error;
  }
}

/** `unique_violation` on `pg_namespace`, or `duplicate_schema`. */
function isDuplicateSchema(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;

  return code === "23505" || code === "42P06";
}

export function parseStorageRef(ref: string): StorageRef {
  const parts = ref.split(".");

  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`malformed postgres storage_ref: ${ref} (want "<schema>.<table>")`);
  }

  return { schema: parts[0], table: parts[1] };
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqlType(declared: string): string {
  switch (baseType(declared)) {
    case "integer":
      return "bigint";
    case "float":
      return "double precision";
    case "boolean":
      return "boolean";
    case "json":
      return "jsonb";
    default:
      return "text";
  }
}

function toParam(column: Column, value: unknown): unknown {
  if (value === undefined || value === null) return null;

  return column.type.startsWith("json") ? JSON.stringify(value) : value;
}

async function insertRows(
  client: PoolClient,
  target: string,
  columns: Column[],
  rows: Row[],
): Promise<void> {
  const names = columns.map((column) => quote(column.name)).join(", ");
  const perStatement = Math.max(1, Math.floor(MAX_PARAMS / columns.length));

  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const tuples: string[] = [];
    const params: unknown[] = [];

    for (const row of chunk) {
      const placeholders = columns.map((column) => {
        params.push(toParam(column, row[column.name]));
        return `$${params.length}`;
      });

      tuples.push(`(${placeholders.join(", ")})`);
    }

    await client.query(`insert into ${target} (${names}) values ${tuples.join(", ")}`, params);
  }
}

/**
 * What `pg.Pool` is given. `secrets.url` is `connectionString` when it is
 * non-empty, and then host, port, database, user, and password have to be
 * absent. `secrets.ca` is a PEM. The pool gets
 * `ssl: { ca, rejectUnauthorized: true }`, so the server certificate has to
 * chain to that CA and the server name has to match. node-postgres copies a
 * URL's `sslmode` over `ssl`, so those SSL parameters are removed from the
 * string when `ca` is set. `ssl` is refused when that url sets `sslmode`
 * and `ca` is absent. `channel_binding=require` sets `enableChannelBinding`
 * (pg 8.23 never reads the query parameter; the flag uses
 * SCRAM-SHA-256-PLUS when the server offers it). An empty string is unset,
 * because `puppi init` writes one where it has no local default.
 */
export function connectionConfig(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): PoolConfig {
  if (typeof config["url"] === "string" && config["url"] !== "") {
    throw new Error("postgres url is a secret; set secret_refs.url, not config.url");
  }

  const url = secrets["url"] ?? "";
  const mixed = ["host", "port", "database", "user"].filter((key) => present(config[key]));
  const password =
    (secrets["password"] ?? "") !== "" ||
    (typeof config["password"] === "string" && config["password"] !== "");

  if (url !== "" && (mixed.length > 0 || password)) {
    const names = password ? [...mixed, "password"] : mixed;

    throw new Error(`postgres url is the whole connection; remove ${names.join(", ")}`);
  }

  const ca = caPem(config, secrets);
  const connection: PoolConfig =
    url !== ""
      ? { connectionString: ca === undefined ? url : withoutSslParams(url) }
      : {
          host: (config["host"] as string) ?? "127.0.0.1",
          port: Number(config["port"] ?? 5432),
          database: (config["database"] as string) ?? "postgres",
          user: (config["user"] as string) ?? "postgres",
          password: secrets["password"] ?? (config["password"] as string),
        };

  if (ca !== undefined) {
    connection.ssl = { ca, rejectUnauthorized: true };
  } else if (typeof config["ssl"] === "boolean") {
    const mode = sslMode(url);

    if (mode !== null) {
      throw new Error(`postgres ssl is ${String(config["ssl"])} but the url sets sslmode=${mode}`);
    }

    connection.ssl = config["ssl"];
  }

  if (/(?:\?|&)channel_binding=require(?:&|$)/.test(url)) {
    connection.enableChannelBinding = true;
  }

  return connection;
}

/**
 * `secrets.ca` is the CA PEM. An empty string is unset. A CA in config
 * would be stored on the binding, so it is refused.
 */
function caPem(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): string | undefined {
  if (typeof config["ca"] === "string" && config["ca"].trim() !== "") {
    throw new Error("postgres ca is a secret; set secret_refs.ca, not config.ca");
  }

  const value = secrets["ca"];

  if (value === undefined || value.trim() === "") return undefined;

  if (config["ssl"] === false) {
    throw new Error("postgres ca verifies the server; remove ssl: false");
  }

  return value;
}

/** `sslmode` from a connection URL, or null when the URL does not set it. */
function sslMode(url: string): string | null {
  const mode = /[?&]sslmode=([^&]*)/.exec(url)?.[1] ?? null;

  return mode === null || mode === "" ? null : mode;
}

/**
 * The URL with the SSL parameters node-postgres would turn into `ssl`.
 * `sslmode=disable` cannot sit next to a CA: the CA means the connection
 * checks the server certificate.
 */
function withoutSslParams(url: string): string {
  if (sslMode(url) === "disable") {
    throw new Error("postgres ca verifies the server, but the url sets sslmode=disable");
  }

  const parsed = new URL(url);

  for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"]) {
    parsed.searchParams.delete(name);
  }

  return parsed.toString();
}

function present(value: unknown): boolean {
  return value !== undefined && value !== "";
}

export class PostgresAdapter implements Destination {
  private readonly pool: Pool;

  constructor(config: Record<string, unknown>, secrets: Record<string, string>) {
    this.pool = new Pool({
      ...connectionConfig(config, secrets),
      max: 2,
      types: TYPE_PARSERS,
    });
    // An idle socket that dies emits `error` on the pool. The client is
    // already discarded; an unhandled `error` would exit the process.
    this.pool.on("error", ignoreConnectionError);
  }

  /**
   * Creates `storage_ref` from `rows`, replacing any table of that name.
   * Drop, create and insert run in one transaction, so a crash rolls the
   * previous table back. An async iterable is read twice: once for the
   * schema, then again inside the transaction for the inserts.
   */
  @write
  async write(storageRef: string, rows: Row[] | AsyncIterable<Row[]>): Promise<WriteResult> {
    if (isAsyncBatches(rows)) return this.writeStream(storageRef, rows);

    const digest = new RowDigest();
    digest.add(rows);

    return this.replace(storageRef, digest, (client, target) =>
      digest.schema().length > 0
        ? insertRows(client, target, digest.schema(), rows)
        : Promise.resolve(),
    );
  }

  /** Runs the caller's SQL, which may read or write. Backs `ctx.query()`. */
  @read
  @write
  async query(sql: string, params: unknown[] = []): Promise<Row[]> {
    const result = await this.pool.query<Row>(sql, params);
    return result.rows;
  }

  /** Reads a table back; how a destination re-emits its upstream. */
  @read
  async read(storageRef: string): Promise<Row[]> {
    const { schema, table } = parseStorageRef(storageRef);
    const result = await this.pool.query<Row>(`select * from ${quote(schema)}.${quote(table)}`);

    return result.rows;
  }

  /**
   * Deletes one materialization, a leftover commit marker, and its append pages.
   * Pages named by the index are included even when the name was hashed.
   * Idempotent: dropping a missing table is a no-op.
   */
  @write
  async drop(storageRef: string, options?: { pages?: boolean }): Promise<void> {
    const { schema, table } = parseStorageRef(storageRef);
    const commit = parseStorageRef(commitStorageRef(storageRef));
    const names = new Set<string>([table]);

    if (options?.pages !== false) {
      const pages = await this.pageTables(schema, table);
      const siblings = await this.siblingNames(schema, table);
      const index = parseStorageRef(pageIndexRef(storageRef)).table;

      for (const name of [index, ...siblings, ...pages.map((page) => page.name)]) names.add(name);
    }

    for (const name of names) {
      await this.pool.query(`drop table if exists ${quote(schema)}.${quote(name)}`);
    }

    await this.pool.query(`drop table if exists ${quote(commit.schema)}.${quote(commit.table)}`);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Schema pass is done. Drop, create and insert commit together. */
  private async writeStream(storageRef: string, rows: AsyncIterable<Row[]>): Promise<WriteResult> {
    const digest = new RowDigest();

    for await (const batch of rows) digest.add(batch);

    return this.replace(storageRef, digest, (client, target) =>
      digest.schema().length > 0
        ? this.insertBatches(client, target, digest.schema(), rows)
        : Promise.resolve(),
    );
  }

  private async replace(
    storageRef: string,
    digest: RowDigest,
    insert: (client: PoolClient, target: string) => Promise<void>,
  ): Promise<WriteResult> {
    const { schema, table } = parseStorageRef(storageRef);
    const target = `${quote(schema)}.${quote(table)}`;
    const observed = digest.schema();
    const columns =
      observed.length > 0
        ? observed.map((column) => `${quote(column.name)} ${sqlType(column.type)}`).join(", ")
        : "_empty boolean";
    const client = await this.pool.connect();
    // A reset while this client is checked out emits `error` here, and also
    // rejects the query. `pool.query` listens for that; a checked-out client
    // does not, and a listener-less `error` exits the process before the
    // rejection can become a retryable attempt error.
    client.on("error", ignoreConnectionError);

    try {
      await ensureSchema(client, schema);
      await client.query("begin");
      await client.query(`drop table if exists ${target}`);
      await client.query(`create table ${target} (${columns})`);
      await insert(client, target);
      await client.query("commit");
    } catch (error) {
      // A dead socket makes rollback fail as well. A SQL error still rolls
      // back. Either way the original error is what the attempt classifies.
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.removeListener("error", ignoreConnectionError);
      client.release();
    }

    return {
      storage_ref: storageRef,
      observed_schema: observed,
      stats: {
        row_count: digest.count,
        bytes: await this.relationBytes(target),
        content_hash: digest.hash(),
      },
    };
  }

  private async relationBytes(target: string): Promise<number | null> {
    const size = await this.pool.query<{ bytes: string }>(
      `select pg_total_relation_size($1::regclass)::text as bytes`,
      [target],
    );

    return size.rows[0] ? Number(size.rows[0].bytes) : null;
  }

  private async insertBatches(
    client: PoolClient,
    target: string,
    observed: Column[],
    rows: AsyncIterable<Row[]>,
  ): Promise<void> {
    for await (const batch of rows) {
      if (batch.length > 0) await insertRows(client, target, observed, batch);
    }
  }

  private async siblingNames(schema: string, table: string): Promise<string[]> {
    const prefix = `${table}${PAGE_MARK}`;
    const found = await this.pool.query<{ tablename: string }>(
      `select tablename from pg_tables
       where schemaname = $1 and left(tablename, length($2::text)) = $2`,
      [schema, prefix],
    );

    return found.rows.map((row) => row.tablename);
  }

  private async pageTables(
    schema: string,
    table: string,
  ): Promise<{ key: string; name: string }[]> {
    const storageRef = `${schema}.${table}`;
    const indexed = await this.indexedPageKeys(storageRef);

    if (indexed.length > 0) {
      return indexed.map((key) => ({
        key,
        name: parseStorageRef(pageStorageRef(storageRef, key)).table,
      }));
    }

    const prefix = `${table}${PAGE_MARK}`;
    const pages = (await this.siblingNames(schema, table))
      .map((name) => ({ key: name.slice(prefix.length), name }))
      .filter((page) => isPageKey(page.key));

    pages.sort((left, right) => left.key.localeCompare(right.key));

    return pages;
  }

  private async indexedPageKeys(storageRef: string): Promise<string[]> {
    try {
      const raw = (await this.read(pageIndexRef(storageRef)))[0]?.["keys"];

      return typeof raw === "string" && raw !== "" ? raw.split(",").filter(isPageKey) : [];
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "42P01") return [];
      throw error;
    }
  }
}

function isAsyncBatches(rows: Row[] | AsyncIterable<Row[]>): rows is AsyncIterable<Row[]> {
  return !Array.isArray(rows);
}

/**
 * A dropped socket emits `error` and also rejects the in-flight query.
 * The rejection is what the attempt classifies. This listener only keeps
 * that event from exiting the process.
 */
function ignoreConnectionError(): void {
  return undefined;
}

/** Every adapter exports its client under this name; the executor's registry and the generated types rely on it. */
export { PostgresAdapter as Client };
