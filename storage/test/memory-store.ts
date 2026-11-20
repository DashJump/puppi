import type { ObjectStore } from "../src/index.js";

/** An `ObjectStore` in memory: enough to exercise everything the base computes. */
export class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    const bytes = this.objects.get(key);

    if (!bytes) throw new Error(`nothing at ${key}`);

    return bytes;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }
}
