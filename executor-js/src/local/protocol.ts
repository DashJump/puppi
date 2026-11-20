/**
 * The local harness protocol. A local run has no run id, materialization, or output ref.
 *
 * `log`, `checkpoint`, `read`, and `span` match the executor events. The terminal event does not.
 */

import type { ContractVerdict, LocalInput, LocalResultEvent } from "@puppi/sdk/protocol";

import { requireFields } from "../protocol.js";
import type { ExecutorEvent } from "../protocol.js";

export type { ContractVerdict, LocalInput, LocalResultEvent };

export type LocalEvent = ExecutorEvent | LocalResultEvent;

export function assertValidLocalInput(value: unknown): asserts value is LocalInput {
  if (typeof value !== "object" || value === null) {
    throw new Error("local input must be a JSON object");
  }

  const input = value as Record<string, unknown>;

  requireFields(input, "local input", {
    strings: ["bundle_ref", "asset_key"],
    objects: ["inputs", "bindings"],
  });
}
