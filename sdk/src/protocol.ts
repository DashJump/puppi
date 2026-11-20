/**
 * Attempt and local-run shapes shared by the CLI and `@puppi/executor-js`.
 * Events and validation stay with the executor; this file is types only.
 */

import type { Row } from "./types.js";

export interface InputRef {
  materialization_id: string;
  storage_ref: string;
  /** Set when this upstream materialization is one object. */
  file?: boolean;
  sha256?: string | null;
  bytes?: number | null;
  content_type?: string | null;
  meta?: Record<string, unknown>;
  /** The connection that holds the object. Present on a file input. */
  storage_connection?: string | null;
}

/** How an asset uses a connection. `unknown` is a reach whose method has no annotation. */
export type ConnectionDirection = "read" | "write" | "read_write" | "unknown";

export interface Binding {
  /** The manifest's adapter id for this connection; the registry maps it to `@puppi/adapter-<type>`. */
  type: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  mode: "live" | "read_only" | "replay_raw";
}

/**
 * This asset's current latest materialization. A table's `ctx.latest` is
 * `storage_ref`. A file's also carries `file` and the object fields.
 */
export interface LatestInput {
  materialization_id: string;
  storage_ref: string;
  file?: boolean;
  sha256?: string | null;
  bytes?: number | null;
  content_type?: string | null;
  meta?: Record<string, unknown>;
}

export interface Attempt {
  asset_key: string;
  partition: string;
  inputs: Record<string, InputRef>;
  checkpoint: Record<string, unknown> | null;
  cursor_from: string | null;
  /**
   * This asset's current latest, or null on the first run. The engine always
   * sends it. A local run omits it: a local run writes no materialization.
   */
  latest?: LatestInput | null;
  bindings: Record<string, Binding>;
  /** The binding this asset writes through, or null. */
  storage_connection: string | null;
  /**
   * Connection name -> the direction the manifest recorded. The engine always
   * sends the map. A write against a missing name warns.
   */
  connections: Record<string, ConnectionDirection>;
}

export interface Column {
  name: string;
  type: string;
}

export interface CheckResult {
  kind: "custom";
  name: string;
  severity: "warn" | "block";
  result: "pass" | "fail";
  detail?: string | null;
}

/** One producer run in this process. Inputs are materializations, or none. */
export interface LocalInput extends Attempt {
  bundle_ref: string;
  /** How many emitted rows to carry back for display. The producer is not limited. */
  sample: number;
}

/**
 * The declared/observed comparison, made here rather than by the engine so a
 * local run reports the verdict a deploy would. `undeclared` is not a
 * failure: an asset without a schema has no contract to check.
 */
export interface ContractVerdict {
  result: "pass" | "fail" | "undeclared";
  detail: string;
}

export interface LocalResultEvent {
  event: "local_result";
  asset_key: string;
  role: string;
  row_count: number;
  /** At most `sample` of the emitted rows, in emit order. */
  sample: Row[];
  observed_schema: Column[];
  declared_schema: Column[] | null;
  contract: ContractVerdict;
  /** The same digest a storage adapter would record, which is what decides a skip. */
  content_hash: string;
  check_results: CheckResult[];
  /**
   * A custom check that threw. The engine fails the attempt on one; a local
   * run reports it and still shows the rows, because the rows are what the
   * user ran this for.
   */
  checks_error: string | null;
}
