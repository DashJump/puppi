/**
 * Batches `ctx.log` lines into one `logs` event.
 *
 * A batch leaves every second, at 100 lines, or at 64 KB, and when the
 * caller flushes before `complete`. A line over 4 KB is cut on a UTF-8
 * boundary and marked `truncated`.
 */

import type { ExecutorEvent, LogEvent, LogLine } from "./protocol.js";

const MAX_LINES = 100;
const MAX_BYTES = 64 * 1024;
const INTERVAL_MS = 1000;
const MAX_LINE_BYTES = 4096;

export interface LogBatch {
  emit(event: ExecutorEvent): Promise<void>;
  flush(): Promise<void>;
}

export function batchLogs(
  send: (event: ExecutorEvent) => void | Promise<void>,
  options: {
    maxLines?: number;
    maxBytes?: number;
    intervalMs?: number;
    maxLineBytes?: number;
    schedule?: (run: () => void, ms: number) => () => void;
  } = {},
): LogBatch {
  const maxLines = options.maxLines ?? MAX_LINES;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  const schedule =
    options.schedule ??
    ((run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });

  const buffer: LogLine[] = [];
  let bytes = 0;
  let cancel: (() => void) | undefined;
  let chain = Promise.resolve();

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const run = chain.then(work, work);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const clearTimer = (): void => {
    cancel?.();
    cancel = undefined;
  };

  const arm = (): void => {
    if (cancel !== undefined || buffer.length === 0) return;

    cancel = schedule(() => {
      void enqueue(flushBuffer);
    }, intervalMs);
  };

  async function flushBuffer(): Promise<void> {
    if (buffer.length === 0) return;

    const lines = buffer.splice(0, buffer.length);
    bytes = 0;
    clearTimer();
    await send({ event: "logs", lines });
  }

  const push = async (event: LogEvent): Promise<void> => {
    const capped = capLine(event.message, maxLineBytes);
    const line: LogLine = { level: event.level, message: capped.message };

    if (capped.truncated) line.truncated = true;

    buffer.push(line);
    bytes += Buffer.byteLength(line.message, "utf8");

    if (buffer.length >= maxLines || bytes >= maxBytes) {
      await flushBuffer();
      return;
    }

    arm();
  };

  return {
    emit(event) {
      return enqueue(async () => {
        if (event.event === "log") {
          await push(event);
          return;
        }

        await flushBuffer();
        await send(event);
      });
    },
    flush() {
      return enqueue(flushBuffer);
    },
  };
}

/** Cuts `message` so the stored bytes end on a UTF-8 character. */
export function capLine(
  message: string,
  max = MAX_LINE_BYTES,
): { message: string; truncated: boolean } {
  const bytes = Buffer.from(message, "utf8");

  if (bytes.length <= max) return { message, truncated: false };

  // `bytes[max]` is the first byte past the cap. A continuation there means
  // the cut split a character, so the slice stops at that character's lead.
  let cut = max;

  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;

  return { message: bytes.subarray(0, cut).toString("utf8"), truncated: true };
}
