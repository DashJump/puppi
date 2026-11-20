import { createHash } from "node:crypto";

import { isPageKey, pageKeyFor, pageStorageRef } from "@puppi/adapter-storage";
import { isExpiredPageToken } from "@puppi/sdk";
import type { Row, TableStorage } from "@puppi/sdk";

import { TerminalError } from "../errors.js";
import type { ExecutorEvent } from "../protocol.js";
import type { TelemetryShim } from "../telemetry.js";
import { assertCheckpoint } from "./positions.js";

/** Page list carried in the engine checkpoint. The producer does not see it. */
export const PAGE_LIST = "__puppi_pages";

/** One staged append page: the resume slot and the ref its rows were written to. */
export interface StagedPage {
  key: string;
  ref: string;
}

/**
 * Append-page staging for one attempt. Seals run in order, the page object
 * is written before its checkpoint is published, and an expired page token
 * is recovered once from the watermark.
 */
export class Pages {
  /** Rows of the append page that has not been stored yet. */
  private readonly pageRows: Row[] = [];
  private currentCheckpoint: Record<string, unknown> | null;
  /** Checkpoint the producer asked for, waiting on the rows that belong to it. */
  private pending: Record<string, unknown> | null = null;
  private sealChain: Promise<void> = Promise.resolve();
  private sealError: unknown = null;
  /** Append pages named by the checkpoint, in seal order. */
  private pages: StagedPage[];
  private pageTokenDropped = false;
  /** Slots sealed since `beginWalk`. A repeat is a cursor that did not advance. */
  private readonly walkSlots = new Set<string>();
  /**
   * Hashes of rows already staged when a page token was dropped. A restarted
   * walk re-emits them, often under a new token. A different row that shares
   * the watermark cursor is not in this set and is kept.
   */
  private boundary: Set<string> | null = null;

  constructor(
    checkpoint: Record<string, unknown> | null,
    private readonly outputRef: string | null,
    private readonly cursorField: string | undefined,
    readonly staging: boolean,
    private readonly adapter: TableStorage,
    private readonly assetKey: string,
    private readonly emitEvent: (event: ExecutorEvent) => void,
    private readonly spans: TelemetryShim,
  ) {
    this.pages = readPageList(checkpoint);
    this.currentCheckpoint = stripPages(checkpoint);
  }

  get state(): Record<string, unknown> | null {
    return this.currentCheckpoint;
  }

  get checkpointState(): Record<string, unknown> | null {
    return stripPages(this.currentCheckpoint);
  }

  /**
   * Drops rows already staged. When this attempt stages, buffers the rest
   * and seals them if a checkpoint is waiting. Otherwise returns the rows
   * the attempt keeps in memory.
   */
  async accept(rows: readonly Row[]): Promise<readonly Row[]> {
    // A seal of the last staged page keeps every emitted row in the batch.
    // Any other page omits rows already staged.
    const batch = this.overwritingBoundaryPage() ? rows : this.dropBoundary(rows);

    if (!this.staging) return batch;

    for (const row of batch) this.pageRows.push(row);
    if (!this.pending) return [];

    const state = this.pending;
    this.pending = null;
    const page = this.pageRows.splice(0, this.pageRows.length);
    await this.enqueue(() => this.seal(page, state));
    return [];
  }

  checkpoint(state: Record<string, unknown>): void {
    if (!this.staging) {
      this.currentCheckpoint = state;
      void this.publish(state);
      return;
    }

    // Publish only after the rows for this state are stored. Rows already
    // buffered seal now; rows emitted next seal inside `emit`.
    this.hold(state);

    if (this.pageRows.length === 0) {
      this.pending = state;
      return;
    }

    const page = this.pageRows.splice(0, this.pageRows.length);
    this.pending = null;
    void this.enqueue(() => this.seal(page, state)).catch(() => undefined);
  }

  /**
   * The user's write ran. Stage the same rows, then publish, so a resume
   * does not skip a page the final write would otherwise drop.
   */
  async stage(
    stored: readonly Row[],
    state: Record<string, unknown>,
    written: readonly Row[],
  ): Promise<void> {
    const recorded = noteCursor(state, this.cursorField, written);
    this.hold(recorded);
    await this.enqueue(() => this.seal([...stored], recorded));
  }

  /** Seals a checkpoint that is still waiting, then returns the uncheckpointed suffix. */
  async finish(): Promise<Row[]> {
    if (this.staging && this.pending) {
      const state = this.pending;
      this.pending = null;
      const page = this.pageRows.splice(0, this.pageRows.length);
      await this.enqueue(() => this.seal(page, state));
    }

    await this.settle();

    if (!this.staging) return [];

    return this.pageRows.splice(0, this.pageRows.length);
  }

