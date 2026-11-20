/**
 * Table and file storage. `postgres`, `filesystem`, and `s3` implement
 * `TableStorage`. `@puppi/adapter-s3` implements `ObjectStorage`.
 * The digest, page keys, and Parquet bytes live in `@puppi/adapter-storage`.
 */

import type { Row } from "./types.js";

export type { Row };

export interface Column {
  name: string;
  type: string;
}

export interface WriteResult {
  storage_ref: string;
  observed_schema: Column[];
  stats: { row_count: number; bytes: number | null; content_hash: string | null };
}

/** What `put` reports. The sha256 is the materialization's `content_hash`. */
export interface PutObjectResult {
  sha256: string;
  bytes: number;
  contentType: string | null;
}

/** What `head` reports, or null when the object is absent. */
export interface ObjectHead {
  bytes: number | null;
  contentType: string | null;
}

/** Deletes one materialization. Retention calls this, and so does page cleanup. */
interface MaterializationDrop {
  /**
   * Direction `@write`. `pages: false` removes the named object and a leftover
   * commit marker, and leaves append pages for the checkpoint.
   */
  drop(storageRef: string, options?: { pages?: boolean }): Promise<void>;
}

/**
 * A table materialization. An append source stages each page with `write`.
 * The executor then passes those pages, one batch at a time, to `write`
 * again. An iterable may be read twice: schema, then the bytes. `drop`
 * removes a materialization and its pages. `postgres`, `filesystem`, and
 * `s3` implement this.
 */
export interface TableStorage extends MaterializationDrop {
  /**
   * Direction `@write`. Creates `storage_ref` from `rows`, replacing whatever
   * held that name. An async iterable is read one batch at a time and may be
   * iterated twice (schema, then the bytes). A crash before the replace
   * finishes leaves the previous object in place.
   */
  write(storageRef: string, rows: Row[] | AsyncIterable<Row[]>): Promise<WriteResult>;
  /** Direction `@read`. Reads a materialization back; how a destination re-emits its upstream. */
  read(storageRef: string): Promise<Row[]>;
  /** Direction `@read`. Backs `ctx.query()`; rejects on a storage that runs no queries. */
  query(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Lifecycle. No direction. */
  close(): Promise<void>;
}

/**
 * A file materialization: one object, streamed. `@puppi/adapter-s3`
 * implements this.
 */
export interface ObjectStorage extends MaterializationDrop {
  /**
   * Direction `@write`. Stores one object at `storageRef`. The
   * body is the caller's stream. `ctx.emitFile` uses this instead of `write`.
   */
  put(
    storageRef: string,
    body: ReadableStream<Uint8Array>,
    options?: { contentType?: string | null },
  ): Promise<PutObjectResult>;
  /** Direction `@read`. The object's bytes. A file ref's `stream()` calls this. */
  get(storageRef: string): Promise<ReadableStream<Uint8Array>>;
  /** Direction `@read`. Size and content type, or null when there is no object. */
  head(storageRef: string): Promise<ObjectHead | null>;
  /** Lifecycle. No direction. */
  close(): Promise<void>;
}

/** A table store or an object store. `drop` is on both. */
export type StorageAdapter = TableStorage | ObjectStorage;

/**
 * A destination connector. It is a table store: `write`, `read`, `query`,
 * `drop`, and `close` are required. A destination stores the rows it
 * delivers, and a later read returns them. The rest are optional.
 * Implementing one is the promise.
 */
export interface Destination extends TableStorage {
  /** Deletes every materialization under a prefix. An environment delete calls this. */
  dropPrefix?(prefix: string): Promise<void>;
  /** Removes rows above a cursor. Append and incremental need this. */
  trim?(storageRef: string, cursor: string): Promise<void>;
  /** Copies one prefix onto another. Preview seeding and `replay_raw` call this. */
  clone?(fromPrefix: string, toPrefix: string): Promise<void>;
}
