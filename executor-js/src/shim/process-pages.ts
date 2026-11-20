import { isTransient } from "@puppi/sdk";
import type {
  FetchedPage,
  PageContext,
  PagePhase,
  PageRetryPolicy,
  ProcessPagesOptions,
  ProcessPagesResult,
  Row,
} from "@puppi/sdk";

import { isTerminal, TerminalError } from "../errors.js";
import type { Attempt } from "../protocol.js";
import type { TelemetryShim } from "../telemetry.js";
import type { Pages } from "./pages.js";

/** The `ctx.processPages` walk for one attempt. */
export class ProcessPages {
  private completedCursor: string | null = null;

  constructor(
    private readonly pages: Pages,
    private readonly attempt: Attempt & { output_storage_ref?: string },
    private readonly cursorFrom: string | null,
    private readonly spans: TelemetryShim,
    private readonly checkpoint: (state: Record<string, unknown>) => void,
    private readonly markEmitted: () => void,
  ) {}

  /** The last cursor whose page write completed during this attempt. */
  get cursorTo(): string | null {
    return this.completedCursor;
  }

  async run<Fetched extends Row, Written extends Row = Fetched>(
    options: ProcessPagesOptions<Fetched, Written>,
  ): Promise<ProcessPagesResult> {
    let { cursor, page } = pageStart(this.pages.state, this.cursorFrom);
    let pages = 0;
    let records = 0;
    while (true) {
      const idempotencyKey = `${executionKey(this.attempt)}:${page}`;
      const context = { cursor, page, idempotencyKey };

      let fetched: FetchedPage<Fetched>;

      try {
        fetched = await this.runPagePhase(
          "fetch",
          () => options.fetch(context),
          options.retry?.fetch,
          context,
        );
      } catch (error) {
        // Same recovery as a thrown `produce`: once, from the watermark.
        // The page index stays, so page 0 is not fetched again.
        if (context.cursor === null || !(await this.pages.recoverExpiredToken(error))) throw error;

        cursor = this.pages.resumeCursor(this.cursorFrom);
        continue;
      }

      const written = await this.transformPage(options, fetched.records, context);
      const stored = this.pages.dropBoundary(written);

      await this.runPagePhase(
        "write",
        () => options.write(stored, context),
        options.retry?.write,
        context,
      );

      pages += 1;
      records += stored.length;
      if (stored.length > 0) this.markEmitted();
      this.completedCursor = fetched.nextCursor;
      const state = pageState(this.pages.state, fetched.nextCursor, page + 1);

      if (this.pages.staging) {
        await this.pages.stage(stored, state, written);
      } else {
        this.checkpoint(state);
      }

      if (fetched.done) return { pages, records, cursorTo: fetched.nextCursor };

      cursor = nextCursor(this.attempt.asset_key, fetched, context);
      page += 1;
    }
  }

  private async transformPage<Fetched extends Row, Written extends Row>(
    options: ProcessPagesOptions<Fetched, Written>,
    records: readonly Fetched[],
    context: PageContext,
  ): Promise<Written[]> {
    if (!options.transform) return records as unknown as Written[];

    return this.runPagePhase(
      "transform",
      () => options.transform!(records, context),
      options.retry?.transform,
      context,
    );
  }

  private async runPagePhase<T>(
    phase: PagePhase,
    fn: () => T | Promise<T>,
    policy: PageRetryPolicy | undefined,
    context: PageContext,
  ): Promise<T> {
    const resolved = pageRetryPolicy(phase, policy);

    for (let attempt = 1; ; attempt++) {
      this.spans.event(`${phase}_started`, { page: context.page, attempt });

      try {
        const result = await this.spans.span(`page_${phase}`, fn, { page: context.page, attempt });
        this.spans.event(`${phase}_completed`, { page: context.page, attempt });
        return result;
      } catch (error) {
        if (!mayRetry(error, attempt, resolved)) throw error;

        const delay = retryDelay(resolved.backoff, attempt);
        this.spans.event(`${phase}_retrying`, { page: context.page, attempt, delay_ms: delay });
        await wait(delay);
      }
    }
  }
}

interface PageCheckpoint {
  cursor: string | null;
  page: number;
}

interface ResolvedPageRetryPolicy {
  attempts: number;
  backoff: readonly number[];
  retry: (error: unknown) => boolean;
}

const PAGE_CHECKPOINT = "__puppi_process_pages";

function pageCheckpoint(state: Record<string, unknown> | null): PageCheckpoint | null {
  const value = state?.[PAGE_CHECKPOINT];

  if (typeof value !== "object" || value === null) return null;

  const checkpoint = value as Record<string, unknown>;
  const cursor = checkpoint["cursor"];
  const page = checkpoint["page"];

  if (
    (typeof cursor !== "string" && cursor !== null) ||
    !Number.isInteger(page) ||
    Number(page) < 0
  )
    return null;

  return { cursor, page: Number(page) };
}

function pageStart(
  state: Record<string, unknown> | null,
  cursorFrom: string | null,
): PageCheckpoint {
  return pageCheckpoint(state) ?? { cursor: cursorFrom, page: 0 };
}

function pageState(
  current: Record<string, unknown> | null,
  cursor: string | null,
  page: number,
): Record<string, unknown> {
  return { ...current, [PAGE_CHECKPOINT]: { cursor, page } };
}

function executionKey(attempt: Attempt & { output_storage_ref?: string }): string {
  return attempt.output_storage_ref ?? `${attempt.asset_key}:${attempt.partition}`;
}

function nextCursor<T extends Row>(
  assetKey: string,
  fetched: FetchedPage<T>,
  context: PageContext,
): string | null {
  if (fetched.nextCursor !== context.cursor) return fetched.nextCursor;
  throw new TerminalError(`${assetKey} page ${context.page} did not advance its cursor`);
}

function pageRetryPolicy(
  phase: PagePhase,
  policy: PageRetryPolicy | undefined,
): ResolvedPageRetryPolicy {
  return {
    attempts: Math.max(1, policy?.attempts ?? (phase === "transform" ? 1 : 3)),
    backoff: policy?.backoffMs ?? [250, 1_000],
    retry: policy?.retry ?? ((error: unknown) => !isTerminal(error) && isTransient(error)),
  };
}

function mayRetry(error: unknown, attempt: number, policy: ResolvedPageRetryPolicy): boolean {
  return attempt < policy.attempts && policy.retry(error);
}

function retryDelay(backoff: readonly number[], attempt: number): number {
  return backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 0;
}

async function wait(delay: number): Promise<void> {
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}