  async stagedRows(): Promise<Row[]> {
    if (!this.staging) return [];

    const rows: Row[] = [];

    for (const page of this.pages) {
      for (const row of await this.adapter.read(page.ref)) rows.push(row);
    }

    return rows;
  }

  stagedPages(): StagedPage[] {
    return this.pages.map((page) => ({ ...page }));
  }

  async stagedPageKeys(): Promise<string[]> {
    return this.pages.map((page) => page.key);
  }

  /** Wait for a page write that is already in flight. Does not publish a checkpoint that has no rows yet. */
  async settle(): Promise<void> {
    await this.sealChain;

    if (this.sealError !== null) {
      const error = this.sealError;
      this.sealError = null;
      throw error;
    }
  }

  /**
   * The watermark an append run commits. The uncheckpointed tail wins when
   * it carries the field, otherwise the checkpoint. No `cursor_from` fallback:
   * an empty delta is the caller's to decide.
   */
  watermark(field: string, tail: readonly Row[] = []): string | null {
    return cursorInRows(tail, field) ?? scalarString(this.currentCheckpoint?.[field]);
  }

  /**
   * An expired page token: delete `page` and let the producer run once more
   * from the watermark still on the checkpoint. `page: null` is a finished
   * walk, so it is left alone. Returns false when this error should propagate.
   */
  async dropExpiredPageToken(error: unknown): Promise<boolean> {
    const state = this.currentCheckpoint;

    if (!state || !("page" in state) || state["page"] === null) return false;
    if (!(await this.recoverExpiredToken(error))) return false;

    const next = { ...state };

    delete next["page"];
    this.pending = null;
    await this.publish(next);

    return true;
  }

  /**
   * One expired token per attempt. Hashes every staged page so a walk that
   * starts over does not append a second copy, and does not have to hold
   * the row bodies.
   */
  async recoverExpiredToken(error: unknown): Promise<boolean> {
    if (this.pageTokenDropped || !this.staging || !isExpiredPageToken(error)) return false;

    this.pageTokenDropped = true;
    await this.noteBoundary();
    return true;
  }

  /**
   * A producer run is starting, including the expired-token re-run.
   * The resume token already stored counts as sealed, so the next attempt
   * cannot overwrite that page with the same cursor and succeed.
   */
  beginWalk(): void {
    this.walkSlots.clear();

    const page = this.currentCheckpoint?.["page"];

    if (page === undefined || page === null) return;

    const key = pageKeyFor([], { page });

    if (this.pages.some((stored) => stored.key === key)) this.walkSlots.add(key);
  }

  resumeCursor(cursorFrom: string | null): string | null {
    if (this.cursorField === undefined) return cursorFrom;

    return this.watermark(this.cursorField) ?? cursorFrom;
  }

  dropBoundary<T extends Row>(rows: readonly T[]): readonly T[] {
    const seen = this.boundary;

    if (!seen || seen.size === 0) return rows;

    return rows.filter((row) => !seen.has(rowHash(row)));
  }

  /** True when the pending checkpoint names the last staged page. */
  private overwritingBoundaryPage(): boolean {
    const state = this.pending;
    const last = this.pages.at(-1);

    if (!state || !last || !this.boundary || this.boundary.size === 0) return false;

    return pageKeyFor([], state) === last.key;
  }

  private async noteBoundary(): Promise<void> {
    const seen = new Set<string>();

    for (const page of this.pages) {
      for (const row of await this.adapter.read(page.ref)) seen.add(rowHash(row));
    }

    this.boundary = seen;
  }

  private hold(state: Record<string, unknown>): void {
    this.currentCheckpoint = { ...state };
  }

  private storedCheckpoint(
    state: Record<string, unknown>,
    pages: readonly StagedPage[] = this.pages,
  ): Record<string, unknown> {
    const visible = stripPages(state) ?? {};
    return this.staging ? { ...visible, [PAGE_LIST]: pages } : visible;
  }

