/**
 * Telemetry over the protocol's `span` event. The shim reports what it did
 * with `source: "shim"`; user code reports through `ctx.telemetry` with
 * `source: "user"`, and the engine keeps the two apart so user spans never
 * touch engine timings. The attempt is known from the process, so nothing
 * here carries an id.
 */

import type { Telemetry, TelemetryAttributes } from "@puppi/sdk";

import { TerminalError } from "./errors.js";
import type { SpanEvent } from "./protocol.js";

export class TelemetryShim implements Telemetry {
  constructor(
    private readonly emitEvent: (event: SpanEvent) => void,
    private readonly source: SpanEvent["source"],
  ) {}

  async span<T>(
    name: string,
    fn: () => T | Promise<T>,
    attributes: TelemetryAttributes = {},
  ): Promise<T> {
    validate(name, attributes);
    const started = performance.now();

    try {
      const value = await fn();
      this.report("span", name, performance.now() - started, attributes);
      return value;
    } catch (error) {
      this.report("span", name, performance.now() - started, { ...attributes, error: true });
      throw error;
    }
  }

  event(name: string, attributes: TelemetryAttributes = {}): void {
    validate(name, attributes);
    this.report("event", name, null, attributes);
  }

  gauge(name: string, value: number, attributes: TelemetryAttributes = {}): void {
    validate(name, { ...attributes, value });
    this.report("gauge", name, null, { ...attributes, value });
  }

  private report(
    kind: SpanEvent["kind"],
    name: string,
    duration_ms: number | null,
    attributes: TelemetryAttributes,
  ): void {
    this.emitEvent({ event: "span", name, source: this.source, kind, duration_ms, attributes });
  }
}

/**
 * Scalars only, and a name to file them under. An object is rejected here so
 * nobody can push a row set through telemetry; a non-finite number has no
 * JSON form.
 */
function validate(name: string, attributes: TelemetryAttributes): void {
  if (typeof name !== "string" || name === "") {
    throw new TerminalError("telemetry needs a non-empty name");
  }

  for (const [key, value] of Object.entries(attributes)) {
    const ok =
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value));

    if (!ok) {
      throw new TerminalError(
        `telemetry attribute ${key} on ${name} must be a string, a finite number, ` +
          `a boolean or null; got ${describe(value)}`,
      );
    }
  }
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value;
}
