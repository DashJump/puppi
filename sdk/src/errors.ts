import { chain, statusOf, text } from "./error-chain.js";

/**
 * The one error class user code shares with the executor.
 *
 * A bundle inlines its own copy of the SDK, so the `TerminalError` a
 * pipeline or a bundled adapter throws is a different class object from the
 * one the executor imported. `instanceof` would say no across that boundary
 * and the attempt would be retried against a definition that can never
 * succeed. The brand is a registered symbol, which is the same value in
 * every copy, so `isTerminal` answers correctly wherever the error was
 * constructed.
 */

const TERMINAL = Symbol.for("puppi.terminal_error");

/** An error the engine must not retry: a bad definition, not a bad moment. */
export class TerminalError extends Error {
  override readonly name = "TerminalError";
  readonly [TERMINAL] = true;
}

/** True for a `TerminalError` from any copy of the SDK, including a bundled one. */
export function isTerminal(error: unknown): boolean {
  return Boolean((error as Record<symbol, unknown> | null)?.[TERMINAL]);
}

/**
 * The symbols `NotFound` and `RateLimitError` brand. Those classes stay with
 * the HTTP client. The symbol is the same value in a bundle's copy, so this
 * module can recognize them without importing the classes.
 */
const NOT_FOUND = Symbol.for("puppi.not_found");
const RATE_LIMIT = Symbol.for("puppi.rate_limit_error");

/** The `UND_ERR_*` pair is undici's body cut short: a dropped socket, or fewer bytes than `content-length`. */
const RETRYABLE_NODE = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
]);

/** Last resort. A settled field skips this; an unrecognized `code` does not. */
const FALLBACK =
  /\b(?:500|502|503|504)\b|etimedout|econnreset|timeout|fetch failed|unreachable|connection terminated|terminating connection/i;

const RATE_MESSAGE = /\b429\b|rate[_\s-]*limit|limit exceeded/i;

/**
 * A failure worth trying again: a rate limit, a 5xx, or the network.
 *
 * Structured fields win, walking `cause`: an allowlisted Node `code`, a
 * Postgres SQLSTATE, or a numeric HTTP `status` (`429`, or `500` and above).
 * `TerminalError` (the shared brand, including a bundled copy) is never
 * transient. A settled status or SQLSTATE on one object wins over a
 * retryable code there. An unrecognized `code` is not a verdict, so the
 * message regex still runs, and only when nothing in the chain settled.
 */
export function isTransient(error: unknown): boolean {
  const nodes = chain(error);

  if (nodes.some((node) => isTerminal(node) || isNotFound(node))) return false;
  if (nodes.some((node) => isRateLimit(node))) return true;

  let structured = false;

  for (const node of nodes) {
    const verdict = fieldsOf(node);

    if (verdict === "retry") return true;
    if (verdict === "settled") structured = true;
  }

  if (structured) return false;

  return nodes.some((node) => FALLBACK.test(text(node)) || RATE_MESSAGE.test(text(node)));
}

function branded(error: unknown, brand: symbol): boolean {
  return Boolean(error && typeof error === "object" && (error as Record<symbol, unknown>)[brand]);
}

function isNotFound(error: unknown): boolean {
  return branded(error, NOT_FOUND);
}

function isRateLimit(error: unknown): boolean {
  return branded(error, RATE_LIMIT);
}

/**
 * One object's fields. A settled status or SQLSTATE wins over a retryable
 * code on that same object. An unrecognized `code` is not a verdict.
 */
function fieldsOf(error: unknown): "retry" | "settled" | "none" {
  const code = verdictForCode(codeOf(error));
  const status = verdictForStatus(statusOf(error));

  if (code === "settled" || status === "settled") return "settled";
  if (code === "retry" || status === "retry") return "retry";

  return "none";
}

function verdictForCode(code: string | null): "retry" | "settled" | "none" {
  if (code === null) return "none";
  if (RETRYABLE_NODE.has(code)) return "retry";
  if (!sqlState(code)) return "none";

  return retryableSqlState(code) ? "retry" : "settled";
}

function verdictForStatus(status: number | null): "retry" | "settled" | "none" {
  if (status === null) return "none";

  return retryableStatus(status) ? "retry" : "settled";
}

function sqlState(code: string): boolean {
  return /^[0-9A-Z]{5}$/.test(code);
}

/** Class 08, admin shutdown, serialization failure, deadlock. */
function retryableSqlState(code: string): boolean {
  return (
    code.startsWith("08") ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    code === "40001" ||
    code === "40P01"
  );
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function codeOf(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;

  const code = (error as { code?: unknown }).code;

  return typeof code === "string" && code !== "" ? code : null;
}
