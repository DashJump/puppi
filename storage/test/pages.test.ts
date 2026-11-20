import { describe, expect, it } from "vite-plus/test";

import { ObjectStorageAdapter, pageIndexRef, pageKeyFor, pageStorageRef } from "../src/index.js";
import { MemoryStore } from "./memory-store.js";

describe("an append page key", () => {
  it("distinguishes date and bigint resume tokens", () => {
    const january = new Date("2020-01-01T00:00:00.000Z");
    const june = new Date("2020-06-01T00:00:00.000Z");

    expect(pageKeyFor([], { watermark: january })).not.toBe(pageKeyFor([], { watermark: june }));
    expect(pageKeyFor([], { watermark: 1n })).not.toBe(pageKeyFor([], { watermark: 2n }));
    expect(pageKeyFor([], { page: january })).not.toBe(pageKeyFor([], { page: june }));
  });

  it("stays unique well past a 32-bit birthday collision", () => {
    const keys = new Set<string>();

    for (let index = 0; index < 77_000; index += 1) keys.add(pageKeyFor([], { page: index }));

    expect(keys.size).toBe(77_000);
    expect([...keys][0]).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("a long sibling name", () => {
  it("hashes the name instead of throwing, and drop still removes it", async () => {
    const storageRef = `prod.${"asset".repeat(12)}`;
    const key = pageKeyFor([], { page: "p2" });
    const sibling = pageStorageRef(storageRef, key);

    expect(sibling).toBe(pageStorageRef(storageRef, key));
    expect(Buffer.byteLength(sibling.split(".")[1] ?? "")).toBeLessThanOrEqual(63);
    expect(sibling).not.toBe(pageStorageRef(storageRef, pageKeyFor([], { page: "p3" })));
    expect(pageStorageRef("prod.a__1", key)).toBe(`prod.a__1__page_${key}`);

    const adapter = new ObjectStorageAdapter(new MemoryStore(), "memory");

    await adapter.write(sibling, [{ id: 1 }]);
    await adapter.write(pageIndexRef(storageRef), [{ keys: key }]);
    await adapter.drop(storageRef);

    await expect(adapter.read(sibling)).rejects.toThrow(/nothing at/);
  });
});
