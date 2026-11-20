/** Types a pipeline writes against. The executor provides `ctx` at run time. */

import type { InferRow, SchemaInput } from "./schema.js";

export type Visibility = "group" | "project" | "public";

declare const GROUP: unique symbol;

/** A group returned by `group()`. A plain object is not one. */
export type Group = Readonly<{ name: string; visibility: Visibility }> & {
  readonly [GROUP]: never;
};

export interface GroupDeclaration {
  name: string;
  visibility?: Visibility;
}

export interface GroupDefinition {
  name: string;
  visibility: Visibility;
}

/** A manifest role. `raw` has no declaration function. */
export type AssetRole = "source" | "raw" | "model" | "destination";

export type Partitioning =
  | { by: "none" }
  | { by: "time"; grain: "day" | "hour" }
  | { by: "key"; column: string };

/**
 * When the engine runs this asset on its own.
 *
 * `cron` is five fields. `every: "15m"` fires on the clock, not as an
 * interval from now. A scheduler that was down fires once when it returns.
 */
export type Schedule = { cron: string; timezone?: string } | { every: string; timezone?: string };

/** One column of a declared contract. */
export interface ColumnSchema {
  name: string;
  type: string;
}

export interface AssetSchema {
  columns: ColumnSchema[];
}

export type Row = Record<string, unknown>;

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Scalars only: telemetry carries facts about a run, never rows. */
export type TelemetryAttributeValue = string | number | boolean | null;
export type TelemetryAttributes = Record<string, TelemetryAttributeValue>;

export type PagePhase = "fetch" | "transform" | "write";

/**
 * A phase's retry budget. `attempts` counts the first call, so `1` disables
 * retries. `backoffMs` is indexed by retry number and repeats its last value.
 */
export interface PageRetryPolicy {
  attempts?: number;
  backoffMs?: readonly number[];
  retry?: (error: unknown) => boolean;
}

/** One bounded page fetched from a source. */
export interface FetchedPage<T extends Row = Row> {
  records: T[];
  nextCursor: string | null;
  done: boolean;
}

/** Stable facts passed to every phase of one page. */
export interface PageContext {
  cursor: string | null;
  page: number;
  idempotencyKey: string;
}

export interface ProcessPagesOptions<Fetched extends Row, Written extends Row = Fetched> {
  fetch: (ctx: PageContext) => Promise<FetchedPage<Fetched>>;
  transform?: (records: readonly Fetched[], ctx: PageContext) => Written[] | Promise<Written[]>;
  /**
   * Must resolve only after the destination durably accepted the page.
   * Retries receive the same `idempotencyKey`.
   */
  write: (records: readonly Written[], ctx: PageContext) => Promise<void>;
  retry?: Partial<Record<PagePhase, PageRetryPolicy>>;
}

export interface ProcessPagesResult {
  pages: number;
  records: number;
  cursorTo: string | null;
}

/**
 * Spans, events, and gauges from user code. They do not change the
 * attempt's status or timings.
 */
export interface Telemetry {
  /** Times `fn`, then reports the span with its attributes; the error still propagates. */
  span<T>(name: string, fn: () => T | Promise<T>, attributes?: TelemetryAttributes): Promise<T>;
  /** A point in time: `ctx.telemetry.event("rate_limited", { retry_after: 30 })`. */
  event(name: string, attributes?: TelemetryAttributes): void;
  /** A measured value: `ctx.telemetry.gauge("pages_fetched", 12)`. */
  gauge(name: string, value: number, attributes?: TelemetryAttributes): void;
}

/**
 * Asset key to row type. Empty until `puppi build` writes `puppi-env.d.ts`.
 * Keys stay string literals so `ctx.input("…")` can be read as a dependency.
 */
export interface PuppiAssets {}

/** A declared asset key, or any string until the first build. */
export type AssetKey = [keyof PuppiAssets] extends [never]
  ? string
  : Extract<keyof PuppiAssets, string>;

/** The row type of an asset by key; `Row` when the key carries no schema. */
export type AssetRow<K> = K extends keyof PuppiAssets ? PuppiAssets[K] : Row;

