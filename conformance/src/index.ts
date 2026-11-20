/**
 * Checks a storage adapter against the object-store contract.
 *
 * The observed schema and a non-null digest are read as fact. `write(ref)`
 * must keep every other ref. `drop` and `dropPrefix` are checked when present.
 * `runSourceConformance` is the same idea for an HTTP source.
 */

import { contentHash, deriveSchema } from "@puppi/adapter-storage";
import type { Row, TableStorage } from "@puppi/sdk";

import { type ConformanceCheck, equal, run } from "./report.js";

export { assertConformant, type ConformanceCheck, formatConformance } from "./report.js";
export {
  runSourceConformance,
  type SourceConformanceOptions,
  type SourceConnector,
} from "./source.js";

/** Retention and environment delete; declared as `drop` and `drop_prefix`. */
export interface Droppable {
  drop(storageRef: string): Promise<void>;
  dropPrefix(prefix: string): Promise<void>;
}

export interface ConformanceOptions {
  /** The adapter under test, constructed and ready to write. */
  adapter: TableStorage & Partial<Droppable>;
  /**
   * A storage prefix the suite owns. Everything it writes goes under this
   * prefix, and the `drop_prefix` check empties it, so it must not be a
   * prefix that holds anything else.
   */
  prefix: string;
  /** Distinguishes one run's objects from another's; defaults to a timestamp. */
  run?: string;
  /**
   * True when this adapter takes its digest from `@puppi/adapter-storage`,
   * which adds a check that the two agree. Off by default: the algorithm and
   * its coverage are the adapter owner's choice, and two digests are compared
   * only for equality. The properties below are the part that is not optional.
   */
  sharedDigest?: boolean;
}

/** Rows covering every type the observed-schema vocabulary can name, nulls included. */
const ROWS: Row[] = [
  { id: "a", n: 7, f: 1.5, ok: true, tags: ["x"], nothing: null },
  { id: "b", n: 8, f: 2, ok: false, tags: { k: 1 }, nothing: null },
  { id: "c", n: null, f: null, ok: null, tags: null, nothing: null },
];

export async function runStorageConformance(
  options: ConformanceOptions,
): Promise<ConformanceCheck[]> {
  const context = new Context(options);
  const checks: ConformanceCheck[] = [];

  checks.push(
    await context.check("write reports the row count and the observed schema", writeResult),
  );
  checks.push(await context.check("read returns what was written, type for type", roundTrip));
  checks.push(await context.check("an empty row set is still a materialization", emptyRowSet));
  checks.push(
    await context.whenDigest("the digest is order-insensitive and duplicate-sensitive", digest),
  );
  checks.push(
    context.sharedDigest
      ? await context.check("the digest agrees with the storage base", sharedDigestCheck)
      : {
          name: "the digest agrees with the storage base",
          status: "skipped" as const,
          detail: "the adapter does not claim the storage base's digest",
        },
  );
  checks.push(await context.check("a write lands under its own prefix only", isolation));
  checks.push(await context.check("materializations of one asset coexist", versioned));
  // Destructive, so last, and in the order that leaves nothing behind.
  checks.push(await context.whenMethod("drop", "drop removes one materialization's data", drop));
  checks.push(
    await context.whenMethod("dropPrefix", "dropPrefix empties the whole prefix", dropPrefix),
  );

  return checks;
}

/** The suite's own state: the adapter, and a fresh storage ref whenever one is needed. */
class Context {
  readonly adapter: ConformanceOptions["adapter"];
  readonly prefix: string;
  readonly sharedDigest: boolean;
  private readonly run: string;
  private counter = 0;

  constructor(options: ConformanceOptions) {
    this.adapter = options.adapter;
    this.prefix = options.prefix;
    this.sharedDigest = options.sharedDigest ?? false;
    this.run = options.run ?? String(Date.now());
  }

  /** `<prefix>.<name>__<run>`, the shape of a materialization ref. */
  ref(name: string): string {
    return `${this.prefix}.${name}_${this.counter++}__${this.run}`;
  }

  check(name: string, body: (context: Context) => Promise<void>): Promise<ConformanceCheck> {
    return run(name, () => body(this));
  }

  /**
   * The digest checks run when `write` returned one. A null digest skips
   * them, so there is nothing here to judge.
   */
  async whenDigest(
    name: string,
    body: (context: Context) => Promise<void>,
  ): Promise<ConformanceCheck> {
    const { stats } = await this.adapter.write(this.ref("digest-probe"), []);

    if (typeof stats.content_hash !== "string") {
      return { name, status: "skipped", detail: "the write returned no digest" };
    }

    return this.check(name, body);
  }

  /** An optional method. Absent is skipped. Present and wrong is a failure. */
  async whenMethod(
    method: "drop" | "dropPrefix",
    name: string,
    body: (context: Context) => Promise<void>,
  ): Promise<ConformanceCheck> {
    if (typeof this.adapter[method] !== "function") {
      return { name, status: "skipped", detail: `implements no ${method}()` };
    }

    return this.check(name, body);
  }

