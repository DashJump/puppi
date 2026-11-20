import { TerminalError } from "../errors.js";

/** A checkpoint is a position. These are the same caps the engine enforces on ingest. */
const CHECKPOINT_BYTES = 16 * 1024;
const CURSOR_BYTES = 4 * 1024;
const MESSAGE = "a checkpoint is a position, not data";
const CURSOR_KEYS = new Set(["cursor", "cursor_to"]);

export function assertCheckpoint(state: Record<string, unknown>): void {
  if (Buffer.byteLength(JSON.stringify(state)) > CHECKPOINT_BYTES || cursorTooBig(state)) {
    throw new TerminalError(MESSAGE);
  }
}

export function assertCursor(cursor: string | null): void {
  if (cursor !== null && Buffer.byteLength(cursor) > CURSOR_BYTES) {
    throw new TerminalError(MESSAGE);
  }
}

function cursorTooBig(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => cursorTooBig(item));

  if (typeof value !== "object" || value === null) return false;

  return Object.entries(value).some(([key, item]) => {
    if (CURSOR_KEYS.has(key) && typeof item === "string") {
      return Buffer.byteLength(item) > CURSOR_BYTES;
    }

    return cursorTooBig(item);
  });
}