declare const ROW: unique symbol;

/** The physical table name `ctx.input()` returns, branded with its row type. */
export type TableRef<T extends Row = Row> = string & { readonly [ROW]?: T };

/** The row type of a `TableRef`: `RowOf<typeof customers>`. */
export type RowOf<R> = R extends TableRef<infer T> ? T : never;

declare const FILE: unique symbol;

/**
 * A file asset. `puppi-env.d.ts` uses it for an asset whose producer calls
 * `ctx.emitFile`, and `ctx.input()` then returns a `FileRef`.
 */
export interface FileAsset {
  readonly [FILE]: never;
}

/** One object. `stream()` reads it from the asset's storage. `toString()` is the storage ref. */
export interface FileRef {
  readonly meta: Record<string, unknown>;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly contentType: string | null;
  stream(): Promise<ReadableStream<Uint8Array>>;
  toString(): string;
}

/** `ctx.input()` for `K`: a file ref when that asset stores a file, otherwise its table. */
export type AssetInput<K extends AssetKey> =
  AssetRow<K> extends FileAsset ? FileRef : TableRef<AssetRow<K> extends Row ? AssetRow<K> : Row>;

/**
 * Connection name to the client `ctx.connection()` returns. Empty until
 * `puppi build` augments it from `puppi.config.ts`.
 */
export interface PuppiConnections {}

/** A declared connection name: any string until the first build, then only the declared ones. */
export type ConnectionName = [keyof PuppiConnections] extends [never]
  ? string
  : Extract<keyof PuppiConnections, string>;

/** The client `ctx.connection(name)` returns; `unknown` when nothing types it. */
export type ConnectionClient<K> = K extends keyof PuppiConnections ? PuppiConnections[K] : unknown;

/**
 * The runtime context the executor provides.
 * `Out` is this asset's row type, inferred from its schema.
 */
export interface Ctx<Out extends Row = Row> {
  /**
   * Returns the physical table name for `key` in this environment.
   * Pass a string literal so the dependency is recorded.
   */
  input<K extends AssetKey>(key: K): AssetInput<K>;

  /**
   * Runs SQL against this asset's storage and returns the rows.
   *
   * `T` is not checked against the SQL. This call records no lineage;
   * `input()` is what declares a read.
   */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the row type
  readonly query: <T extends Row = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;

  /**
   * Returns the client for a bound connection. Config and secrets stay
   * on the binding. Pass a string literal so the connection is recorded.
   */
  connection<K extends ConnectionName>(name: K): ConnectionClient<K>;

  /**
   * Writes rows to this materialization's output.
   *
   * Doesn't throw on bad rows. A bad row is stored but never becomes
   * `latest`, and the attempt reports it.
   */
  emit(rows: Out[]): Promise<void>;

  /**
   * Stores one object as this materialization. The stream is written to
   * storage as it is read. The sha256 of those bytes is the content hash.
   * Throws when this attempt also calls `emit`, and when the asset is `append`.
   */
  emitFile(
    body: ReadableStream<Uint8Array>,
    options?: { contentType?: string | null; meta?: Record<string, unknown> },
  ): Promise<void>;

  /**
   * Ends the attempt without writing a materialization. The attempt is
   * recorded `skipped` and `verified_at` is stamped on the current latest.
   * Throws after `emit` or `emitFile`. The attempt fails when there is no latest.
   */
  unchanged(): never;

  /**
   * Fetches, transforms, and writes pages in this attempt.
   *
   * A checkpoint is recorded only after `write` resolves. A retry repeats
   * the current page, so `write` must honor `idempotencyKey`.
   */
  processPages<Fetched extends Row, Written extends Row = Fetched>(
    options: ProcessPagesOptions<Fetched, Written>,
  ): Promise<ProcessPagesResult>;

  /**
   * Saves resumable progress for this asset. On an `append` source it is
   * kept only after the page is stored. Cleared when the producer finishes.
   */
  checkpoint(state: Record<string, unknown>): void;