  private async publish(state: Record<string, unknown>): Promise<void> {
    // `emit` is typed `void` so callers may return a number. A worker still
    // returns the broker ack, and `Promise.resolve` waits for that promise.
    // The span is recorded before that wait so a caller that does not await
    // `checkpoint` still sees it beside the event. A fenced ack rejects, and
    // the seal fails before any later storage write.
    // Append `processPages` publishes from `stage` and never calls
    // `ctx.checkpoint`, so the position caps are enforced here too.
    // The page index is this executor's record of stored pages. It is not
    // part of the position those caps measure.
    const visible = stripPages(state) ?? {};
    const stored = this.storedCheckpoint(state);
    assertCheckpoint(visible);
    const ack = this.emitEvent({ event: "checkpoint", state: stored });
    this.spans.event("checkpoint", { keys: Object.keys(visible).length });
    await Promise.resolve(ack);
    this.currentCheckpoint = visible;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.sealChain.then(() => {
      if (this.sealError !== null) return undefined;

      return task();
    });

    this.sealChain = run.then(
      () => undefined,
      (error: unknown) => {
        this.sealError ??= error;
      },
    );

    return run;
  }

  /**
   * Store the page, then publish the checkpoint that names it. The page
   * object is written first, so a crash before the ack retries the same slot.
   * The seal waits for the checkpoint ack and fails when that ack is fenced.
   */
  private async seal(rows: Row[], state: Record<string, unknown>): Promise<void> {
    const output = this.outputRef;

    if (output === null) {
      throw new TerminalError(`${this.assetKey} cannot stage a page without an output ref`);
    }

    const key = pageKeyFor([], state);
    const ref = pageStorageRef(output, key);
    const previous = this.pages;

    if (this.walkSlots.has(key)) {
      throw new TerminalError(`${this.assetKey} page cursor did not advance`);
    }

    const nextPages = upsertPage(this.pages, key, ref);
    const existing = this.pages.find((page) => page.key === key);
    // A restarted walk may seal a token already stored. Keep that page and
    // append only rows it did not already have.
    const writing =
      this.pageTokenDropped && existing ? await mergeSlot(this.adapter, existing.ref, rows) : rows;
    // `publish` checks again, after this write. Reject the producer
    // checkpoint first so an oversized cursor never becomes a page object.
    assertCheckpoint(stripPages(state) ?? {});
    await this.adapter.write(ref, writing);
    this.pages = nextPages;

    try {
      await this.publish(state);
    } catch (error) {
      this.pages = previous;
      throw error;
    }

    this.walkSlots.add(key);
  }
}

function stripPages(state: Record<string, unknown> | null): Record<string, unknown> | null {
  if (state === null || !(PAGE_LIST in state)) return state;

  const copy = { ...state };
  delete copy[PAGE_LIST];
  return copy;
}

function readPageList(state: Record<string, unknown> | null): StagedPage[] {
  const raw = state?.[PAGE_LIST];

  if (!Array.isArray(raw)) return [];

  return raw.filter(isStagedPage);
}

function isStagedPage(value: unknown): value is StagedPage {
  if (typeof value !== "object" || value === null) return false;

  const page = value as { key?: unknown; ref?: unknown };

  return typeof page.key === "string" && isPageKey(page.key) && typeof page.ref === "string";
}

/** The same slot replaces its ref. A new slot appends, so order is the walk. */
function upsertPage(pages: readonly StagedPage[], key: string, ref: string): StagedPage[] {
  const index = pages.findIndex((page) => page.key === key);

  if (index < 0) return [...pages, { key, ref }];

  const next = pages.slice();
  next[index] = { key, ref };
  return next;
}

function rowHash(row: Row): string {
  return createHash("sha256").update(rowKey(row)).digest("hex");
}

function rowKey(row: Row): string {
  return JSON.stringify(sortValue(row));
}

/** Stored rows stay. `incoming` contributes only rows the slot did not have. */
async function mergeSlot(
  adapter: TableStorage,
  ref: string,
  incoming: readonly Row[],
): Promise<Row[]> {
  const prior = await adapter.read(ref);
  const seen = new Set(prior.map((row) => rowHash(row)));
  const extra = incoming.filter((row) => !seen.has(rowHash(row)));

  return extra.length === 0 ? prior : [...prior, ...extra];
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);

  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);

    return sorted;
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function cursorInRows(rows: readonly Row[], field: string): string | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = scalarString(rows[index]?.[field]);

    if (value !== null) return value;
  }

  return null;
}

/** The configured cursor, taken from this page's last row when the row has one. */
function noteCursor(
  state: Record<string, unknown>,
  field: string | undefined,
  rows: readonly Row[],
): Record<string, unknown> {
  if (field === undefined) return state;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = rows[index]?.[field];

    if (scalarString(value) !== null) return { ...state, [field]: value };
  }

  return state;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);

  return null;
}
