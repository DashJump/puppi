/**
 * `puppi try`: load the bundle, build clients, and call `run(ctx)`.
 *
 * It does not decide staleness, the contract, or `latest`. The CLI spawns
 * it with one JSON object on stdin and newline-delimited events on stdout.
 */

import { contentHash, deriveSchema } from "@puppi/adapter-storage";
import type { Row } from "@puppi/sdk";

import { declarationOf, loadRegistry } from "../bundle.js";
import { runChecks } from "../checks.js";
import { AdapterPool } from "../pool.js";
import { produce } from "../produce.js";
import type { CheckResult } from "../protocol.js";
import { CheckShim, Shim } from "../shim/ctx.js";
import { isUnchanged } from "../shim/unchanged.js";
import { serve } from "../stdio.js";
import { evaluateContract } from "./contract.js";
import {
  assertValidLocalInput,
  type LocalEvent,
  type LocalInput,
  type LocalResultEvent,
} from "./protocol.js";
import { NO_OUTPUT_TABLE, noStorage, readOnly } from "./storage.js";

function emit(event: LocalEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runLocal(input: LocalInput): Promise<LocalResultEvent> {
  const registry = await loadRegistry(input.bundle_ref);
  const declaration = declarationOf(registry, input.asset_key);
  const pool = new AdapterPool(input, registry.adapters);
  const adapter = storageFor(input, pool);
  // `live`, not the binding's mode: `emit` has to work for the run to show
  // anything, and it is this adapter, not the mode, that makes a write
  // impossible.
  const shim = new Shim(input, adapter, "live", emit, pool, {
    mode: typeof declaration.config["mode"] === "string" ? declaration.config["mode"] : undefined,
  });

  try {
    try {
      await produce(declaration, shim, adapter);
    } catch (error) {
      // `unchanged()` throws so the rest of `run` does not execute. A local
      // run writes no materialization; report the skip as an empty result.
      if (!isUnchanged(error) && !shim.unchangedSignaled) throw error;
    }

    if (shim.unchangedSignaled) {
      return {
        event: "local_result",
        asset_key: input.asset_key,
        role: declaration.role,
        row_count: 0,
        sample: [],
        observed_schema: [],
        declared_schema: declaration.schema?.columns ?? null,
        contract: evaluateContract(declaration.schema?.columns ?? null, []),
        content_hash: contentHash([]),
        check_results: [],
        checks_error: null,
      };
    }

    const rows = shim.collect();
    const observed = deriveSchema(rows);
    const declared = declaration.schema?.columns ?? null;
    const checked = await check(declaration, rows, adapter);

    return {
      event: "local_result",
      asset_key: input.asset_key,
      role: declaration.role,
      row_count: rows.length,
      sample: rows.slice(0, Math.max(0, input.sample)),
      observed_schema: observed,
      declared_schema: declared,
      contract: evaluateContract(declared, observed),
      content_hash: contentHash(rows),
      ...checked,
    };
  } finally {
    await pool.close();
  }
}

/**
 * The asset's storage, if it has one bound. A source that only reaches an
 * API needs none, and demanding one would put a database back in the way of
 * the question this command exists to answer.
 */
function storageFor(input: LocalInput, pool: AdapterPool): ReturnType<typeof readOnly> {
  const name = input.storage_connection;

  if (name === null) {
    return noStorage(input.asset_key, `${input.asset_key} names no storage connection`);
  }

  if (!input.bindings[name]) {
    return noStorage(input.asset_key, `nothing is bound for "${name}"`);
  }

  return readOnly(() => pool.storage(name));
}

/**
 * Custom checks are user-land TS with no engine dependency, so they run for
 * real; a check that throws is worth finding here. Where the engine fails the
 * attempt on a throw, this reports it and returns — the rows and the contract
 * verdict are what the user ran this for, and losing them to a check that
 * could not reach a verification API would be the wrong trade.
 */
async function check(
  declaration: Parameters<typeof runChecks>[0],
  rows: Row[],
  adapter: ReturnType<typeof readOnly>,
): Promise<{ check_results: CheckResult[]; checks_error: string | null }> {
  try {
    const shim = new CheckShim(rows, NO_OUTPUT_TABLE, adapter, emit);

    return { check_results: await runChecks(declaration, shim), checks_error: null };
  } catch (error) {
    return {
      check_results: [],
      checks_error: error instanceof Error ? error.message : String(error),
    };
  }
}

void serve<LocalEvent>({
  emit,
  noInput: { event: "error", class: "terminal", message: "local harness received no input" },
  run: async (line) => {
    const parsed: unknown = JSON.parse(line);

    assertValidLocalInput(parsed);

    return runLocal(parsed);
  },
  // Nothing retries a local run, so there is no classification to make: the
  // CLI prints the message and exits non-zero.
  onError: (error) => ({
    event: "error",
    class: "terminal",
    message: error instanceof Error ? error.message : String(error),
  }),
});