  readonly log: (message: string, level?: LogLevel) => void;

  /** Spans, events, and gauges from user code, on this attempt's trace. */
  readonly telemetry: Telemetry;

  /** The delta start for incremental sources and models; null on a full load. */
  readonly cursorFrom: string | null;

  /** Resume state from a previous attempt, or null. */
  readonly checkpointState: Record<string, unknown> | null;

  /**
   * This asset's current latest materialization, or null on the first run.
   * A table is the storage ref, and string interpolation yields that ref.
   * A file is a `FileRef`: `meta`, `sha256`, `bytes`, and `contentType`.
   */
  readonly latest: TableRef | FileRef | null;
}

export interface CheckConfig {
  severity?: "warn" | "block";
  [key: string]: unknown;
}

/** What a custom check hands back. `detail` is what a failed attempt reports. */
export interface CheckVerdict {
  result: "pass" | "fail";
  detail?: string;
}

/**
 * What a custom check sees after the materialization is written.
 * There is no `input()`: a check cannot read another asset.
 */
export interface CheckCtx<Out extends Row = Row> {
  readonly rows: readonly Out[];
  readonly output: TableRef<Out>;
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the row type
  readonly query: <T extends Row = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  readonly log: (message: string, level?: LogLevel) => void;
}

/**
 * A check that runs after the write. `block` keeps the previous `latest`;
 * `warn` still publishes. A throw fails the attempt.
 */
export interface CustomCheck<Out extends Row = Row> {
  /** Defaults to `block`. */
  severity?: "warn" | "block";
  run: (ctx: CheckCtx<Out>) => CheckVerdict | Promise<CheckVerdict>;
}

export interface AssetChecks<Out extends Row = Row> {
  schema_contract?: CheckConfig;
  freshness?: CheckConfig;
  volume?: CheckConfig;
  /** Keyed by check name; the name is the check's identity on the materialization. */
  custom?: Record<string, CustomCheck<Out>>;
}

/** The manifest-facing `checks`: every kind reduced to its config, with no functions. */
export interface DeclaredChecks {
  schema_contract?: CheckConfig;
  freshness?: CheckConfig;
  volume?: CheckConfig;
  custom?: Record<string, { severity: "warn" | "block" }>;
}

export interface CommonDeclaration<S extends SchemaInput> {
  key: string;
  /** A group returned by `group()`. Omit for the configurable implicit `default` group. */
  group?: Group;
  /** May only widen the selected group's visibility. */
  visibility?: Visibility;
  /**
   * When the engine runs this asset by itself. The cron expression is
   * checked here; the time zone is checked when the manifest is ingested.
   */
  schedule?: Schedule;
  /** The declared contract: `{ columns }`, or a Standard Schema. See `SchemaInput`. */
  schema?: S;
  partitioning?: Partitioning;
  checks?: AssetChecks<InferRow<S>>;
  /** Dependencies `ctx.input()` cannot see. Compiled edges stay if you omit them here. */
  deps?: string[];
  /**
   * Connections the producer reads that `ctx.connection()` cannot see:
   * a computed name, a destructure, or a call inside a helper. Unioned
   * with what the compile pass extracts, like `deps`.
   */
  reads?: string[];
  /** Connections the producer writes that the compile pass cannot see. */
  writes?: string[];
  /** Where this asset writes. Wins over the project's `defaultStorage`. */
  storage?: string;
  /**
   * Days to keep a whole materialization. Omit it and every role keeps every
   * copy. Zero keeps only the newest. Not part of `code_version`.
   */
  retention?: number;
}

export interface SourceDeclaration<
  S extends SchemaInput = AssetSchema,
> extends CommonDeclaration<S> {
  /**
   * `append` fetches a new slice and needs `cursor`. `full_refresh` copies
   * the whole source. Defaults to `full_refresh`. The engine does not guess.
   */
  mode?: "append" | "full_refresh";

  /** Required when `mode` is "append": the watermark the delta is taken against. */
  cursor?: string;

  run: (ctx: Ctx<InferRow<S>>) => Promise<void>;
}

