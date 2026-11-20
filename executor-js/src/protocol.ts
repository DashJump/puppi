/**
 * The executor protocol, v2. `executor-js/test/protocol/executor-v2.schema.json`
 * is the contract: one lease on the way in, sequenced `event` envelopes and one
 * `complete` on the way out. The child that runs the attempt owns `seq`.
 */

import type { LogLevel, TelemetryAttributes } from "@puppi/sdk";
import type { Attempt, Binding, CheckResult, Column } from "@puppi/sdk/protocol";

export type { Attempt, Binding, CheckResult, Column };

export interface ExecutorInput extends Attempt {
  bundle_ref: string;
  sdk_version: string;
  output_storage_ref: string;
}

export interface Execution {
  attempt_id: string;
  run_id: string;
  fence: number;
  runtime_profile: string;
  bundle_digest: string | null;
  output_materialization_id: string;
  lease_expires_at: string | null;
  deadline_at: string | null;
}

export interface Lease {
  message: "lease";
  execution: Execution;
  input: ExecutorInput;
}

export type LogEvent = { event: "log"; level: LogLevel; message: string };

/** A line in a `logs` batch. `truncated` is set when the line was cut at 4 KB. */
export interface LogLine {
  level: LogLevel;
  message: string;
  truncated?: boolean;
}

/** One event carries a batch of `ctx.log` lines and advances the attempt's sequence by one. */
export interface LogsEvent {
  event: "logs";
  lines: LogLine[];
}
export type CheckpointEvent = { event: "checkpoint"; state: Record<string, unknown> };
export type ReadEvent = { event: "read"; asset_key: string };

/**
 * Telemetry crossing the protocol: the shim's own instrumentation
 * (`source: "shim"`) and what user code reports through `ctx.telemetry`
 * (`source: "user"`). The engine attaches the run and attempt ids.
 */
export interface SpanEvent {
  event: "span";
  name: string;
  source: "shim" | "user";
  /** `span` is timed; `event` is a point in time; `gauge` carries `attributes.value`. */
  kind: "span" | "event" | "gauge";
  duration_ms: number | null;
  attributes: TelemetryAttributes;
}

export interface ResultEvent {
  event: "result";
  storage_ref: string;
  observed_schema: Column[];
  stats: {
    row_count: number;
    bytes: number | null;
    /** Adapter-chosen digest of what was written; the engine only compares two for equality. */
    content_hash?: string | null;
    /** Set when the materialization is one object. */
    content_type?: string | null;
    meta?: Record<string, unknown>;
  };
  cursor_to: string | null;
  check_results: CheckResult[];
  checkpoint: Record<string, unknown> | null;
  /**
   * The producer called `ctx.unchanged()`. The engine skips, the same way it
   * skips a matching content hash. Omitted when the producer did not call it.
   */
  unchanged?: boolean;
}

export interface ErrorEvent {
  event: "error";
  /** The one classification the engine acts on: retry, or fail the attempt now. */
  class: "retryable" | "terminal";
  message: string;
  /**
   * Milliseconds the server asked us to wait, from `Retry-After`. Present
   * only on a rate limit that carried one. The engine delays the retry by
   * this long; it does not sleep inside the attempt.
   */
  retry_after_ms?: number;
}

export type ExecutorEvent =
  | LogEvent
  | LogsEvent
  | CheckpointEvent
  | ReadEvent
  | SpanEvent
  | ResultEvent
  | ErrorEvent;

export interface EventEnvelope {
  message: "event";
  attempt_id: string;
  fence: number;
  seq: number;
  event: ExecutorEvent;
}

export interface CompleteEnvelope {
  message: "complete";
  attempt_id: string;
  fence: number;
  last_seq: number;
  result: ExecutorEvent;
}

export type OutboundEnvelope = EventEnvelope | CompleteEnvelope;

export interface AttemptSpeaker {
  event(event: ExecutorEvent): EventEnvelope;
  complete(result: ExecutorEvent): CompleteEnvelope;
}

/**
 * Sequence numbers for one attempt. The process that runs the attempt calls
 * this; a parent that only forwards stdout does not.
 */
export function speak(execution: { attempt_id: string; fence: number }): AttemptSpeaker {
  let seq = 0;

  return {
    event(event) {
      seq += 1;

      return {
        message: "event",
        attempt_id: execution.attempt_id,
        fence: execution.fence,
        seq,
        event,
      };
    },
    complete(result) {
      return {
        message: "complete",
        attempt_id: execution.attempt_id,
        fence: execution.fence,
        last_seq: seq,
        result,
      };
    },
  };
}

/** A terminal envelope for a process that never received a lease. */
export function orphanComplete(message: string): CompleteEnvelope {
  return speak({ attempt_id: "unknown", fence: 1 }).complete({
    event: "error",
    class: "terminal",
    message,
  });
}

/** Fails fast on a lease the child cannot run. The schema is the full contract. */
export function assertValidLease(value: unknown): asserts value is Lease {
  if (typeof value !== "object" || value === null) {
    throw new Error("executor lease must be a JSON object");
  }

  const lease = value as Record<string, unknown>;

  if (lease["message"] !== "lease") {
    throw new Error("executor input must be a V2 lease");
  }

  const execution = lease["execution"];

  if (typeof execution !== "object" || execution === null) {
    throw new Error("executor lease is missing execution");
  }

  const fields = execution as Record<string, unknown>;

  if (typeof fields["attempt_id"] !== "string" || fields["attempt_id"] === "") {
    throw new Error("executor lease is missing attempt_id");
  }

  if (
    typeof fields["fence"] !== "number" ||
    !Number.isInteger(fields["fence"]) ||
    fields["fence"] < 1
  ) {
    throw new Error("executor lease is missing fence");
  }

  assertValidInput(lease["input"]);
}

/** Fails fast on an input missing the fields the shim reads. */
export function assertValidInput(value: unknown): asserts value is ExecutorInput {
  if (typeof value !== "object" || value === null) {
    throw new Error("executor input must be a JSON object");
  }

  requireFields(value as Record<string, unknown>, "executor input", {
    strings: ["bundle_ref", "sdk_version", "asset_key", "output_storage_ref"],
    objects: ["inputs", "bindings"],
  });
}

/**
 * The fields an input must carry to be worth acting on, whatever else it
 * carries. Shared with the local harness's own `assertValidLocalInput`: the
 * two inputs differ in what they require, not in what "missing" means.
 */
export function requireFields(
  input: Record<string, unknown>,
  what: string,
  fields: { strings: readonly string[]; objects: readonly string[] },
): void {
  for (const field of fields.strings) {
    if (typeof input[field] !== "string" || input[field] === "") {
      throw new Error(`${what} is missing ${field}`);
    }
  }

  for (const field of fields.objects) {
    if (typeof input[field] !== "object" || input[field] === null) {
      throw new Error(`${what} is missing ${field}`);
    }
  }
}

/** Identity already present on a document, so a rejected lease can still be completed. */
export function peekExecution(value: unknown): { attempt_id: string; fence: number } | null {
  if (typeof value !== "object" || value === null) return null;

  const execution = (value as Record<string, unknown>)["execution"];
  if (typeof execution !== "object" || execution === null) return null;

  const fields = execution as Record<string, unknown>;
  const attemptId = fields["attempt_id"];
  const fence = fields["fence"];

  if (typeof attemptId !== "string" || attemptId === "") return null;
  if (typeof fence !== "number" || !Number.isInteger(fence) || fence < 1) return null;

  return { attempt_id: attemptId, fence };
}
