/**
 * `@puppi/adapter-storage`: the base the object storage adapters are built
 * on. It is not a connection type of its own. Everything a write reports
 * — the observed schema, the content digest, the bytes — is
 * computed here, so `@puppi/adapter-filesystem` and `@puppi/adapter-s3`
 * supply an `ObjectStore` and nothing else, and cannot drift from each
 * other or from what `@puppi/adapter-postgres` reports for the same rows.
 */

import { createHash } from "node:crypto";

import { type Destination, read, type Row, write, type WriteResult } from "@puppi/sdk";

import { RowDigest } from "./contract.js";
import { isPageKey, PAGE_MARK } from "./pages.js";
import {
  decodeParquet,
  encodeParquet,
  finishParquet,
  openParquet,
  writeParquetRows,
} from "./parquet.js";

export { baseType, contentHash, deriveSchema, RowDigest } from "./contract.js";
export { isPageKey, PAGE_MARK, pageKeyFor } from "./pages.js";
export { decodeParquet, encodeParquet, SCHEMA_KEY, toArrayBuffer } from "./parquet.js";

/** What a concrete adapter supplies: bytes under a key, and nothing about rows. */
export interface ObjectStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Rejects when nothing is at `key`. */
  get(key: string): Promise<Uint8Array>;
  /** Resolves whether or not anything was at `key`. */
  delete(key: string): Promise<void>;
  /** Every key beginning with `prefix`. */
  list(prefix: string): Promise<string[]>;
  close?(): Promise<void>;
}

export interface StorageRef {
  prefix: string;
  name: string;
}

/**
 * `<storage_prefix>.<asset_slug>__<short id>` read as an
 * object store does: `prefix` is a directory and `name` a file in it. The
 * same shape postgres reads as schema and table.
 */
export function parseStorageRef(ref: string): StorageRef {
  const parts = ref.split(".");
  const [prefix, name] = parts;

  if (parts.length !== 2 || !prefix || !name || !isSegment(prefix) || !isSegment(name)) {
    throw new Error(`malformed storage_ref: ${ref} (want "<prefix>.<name>")`);
  }

  return { prefix, name };
}

/** One path segment: never a traversal, never a separator. */
function isSegment(part: string): boolean {
  return part !== "." && part !== ".." && !/[/\\]/.test(part);
}

/** `<prefix>/<name>.parquet`: the object a storage ref names. */
export function objectKey(ref: string): string {
  const { prefix, name } = parseStorageRef(ref);

  return `${prefix}/${name}.parquet`;
}

/**
 * Sibling of a materialization: one append page, replaced as a whole.
 * `<prefix>.<name>__page_<128-bit slot>`. The same string is a postgres
 * table. A name that would pass 63 bytes is a hash of that full name, so a
 * long asset slug still has a stable sibling.
 */
export function pageStorageRef(storageRef: string, pageKey: string): string {
  if (!isPageKey(pageKey)) throw new Error(`malformed page key: ${pageKey}`);

  return siblingRef(storageRef, `${PAGE_MARK}${pageKey}`);
}

/**
 * Ordered page keys for one materialization, as one row `{ keys }`.
 * `<prefix>.<name>__page_index`. The executor no longer writes one; `drop`
 * still removes a leftover index, including pages it names.
 */
export function pageIndexRef(storageRef: string): string {
  return siblingRef(storageRef, `${PAGE_MARK}index`);
}

/**
 * A leftover commit marker: `<prefix>.<name>__commit`. The executor no
 * longer writes one. `drop` still removes it. A name past 63 bytes is
 * hashed the same way a page is.
 */
export function commitStorageRef(storageRef: string): string {
  return siblingRef(storageRef, "__commit");
}

const IDENT_MAX = 63;

function siblingRef(storageRef: string, suffix: string): string {
  const { prefix, name } = parseStorageRef(storageRef);
  const table = `${name}${suffix}`;

  if (Buffer.byteLength(table) <= IDENT_MAX) return `${storageRef}${suffix}`;

  // Postgres truncates identifiers at 63 bytes. Hash the full name so two
  // long siblings stay distinct and a retry still finds the same one.
  const shortened = `p${createHash("sha256")
    .update(table)
    .digest("hex")
    .slice(0, IDENT_MAX - 1)}`;

  return `${prefix}.${shortened}`;
}

/** Object keys `drop` removes along with the materialization. */
function pageObjectPrefix(storageRef: string): string {
  const { prefix, name } = parseStorageRef(storageRef);

  return `${prefix}/${name}${PAGE_MARK}`;
}

/** The keys `dropPrefix` removes: everything under the prefix's directory. */
export function prefixKey(prefix: string): string {
  if (!prefix || !isSegment(prefix)) throw new Error(`malformed storage prefix: ${prefix}`);

  return `${prefix}/`;
}

