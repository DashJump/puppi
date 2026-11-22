import {
  isTransient,
  type ObjectStorage,
  type Row,
  type StorageAdapter,
  storedRetryAfter,
  type TableStorage,
} from "@puppi/sdk";

import { declarationOf, loadRegistry } from "./bundle.js";
import { runChecks } from "./checks.js";
import { isTerminal, TerminalError } from "./errors.js";
import { AdapterPool } from "./pool.js";
import { produce } from "./produce.js";
import type { ErrorEvent, ExecutorEvent, ExecutorInput, ResultEvent } from "./protocol.js";
import { CheckShim, Shim, storageBinding } from "./shim/ctx.js";
import type { StagedPage } from "./shim/pages.js";
import { assertCursor } from "./shim/positions.js";
import { Spool } from "./shim/spool.js";
import { isUnchanged } from "./shim/unchanged.js";
import { TelemetryShim } from "./telemetry.js";

export type EmitExecutorEvent = (event: ExecutorEvent) => void;

/**
 * The engine's end-of-attempt ack. Pages follow the checkpoint: `recorded`
 * and `skipped` drop them, `rejected` and `fenced` keep them. The output
 * table is dropped only for an explicit `rejected`, `fenced`, or `skipped`.
 */
export type SettleOutcome = "recorded" | "rejected" | "fenced" | "skipped";

/** The engine fenced this attempt after the child had already cleaned up. */
export class AttemptFenced extends Error {
  constructor() {
    super("attempt fence rejected");
    this.name = "AttemptFenced";
  }
}

/** The engine cancelled the run. The attempt stops and posts no result. */
export class AttemptCancelled extends Error {
  constructor() {
    super("attempt cancelled");
    this.name = "AttemptCancelled";
  }
}

/** Resolves once the engine has committed or rejected the attempt. */
export type SettleAttempt = (result: ResultEvent | ErrorEvent) => Promise<SettleOutcome>;

