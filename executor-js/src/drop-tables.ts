/**
 * Drops storage refs outside an attempt, for the engine's retention and orphan sweeps.
 * The engine sends one JSON command on stdin. This constructs the same storage
 * adapter an attempt would and calls `drop` on each ref. A missing object is
 * success. Secrets stay in the binding.
 */

import { construct } from "./adapters.js";
import { loadRegistry } from "./bundle.js";
import type { Binding } from "./protocol.js";

/** The engine sends at most this many refs in one command. */
export const DROP_BATCH = 32;

export interface DropTablesRequest {
  message: "drop-tables";
  bundle_ref: string;
  connection: string;
  binding: Binding;
  storage_refs: string[];
}

export interface DropFailure {
  storage_ref: string;
  message: string;
}

export interface DroppedReport {
  message: "dropped";
  dropped: string[];
  failed: DropFailure[];
}

export function isDropTables(value: unknown): value is DropTablesRequest {
  if (!value || typeof value !== "object") return false;

  return (value as { message?: unknown }).message === "drop-tables";
}

/** Drops each named ref and leaves its append pages. One failure does not stop the rest. */
export async function runDropTables(request: DropTablesRequest): Promise<DroppedReport> {
  if (!Array.isArray(request.storage_refs) || request.storage_refs.length > DROP_BATCH) {
    throw new Error(`drop-tables accepts at most ${DROP_BATCH} storage refs`);
  }

  const registry = await loadRegistry(request.bundle_ref);
  const adapter = construct(request.connection, request.binding, registry.adapters);
  const drop = (
    adapter as {
      drop?: (storageRef: string, options?: { pages?: boolean }) => Promise<void>;
    }
  ).drop;

  if (typeof drop !== "function") {
    throw new Error(`connection ${request.connection} has no drop`);
  }

  const dropped: string[] = [];
  const failed: DropFailure[] = [];

  try {
    for (const storageRef of request.storage_refs) {
      try {
        await drop.call(adapter, storageRef, { pages: false });
        dropped.push(storageRef);
      } catch (error) {
        failed.push({
          storage_ref: storageRef,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    await adapter.close?.();
  }

  return { message: "dropped", dropped, failed };
}