/**
 * A storage adapter over any `ObjectStore`. A materialization is one object,
 * so a failed write leaves the previous one untouched. Append pages are
 * sibling objects written with `write`. `drop` removes those, plus a
 * leftover commit marker or page index.
 */
export class ObjectStorageAdapter implements Destination {
  constructor(
    protected readonly store: ObjectStore,
    /** Named in the `query` refusal: `filesystem`, `s3`. */
    private readonly kind: string,
  ) {}

  @write
  async write(storageRef: string, rows: Row[] | AsyncIterable<Row[]>): Promise<WriteResult> {
    if (isAsyncBatches(rows)) return this.writeStream(storageRef, rows);

    const digest = new RowDigest();
    digest.add(rows);

    return this.publish(storageRef, digest, encodeParquet(rows, digest.schema()));
  }

  @read
  async read(storageRef: string): Promise<Row[]> {
    const { rows } = await decodeParquet(await this.store.get(objectKey(storageRef)));

    return rows;
  }

  /**
   * An object store runs no queries. A plain error is terminal in the
   * executor, which is right: no retry makes a query engine appear.
   */
  @read
  async query(_sql: string, _params: unknown[] = []): Promise<Row[]> {
    throw new Error(
      `${this.kind} storage runs no queries: ctx.query() needs a storage connection with a ` +
        `query engine, such as postgres. Read an upstream with ctx.input() and a TS producer instead.`,
    );
  }

  /** Removes one materialization and a leftover commit marker. Pages stay when `pages` is false. */
  @write
  async drop(storageRef: string, options?: { pages?: boolean }): Promise<void> {
    await this.store.delete(objectKey(storageRef));
    await this.store.delete(objectKey(commitStorageRef(storageRef)));
    if (options?.pages !== false) await this.dropPages(storageRef);
  }

  /** Removes every materialization under a storage prefix; an environment delete calls this. */
  async dropPrefix(prefix: string): Promise<void> {
    const keys = await this.store.list(prefixKey(prefix));

    await Promise.all(keys.map((key) => this.store.delete(key)));
  }

  async close(): Promise<void> {
    await this.store.close?.();
  }

  /** One page at a time into a buffer, then one put. The iterable is read twice. */
  private async writeStream(storageRef: string, rows: AsyncIterable<Row[]>): Promise<WriteResult> {
    const digest = new RowDigest();

    for await (const batch of rows) digest.add(batch);

    const bytes = await this.encodeBatches(rows, digest.schema(), digest.count);

    return this.publish(storageRef, digest, bytes);
  }

  /** The replace itself: one put of the finished object. */
  private async publish(
    storageRef: string,
    digest: RowDigest,
    bytes: Uint8Array,
  ): Promise<WriteResult> {
    await this.store.put(objectKey(storageRef), bytes);

    return {
      storage_ref: storageRef,
      observed_schema: digest.schema(),
      stats: {
        row_count: digest.count,
        bytes: bytes.byteLength,
        content_hash: digest.hash(),
      },
    };
  }

  /**
   * Second pass of a streaming write. The iterable is read again, one batch
   * at a time, into one Parquet buffer. The buffer is not stored here: the
   * caller puts it in one shot, so a crash leaves the previous object.
   */
  private async encodeBatches(
    rows: AsyncIterable<Row[]>,
    observed: ReturnType<RowDigest["schema"]>,
    expected: number,
  ): Promise<Uint8Array> {
    if (expected === 0) return encodeParquet([], observed);

    const opened = openParquet(observed);

    for await (const batch of rows) await writeParquetRows(opened.parquet, observed, batch);

    return finishParquet(opened.parquet, opened.writer, observed);
  }

  private async dropPages(storageRef: string): Promise<void> {
    const listed = await this.store.list(pageObjectPrefix(storageRef));
    const named = await this.indexedPageObjects(storageRef);

    await Promise.all([...new Set([...listed, ...named])].map((key) => this.store.delete(key)));
  }

  private async indexedPageKeys(storageRef: string): Promise<string[]> {
    try {
      const raw = (await this.read(pageIndexRef(storageRef)))[0]?.["keys"];

      return typeof raw === "string" && raw !== "" ? raw.split(",").filter(isPageKey) : [];
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("nothing at ")) return [];
      throw error;
    }
  }

  /** Pages named by the index, including names too long to share the prefix. */
  private async indexedPageObjects(storageRef: string): Promise<string[]> {
    const keys = await this.indexedPageKeys(storageRef);

    return [
      ...keys.map((key) => objectKey(pageStorageRef(storageRef, key))),
      objectKey(pageIndexRef(storageRef)),
    ];
  }
}

function isAsyncBatches(rows: Row[] | AsyncIterable<Row[]>): rows is AsyncIterable<Row[]> {
  return !Array.isArray(rows);
}