/** Executes one complete Attempt; transport and process lifetime live elsewhere. */
export async function execute(
  input: ExecutorInput,
  emit: EmitExecutorEvent,
  settle: SettleAttempt = async () => "recorded",
): Promise<ResultEvent> {
  const spans = new TelemetryShim(emit, "shim");
  const loaded = { assets: 0, adapters: 0 };
  const registry = await spans.span(
    "bundle_loaded",
    async () => {
      const loadedRegistry = await loadRegistry(input.bundle_ref);
      loaded.assets = Object.keys(loadedRegistry.assets).length;
      loaded.adapters = Object.keys(loadedRegistry.adapters).length;
      return loadedRegistry;
    },
    loaded,
  );
  const declaration = declarationOf(registry, input.asset_key);
  const storage = storageBinding(input);
  const pool = new AdapterPool(input, registry.adapters);
  const adapter = pool.storage(storage.name);
  // True when this attempt was given a checkpoint or published one. A 401
  // after that can resume with a new token. A 401 before any checkpoint is
  // a bad credential and stays terminal.
  let checkpointed = input.checkpoint !== null;
  const emitEvent: EmitExecutorEvent = (event) => {
    if (event.event === "checkpoint") checkpointed = true;
    return emit(event);
  };
  const spool = new Spool();
  let outputWritten = false;
  let cleaned = false;
  let pages: readonly StagedPage[] = [];
  const ack = { sent: false };
  const settleOnce: SettleAttempt = async (result) => {
    ack.sent = true;
    return settle(result);
  };
  const shim = new Shim(
    input,
    adapter,
    storage.binding.mode,
    emitEvent,
    pool,
    {
      mode: stringField(declaration.config["mode"]),
      cursor: stringField(declaration.config["cursor"]),
    },
    spool,
  );

  try {
    const append = declaration.config["mode"] === "append";
    const ref = input.output_storage_ref;

    try {
      await produce(declaration, shim, adapter);
    } catch (error) {
      if (isUnchanged(error) || shim.unchangedSignaled) throw error;
      if (!(await shim.dropExpiredPageToken(error))) throw error;

      await produce(declaration, shim, adapter);
    }

    if (shim.unchangedSignaled) {
      return finishUnchanged(input, shim, adapter, emit, settleOnce);
    }

    // The build refuses a file on a table store, and a table on an object store.
    if (shim.file) {
      outputWritten = true;
      return finishFile(
        input,
        shim.file,
        adapter as ObjectStorage,
        ref,
        declaration,
        emit,
        settleOnce,
        spans,
      );
    }

    const table = adapter as TableStorage;
    const finished = await shim.finish();
    const wrote = {
      connection: storage.name,
      rows: 0,
      bytes: null as number | null,
    };
    pages = shim.stagedPages();
    let checkRows: Row[] = [];
    const written = await spans.span(
      "adapter_write",
      async () => {
        // A large output was spooled to disk; stream it, and read it back only for checks.
        if (!append && spool.onDisk) {
          const result = await table.write(ref, spool.batches());
          wrote.rows = result.stats.row_count;
          wrote.bytes = result.stats.bytes;
          checkRows = hasCustomChecks(declaration) ? await table.read(ref) : [];
          return result;
        }

        if (!append) {
          const rows = [...spool.inMemory(), ...finished.tail];
          wrote.rows = rows.length;
          checkRows = rows;
          const result = await table.write(ref, rows);
          wrote.bytes = result.stats.bytes;
          return result;
        }

        // Pages stay until the engine records this ref. Dropping them first,
        // or reassembling over the same ref, is how a retry lost rows.
        const result =
          pages.length > 0 || finished.tail.length > 0
            ? await table.write(ref, pageBatches(table, pages, finished.tail))
            : await table.write(ref, spool.onDisk ? spool.batches() : spool.inMemory());

        wrote.rows = result.stats.row_count;
        wrote.bytes = result.stats.bytes;
        checkRows = await table.read(ref);
        return result;
      },
      wrote,
    );

    const cursorTo = committedCursor(declaration.config, shim, wrote.rows, finished.tail);
    outputWritten = true;
    const check_results = await runChecks(
      declaration,
      new CheckShim(checkRows, written.storage_ref, table, emit),
    );
    const result: ResultEvent = {
      event: "result",
      storage_ref: written.storage_ref,
      observed_schema: written.observed_schema,
      stats: written.stats,
      cursor_to: cursorTo,
      check_results,
      checkpoint: null,
    };

    const outcome = await settleOnce(result);
    await cleanupOutput(adapter, pages, ref, outcome, input, emit);
    cleaned = true;
    if (outcome === "fenced") throw new AttemptFenced();

    return result;
  } catch (error) {
    if (error instanceof AttemptCancelled) throw error;

    if (isUnchanged(error) || shim.unchangedSignaled) {
      return finishUnchanged(input, shim, adapter, emit, settleOnce);
    }

    // A page write already in flight must finish so its checkpoint is not lost.
    // A checkpoint that is still waiting on rows stays unpublished.
    await shim.settle().catch(() => undefined);

    // The check threw before a result ack. Ask for the outcome now, while the
    // adapter is still open. An unknown or lost ack leaves the table and the pages.
    if (outputWritten && !cleaned && !ack.sent) {
      try {
        const outcome = await settleOnce(errorEvent(error));
        await cleanupOutput(adapter, pages, input.output_storage_ref, outcome, input, emit);
        cleaned = true;
        if (outcome === "fenced") throw new AttemptFenced();
      } catch (ackError) {
        if (ackError instanceof AttemptFenced) throw ackError;
      }
    }

    if (checkpointed && unauthorized(error)) throw new ResumeAfterUnauthorized(error);

    throw error;
  } finally {
    await pool.close();
    await spool.close();
  }
}

/**
 * The producer called `ctx.emitFile`. `put` receives the original stream.
 * The spool is not used, and `write` is not called.
 */
