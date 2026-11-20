/**
 * One adapter per bound connection, constructed on first use and closed
 * together when the attempt ends. Construction is here rather than in the
 * shim so the shim stays the trusted, adapter-agnostic surface user code
 * sees, and here rather than in `runtime.ts` so the local harness
 * (`local/`) builds its clients the same way an attempt does.
 */

import type { StorageAdapter } from "@puppi/sdk";

import { type AdapterClient, type BundledAdapters, construct, isStorage } from "./adapters.js";
import { TerminalError } from "./errors.js";
import type { Attempt } from "./protocol.js";

export class AdapterPool {
  private readonly clients = new Map<string, AdapterClient>();

  constructor(
    private readonly attempt: Attempt,
    /** The connection types this deployment's bundle brought with it. */
    private readonly bundled: BundledAdapters,
  ) {}

  get(name: string): AdapterClient {
    const existing = this.clients.get(name);

    if (existing) return existing;

    const binding = this.attempt.bindings[name];

    if (!binding) throw new TerminalError(`no binding named ${name} was resolved for this attempt`);

    const client = construct(name, binding, this.bundled);
    this.clients.set(name, client);

    return client;
  }

  /** The named storage binding, refused if its adapter cannot hold a materialization. */
  storage(name: string): StorageAdapter {
    const binding = this.attempt.bindings[name]!;
    const client = this.get(name);

    if (isStorage(client)) return client;

    throw new TerminalError(
      `${this.attempt.asset_key} stores through ${name}, a ${binding.type} connection, whose ` +
        `adapter cannot hold a materialization: a storage adapter implements write, read, ` +
        `query, and drop, or put, get, head, and drop.`,
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map(async (client) => client.close?.()));
  }
}
