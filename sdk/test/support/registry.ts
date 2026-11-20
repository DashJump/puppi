/**
 * Reloads the SDK so the next case starts with an empty registry.
 * Collect mode keeps declarations for the life of the module that registered them.
 */

import { vi } from "vitest";

import * as Sdk from "../../src/index.js";

let current: typeof Sdk = Sdk;

export async function reset(): Promise<void> {
  vi.resetModules();
  current = await import("../../src/index.js");
}

export const sdk = {
  get adapter() {
    return current.adapter;
  },
  get collect() {
    return current.collect;
  },
  get defineConfig() {
    return current.defineConfig;
  },
  get destination() {
    return current.destination;
  },
  get group() {
    return current.group;
  },
  get isTerminal() {
    return current.isTerminal;
  },
  get model() {
    return current.model;
  },
  get source() {
    return current.source;
  },
  get TerminalError() {
    return current.TerminalError;
  },
};