async function finishFile(
  input: ExecutorInput,
  file: {
    body: ReadableStream<Uint8Array>;
    contentType: string | null;
    meta: Record<string, unknown>;
  },
  adapter: ObjectStorage,
  ref: string,
  declaration: ReturnType<typeof declarationOf>,
  emit: EmitExecutorEvent,
  settle: SettleAttempt,
  spans: TelemetryShim,
): Promise<ResultEvent> {
  const stored = await spans.span(
    "adapter_put",
    () => adapter.put(ref, file.body, { contentType: file.contentType }),
    { connection: input.storage_connection, bytes: null },
  );
  const check_results = await runChecks(declaration, new CheckShim([], ref, adapter, emit));
  const result: ResultEvent = {
    event: "result",
    storage_ref: ref,
    observed_schema: [],
    stats: {
      row_count: 0,
      bytes: stored.bytes,
      content_hash: stored.sha256,
      content_type: stored.contentType ?? file.contentType,
      meta: file.meta,
    },
    cursor_to: null,
    check_results,
    checkpoint: null,
  };

  const outcome = await settle(result);
  await cleanupOutput(adapter, [], ref, outcome, input, emit);
  if (outcome === "fenced") throw new AttemptFenced();

  return result;
}

/**
 * No write. The engine records `skipped` and stamps `verified_at` on the
 * current latest, or fails the attempt when there is no latest to stamp.
 */
async function finishUnchanged(
  input: ExecutorInput,
  shim: Shim,
  adapter: StorageAdapter,
  emit: EmitExecutorEvent,
  settle: SettleAttempt,
): Promise<ResultEvent> {
  if (shim.emittedRows) {
    throw new TerminalError(`${input.asset_key} called ctx.unchanged() after emitting`);
  }

  const result: ResultEvent = {
    event: "result",
    storage_ref: input.latest?.storage_ref ?? input.output_storage_ref,
    observed_schema: [],
    stats: { row_count: 0, bytes: null, content_hash: null },
    cursor_to: input.cursor_from,
    check_results: [],
    checkpoint: null,
    unchanged: true,
  };

  const outcome = await settle(result);
  await cleanupOutput(adapter, [], input.output_storage_ref, outcome, input, emit);
  if (outcome === "fenced") throw new AttemptFenced();

  return result;
}

