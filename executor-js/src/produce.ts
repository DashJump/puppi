/**
 * Invoking the producer: the half of an attempt that is user code. The
 * engine's runtime and the local harness (`local/`) both go through here, so
 * "what running this asset means" is decided once — a `run` is called, a
 * destination re-emits its one upstream, and anything else is a declaration
 * with nothing to invoke.
 */

import type { Declaration, StorageAdapter, TableStorage } from "@puppi/sdk";

import { TerminalError } from "./errors.js";
import type { Shim } from "./shim/ctx.js";

export async function produce(
  declaration: Declaration,
  shim: Shim,
  adapter: StorageAdapter,
): Promise<void> {
  if (declaration.run) {
    shim.beginWalk();
    return declaration.run(shim);
  }
  if (declaration.role === "destination") return deliver(declaration, shim, adapter);

  throw new TerminalError(
    declaration.sql
      ? `${declaration.key} is a sql model; sql models are not supported`
      : `${declaration.key} has no producer to invoke`,
  );
}

/** A destination has no `run`: it re-emits its one upstream, so it gets a materialization of its own. */
async function deliver(
  declaration: Declaration,
  shim: Shim,
  adapter: StorageAdapter,
): Promise<void> {
  const from = declaration.config["from"];

  if (typeof from !== "string") {
    throw new TerminalError(`destination ${declaration.key} declares no "from"`);
  }

  await shim.emit(await (adapter as TableStorage).read(shim.input(from)));
}