export interface ModelDeclaration<
  S extends SchemaInput = AssetSchema,
> extends CommonDeclaration<S> {
  /**
   * `table` rebuilds. `view` creates a SQL view and writes no rows.
   * `incremental` stores a delta and needs `cursor`. Defaults to `table`.
   */
  mode?: "table" | "view" | "incremental";
  /** Required when `mode` is "incremental": the upstream the delta is over. */
  cursor?: string;
  run?: (ctx: Ctx<InferRow<S>>) => Promise<void>;
  sql?: (ctx: Ctx<InferRow<S>>) => string;
}

export interface DestinationDeclaration<
  S extends SchemaInput = AssetSchema,
> extends CommonDeclaration<S> {
  from: string;
  /** Where this destination delivers. */
  storage: string;
  /** The destination's write strategy. Not to be confused with a binding's `mode`. */
  write: "merge" | "append" | "replace";
}

/** What collect mode hands the CLI, and what a bundle default-exports. */
export interface Declaration {
  key: string;
  /** Resolved group name; collect mode never leaves this implicit. */
  group: string;
  /** Resolved visibility; collect mode never leaves this implicit. */
  visibility: Visibility;
  role: AssetRole;
  producer: "ts" | "sql" | "resolve";
  deps: string[];
  /** Connections the producer reads. Compiled reaches are unioned in later. */
  reads: string[];
  /** Connections the producer writes. Compiled reaches are unioned in later. */
  writes: string[];
  partitioning: Partitioning;
  /** Absent unless declared: an asset with no schedule is never fired by the scheduler. */
  schedule?: Schedule;
  /** Always the column list: a Standard Schema is reduced to one at declaration. */
  schema?: AssetSchema;
  /** Config only: the custom check functions live in `customChecks`, so this stays JSON. */
  checks: DeclaredChecks;
  /** Where this asset writes, when the declaration named `storage`. */
  storage?: string;
  /** Days to keep a whole materialization. Absent when the declaration omitted it. */
  retention?: number;
  config: Record<string, unknown>;
  run?: (ctx: Ctx) => Promise<void>;
  sql?: (ctx: Ctx) => string;
  /** The custom check bodies by name, for the executor and for `code_version`. */
  customChecks?: Record<string, CustomCheck["run"]>;
}

/** Any adapter client; `close` is optional and awaited at the end of the attempt. */
export type AdapterClient = object & { close?(): Promise<void> };

/**
 * Constructed once per attempt, from the binding's non-secret `config` and
 * the secrets the engine resolved for it. An adapter never sees the
 * environment, the manifest or any other binding.
 */
export interface AdapterConstructor {
  new (config: Record<string, unknown>, secrets: Record<string, string>): AdapterClient;
}

/** What `adapter()` takes. Written by hand; `RegisteredAdapter` is what the bundle carries. */
export interface AdapterDeclaration {
  /** The connection `type` this adapter serves, as a binding names it. */
  type: string;
  /** Config field -> its type, the shape the engine validates a binding against. */
  configSchema?: Record<string, string>;
  /** Config keys supplied through `secret_refs`, never as plain config values. */
  secretFields?: string[];
  /**
   * Where `Client` is imported from, for `puppi-env.d.ts`
   * (`"./src/adapters/acme.js"`). Without it, `ctx.connection()` is `unknown`.
   */
  clientModule?: string;
  Client: AdapterConstructor;
}

/** An `adapter()` declaration as the bundle carries it: manifest field names, normalized. */
export interface RegisteredAdapter {
  type: string;
  config_schema: Record<string, string>;
  secret_fields: string[];
  client_module?: string;
  Client: AdapterConstructor;
}

export interface Registry {
  /** Every group definition, including the implicit configurable `default`. */
  groups: Record<string, GroupDefinition>;
  assets: Record<string, Declaration>;
  /** Connection types this bundle brings with it, beyond the ones the executor serves. */
  adapters: Record<string, RegisteredAdapter>;
}