/** The skip already stands. A drop that fails is a warning, not a failed attempt. */
async function dropMatchedObject(
  input: ExecutorInput,
  adapter: StorageAdapter,
  ref: string,
  emit: EmitExecutorEvent,
): Promise<void> {
  try {
    await adapter.drop(ref, { pages: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    emit({
      event: "log",
      level: "warn",
      message: `${input.asset_key} could not drop ${ref} after a matching sha256: ${detail}`,
    });
  }
}

function hasCustomChecks(declaration: ReturnType<typeof declarationOf>): boolean {
  return Object.keys(declaration.customChecks ?? {}).length > 0;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * One page at a time, then the tail. A new iterator re-reads, because `write`
 * walks the batches twice and must not hold them. Refs come from the
 * checkpoint, so a retry can read pages an earlier execution stored.
 */
function pageBatches(
  adapter: TableStorage,
  pages: readonly StagedPage[],
  tail: readonly Row[],
): AsyncIterable<Row[]> {
  return {
    [Symbol.asyncIterator](): AsyncGenerator<Row[]> {
      return readPages(adapter, pages, tail);
    },
  };
}

async function* readPages(
  adapter: TableStorage,
  pages: readonly StagedPage[],
  tail: readonly Row[],
): AsyncGenerator<Row[]> {
  for (const page of pages) yield await adapter.read(page.ref);
  if (tail.length > 0) yield [...tail];
}

/**
 * Pages follow the checkpoint. The output table is dropped only when the
 * engine explicitly did not keep it.
 */
async function cleanupOutput(
  adapter: StorageAdapter,
  pages: readonly StagedPage[],
  ref: string,
  outcome: SettleOutcome,
  input: ExecutorInput,
  emit: EmitExecutorEvent,
): Promise<void> {
  if (outcome === "recorded" || outcome === "skipped") {
    try {
      await dropPages(adapter as TableStorage, pages);
    } catch (error) {
      warnDrop(input, ref, error, emit);
    }
  }

  if (outcome === "rejected" || outcome === "fenced" || outcome === "skipped") {
    await dropMatchedObject(input, adapter, ref, emit);
  }
}

function warnDrop(
  input: ExecutorInput,
  ref: string,
  error: unknown,
  emit: EmitExecutorEvent,
): void {
  const detail = error instanceof Error ? error.message : String(error);

  emit({
    event: "log",
    level: "warn",
    message: `${input.asset_key} could not drop ${ref}: ${detail}`,
  });
}

/** Deletes the pages the checkpoint named. */
async function dropPages(adapter: TableStorage, pages: readonly StagedPage[]): Promise<void> {
  if (pages.length === 0) return;

  for (const page of pages) await adapter.drop(page.ref);
}

/**
 * Append commits the watermark. The tail is included. Rows with no cursor
 * value fail the attempt; `cursor_from` is only the empty-delta fallback.
 * Everything else keeps the page cursor `processPages` reports.
 */
function committedCursor(
  config: Record<string, unknown>,
  shim: Shim,
  rowCount: number,
  tail: readonly Row[],
): string | null {
  const cursor = config["cursor"];

  if (config["mode"] === "append" && typeof cursor === "string" && cursor !== "") {
    const value = shim.watermark(cursor, tail);

    if (value !== null) return checkedCursor(value);
    if (rowCount === 0) return checkedCursor(shim.cursorFrom);

    throw new TerminalError(`append cursor ${cursor} is missing after storing ${rowCount} rows`);
  }

  return checkedCursor(shim.cursorTo);
}

function checkedCursor(cursor: string | null): string | null {
  assertCursor(cursor);
  return cursor;
}

/**
 * A 401 that arrived after a checkpoint. The message is the refusal the
 * API returned. The next attempt resumes that checkpoint.
 */
class ResumeAfterUnauthorized extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ResumeAfterUnauthorized";
  }
}

/** A 401 that is not already terminal. Status is read the way `isTransient` reads it, including a bundled copy. */
function unauthorized(error: unknown): boolean {
  if (isTerminal(error)) return false;

  const seen = new Set<unknown>();
  let current: unknown = error;

  while (
    current !== null &&
    current !== undefined &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    seen.add(current);

    if ((current as { status?: unknown }).status === 401) return true;

    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * Transient by the same rule adapters use. `isTransient` reads structured
 * fields and then the message; a `TerminalError` is terminal either way.
 */
export function errorEvent(error: unknown): ErrorEvent {
  const message = describe(error);
  const authResume = error instanceof ResumeAfterUnauthorized;
  const retryable = authResume || (!isTerminal(error) && isTransient(error));
  const retryAfter = retryable ? storedRetryAfter(authResume ? error.cause : error) : null;

  return retryAfter === null
    ? { event: "error", class: retryable ? "retryable" : "terminal", message }
    : { event: "error", class: "retryable", message, retry_after_ms: retryAfter };
}

/**
 * The message, then each cause in its chain. A body cut mid-stream is only
 * "terminated"; its cause names the code, the remote end, and the bytes read.
 */
function describe(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  const seen = new Set<unknown>([error]);
  let current = (error as { cause?: unknown } | null)?.cause;

  while (current !== null && current !== undefined && !seen.has(current) && seen.size < 6) {
    seen.add(current);

    const part = causeText(current, text);

    if (part !== null) text += `; cause: ${part}`;

    current = (current as { cause?: unknown }).cause;
  }

  return redactCause(text);
}

/**
 * Returns the clause for this cause, or null when it has no code, no
 * socket, and no message beyond `soFar`.
 */
function causeText(cause: unknown, soFar: string): string | null {
  if (!(cause instanceof Error)) return String(cause);

  const { code, socket } = cause as { code?: unknown; socket?: SocketInfo };
  const head = typeof code === "string" ? `${cause.name} ${code}` : cause.name;
  const message = cause.message && !soFar.includes(cause.message) ? `: ${cause.message}` : "";
  // The local end is omitted. A this-host, loopback, link-local, RFC 1918,
  // CGNAT, or ULA remote address is printed as `private`, including the
  // hex IPv4-mapped form and a NAT64 form of one of those.
  const ends =
    socket && typeof socket === "object"
      ? ` (${shownAddress(socket.remoteAddress)}:${socket.remotePort}, ${socket.bytesRead} bytes read)`
      : "";

  if (typeof code !== "string" && message === "" && ends === "") return null;

  return `${head}${message}${ends}`;
}

/** The remote address, port, and bytes read that undici sets on a `SocketError`. */
interface SocketInfo {
  remoteAddress?: string;
  remotePort?: number;
  bytesRead?: number;
}

/** Hides URL userinfo and the values of token, key, secret, password, auth, and code parameters. */
function redactCause(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/gi, "$1redacted@")
    .replace(/(^|[\s(])([^\s/:@]+):[^/?#\s]*@/g, "$1redacted@")
    .replace(/([?&])([^=&\s]+)=([^&#\s)]*)/g, (match, sep: string, name: string) =>
      sensitiveQueryName(name) ? `${sep}${name}=redacted` : match,
    );
}

function sensitiveQueryName(name: string): boolean {
  let decoded = name;

  try {
    decoded = decodeURIComponent(name);
  } catch {
    decoded = name;
  }

  return decoded
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((part) =>
      /^(?:(?:api)?(?:access)?(?:token|key|secret|signature|sig)|password|passwd|pwd|auth|credential|code)$/.test(
        part,
      ),
    );
}

/** A public address is shown. This-host, loopback, link-local, RFC 1918, CGNAT, and ULA are `private`. */
function shownAddress(address: string | undefined): string {
  if (address !== undefined && isPrivateAddress(address)) return "private";

  return String(address);
}

function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").split("%")[0] ?? "";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);

  if (mapped?.[1]) return isPrivateIpv4(mapped[1]);
  if (bare.includes(".")) return isPrivateIpv4(bare);

  const hextets = ipv6Hextets(bare);

  return hextets !== null && isPrivateIpv6(hextets);
}

function isPrivateIpv4(text: string): boolean {
  const parts = text.split(".");

  if (parts.length !== 4) return false;

  const nums = parts.map((part) => Number(part));

  if (nums.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return false;

  const a = nums[0] ?? -1;
  const b = nums[1] ?? -1;

  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;

  return a === 169 && b === 254;
}

/** Parses one side of an IPv6 `::` split. An empty side is the compressed run of zeros. */
function parseIpv6Side(side: string): number[] | null {
  if (side === "") return [];

  const parts = side.split(":");
  const nums = parts.map((part) =>
    /^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : Number.NaN,
  );

  return nums.some((num) => Number.isNaN(num)) ? null : nums;
}

function ipv6Hextets(address: string): number[] | null {
  const halves = address.split("::");

  if (halves.length > 2) return null;

  const head = parseIpv6Side(halves[0] ?? "");

  if (head === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = parseIpv6Side(halves[1] ?? "");

  if (tail === null || head.length + tail.length > 7) return null;

  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}

function isPrivateIpv6(parts: number[]): boolean {
  const first = parts[0] ?? 0;
  const rest = parts.slice(1);
  const loopback =
    first === 0 && rest.every((part, index) => part === (index === rest.length - 1 ? 1 : 0));

  if (loopback) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xfe00) === 0xfc00) return true;

  const embedded = embeddedIpv4(parts);

  return embedded !== null && isPrivateIpv4(embedded);
}

/** The IPv4 inside a hex `::ffff:` address or a `64:ff9b::/96` NAT64 address. */
function embeddedIpv4(parts: number[]): string | null {
  const head = parts.slice(0, 6);
  const is = (prefix: number[]) => prefix.every((part, index) => head[index] === part);
  const mapped = is([0, 0, 0, 0, 0, 0xffff]);
  const nat64 = is([0x64, 0xff9b, 0, 0, 0, 0]);

  if (!mapped && !nat64) return null;

  const hi = parts[6] ?? 0;
  const lo = parts[7] ?? 0;

  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}
