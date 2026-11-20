/**
 * Reloads the SDK so the next case starts with an empty registry.
 * Collect mode keeps declarations for the life of the module that registered them.
 */

import * as Sdk from "@puppi/sdk";
import { vi } from "vitest";

let current: typeof Sdk = Sdk;

export async function reset(): Promise<void> {
  vi.resetModules();
  current = await import("@puppi/sdk");
}

export const sdk = {
  get adapter() {
    return current.adapter;
  },
  get collect() {
    return current.collect;
  },
  get destination() {
    return current.destination;
  },
  get group() {
    return current.group;
  },
  get model() {
    return current.model;
  },
  get register() {
    return current.register;
  },
  get source() {
    return current.source;
  },
};
