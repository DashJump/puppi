/**
 * Every `Client` is constructed from the binding's `config` and `secrets`.
 * The client a connection uses is the one its deployment's bundle carries.
 */

import type {
  AdapterClient,
  ObjectStorage,
  RegisteredAdapter,
  StorageAdapter,
  TableStorage,
} from "@puppi/sdk";

import { TerminalError } from "./errors.js";
import type { Binding } from "./protocol.js";

export type { AdapterClient };

/** The `adapters` a collect-mode bundle exports, keyed by connection type. */
export type BundledAdapters = Record<string, RegisteredAdapter>;

/**
 * The adapter for one binding, constructed from its config and secrets.
 * The client is the one this deployment's bundle carries. An unknown type
 * is terminal: no retry will make it appear.
 */
export function construct(
  name: string,
  binding: Binding,
  bundled: BundledAdapters = {},
): AdapterClient {
  const module = bundled[binding.type];

  if (!module) {
    throw new TerminalError(
      `connection ${name} has type "${binding.type}", which this deployment's bundle does not carry. ` +
        `Import the connector in puppi.config.ts and pass it to defineConfig.`,
    );
  }

  return new module.Client(binding.config, binding.secrets);
}

/**
 * Whether an adapter can hold a materialization, asked of the client rather
 * than of a list of type names: a bundled adapter is a storage adapter when
 * it implements the surface the runtime and the shim call. A table store
 * implements `write`, `read`, `query`, and `drop`. An object store implements
 * `put`, `get`, `head`, and `drop`.
 */
export function isStorage(client: AdapterClient): client is StorageAdapter {
  const rows = client as Partial<TableStorage>;
  const files = client as Partial<ObjectStorage>;
  const table =
    typeof rows.write === "function" &&
    typeof rows.read === "function" &&
    typeof rows.query === "function" &&
    typeof rows.drop === "function";
  const file =
    typeof files.put === "function" &&
    typeof files.get === "function" &&
    typeof files.head === "function" &&
    typeof files.drop === "function";

  return table || file;
}