  /** The digest of one write, for the property checks. */
  async hashOf(rows: Row[]): Promise<string> {
    const { stats } = await this.adapter.write(this.ref("digest"), rows);

    if (typeof stats.content_hash !== "string") {
      throw new Error("the write returned no digest");
    }

    return stats.content_hash;
  }
}

async function writeResult(context: Context): Promise<void> {
  const ref = context.ref("result");
  const written = await context.adapter.write(ref, ROWS);

  equal(written.storage_ref, ref, "storage_ref is the ref it was asked to write");
  equal(written.stats.row_count, ROWS.length, "row_count counts the rows written");
  equal(
    written.observed_schema,
    deriveSchema(ROWS),
    "observed_schema is the schema the storage base derives from these rows",
  );
}

async function roundTrip(context: Context): Promise<void> {
  const ref = context.ref("roundtrip");

  await context.adapter.write(ref, ROWS);
  // Row order is the adapter's business; the rows themselves are not.
  equal(sorted(await context.adapter.read(ref)), sorted(ROWS), "read returned different rows");
}

async function emptyRowSet(context: Context): Promise<void> {
  const ref = context.ref("empty");
  const written = await context.adapter.write(ref, []);

  equal(written.stats.row_count, 0, "an empty write reports no rows");
  equal(await context.adapter.read(ref), [], "an empty materialization reads back empty");
}

async function digest(context: Context): Promise<void> {
  const first = { id: "1", plan: "pro" };
  const second = { id: "2", plan: "free" };
  const rows = [first, second];

  equal(
    await context.hashOf(rows),
    await context.hashOf([second, first]),
    "a reordered result is not a change, so its digest must not move",
  );
  equal(
    await context.hashOf(rows),
    await context.hashOf(rows),
    "identical data must hash the same",
  );
  different(
    await context.hashOf([{ id: "1" }]),
    await context.hashOf([{ id: "1" }, { id: "1" }]),
    "two identical rows are not one, so their digest must differ from one row's",
  );
  different(
    await context.hashOf([]),
    await context.hashOf([{ id: "1" }, { id: "1" }]),
    "a pair of identical rows is not an empty result; combining row hashes with XOR " +
      "makes these equal, because identical rows cancel out",
  );
  different(
    await context.hashOf([{ id: "1", plan: "pro" }]),
    await context.hashOf([{ id: "1", plan: "free" }]),
    "a changed value must change the digest",
  );
  different(
    await context.hashOf([{ id: "1" }]),
    await context.hashOf([{ id: "1", plan: "pro" }]),
    "a new column must change the digest",
  );
}

/**
 * Only for an adapter that says it shares the base's digest. Two storages
 * that agree let an asset move between them without changing its skip
 * behaviour; two that disagree are both correct, and digests are compared
 * only within one storage.
 */
async function sharedDigestCheck(context: Context): Promise<void> {
  const rows = [{ id: "1", plan: "pro" }];

  equal(
    await context.hashOf(rows),
    contentHash(rows),
    "the digest is not the one @puppi/adapter-storage computes",
  );
}

async function isolation(context: Context): Promise<void> {
  const mine = context.ref("isolated");
  const other = context.ref("isolated");

  await context.adapter.write(mine, [{ id: "mine" }]);
  await context.adapter.write(other, [{ id: "other" }]);

  equal(await context.adapter.read(mine), [{ id: "mine" }], "a write reached another ref's data");
}

async function versioned(context: Context): Promise<void> {
  const first = context.ref("versioned");
  const second = context.ref("versioned");

  await context.adapter.write(first, [{ v: 1 }]);
  await context.adapter.write(second, [{ v: 2 }]);

  // Rollback is a pointer move only if the older materialization is still there.
  equal(
    await context.adapter.read(first),
    [{ v: 1 }],
    "writing a newer materialization destroyed the older one",
  );
  equal(
    await context.adapter.read(second),
    [{ v: 2 }],
    "the newer materialization is not readable",
  );
}

async function drop(context: Context): Promise<void> {
  const dropped = context.ref("dropped");
  const kept = context.ref("kept");

  await context.adapter.write(dropped, [{ id: "gone" }]);
  await context.adapter.write(kept, [{ id: "here" }]);
  await context.adapter.drop(dropped);

  await rejects(
    () => context.adapter.read(dropped),
    "reading a dropped materialization must fail rather than return rows",
  );
  equal(await context.adapter.read(kept), [{ id: "here" }], "drop reached another materialization");

  // A second drop of the same ref is allowed.
  await context.adapter.drop(dropped);
}

async function dropPrefix(context: Context): Promise<void> {
  const ref = context.ref("in_prefix");

  await context.adapter.write(ref, [{ id: "gone" }]);
  await context.adapter.dropPrefix!(context.prefix);

  await rejects(
    () => context.adapter.read(ref),
    "a materialization under a dropped prefix must be gone",
  );
}

function sorted(rows: readonly Row[]): string[] {
  return rows
    .map((row) =>
      JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)))),
    )
    .sort();
}

function different(actual: unknown, other: unknown, why: string): void {
  if (JSON.stringify(actual) === JSON.stringify(other)) throw new Error(why);
}

async function rejects(body: () => Promise<unknown>, why: string): Promise<void> {
  try {
    await body();
  } catch {
    return;
  }

  throw new Error(why);
}
