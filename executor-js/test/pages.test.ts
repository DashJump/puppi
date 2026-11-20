import type { StorageAdapter } from "@puppi/sdk";
import { describe, expect, it } from "vite-plus/test";

import type { ExecutorEvent, ExecutorInput } from "../src/protocol.js";
import { Shim } from "../src/shim/ctx.js";

const input: ExecutorInput = {
  bundle_ref: "/tmp/bundle.js",
  sdk_version: "0.2.0",
  asset_key: "source/things",
  partition: "",
  inputs: {},
  checkpoint: null,
  cursor_from: null,
  bindings: {},
  storage_connection: null,
  output_storage_ref: "test.source_things__attempt",
  connections: {},
};

function shim(
  overrides: Partial<ExecutorInput> = {},
  asset: { mode?: string; cursor?: string } = {},
): {
  ctx: Shim;
  events: ExecutorEvent[];
  writes: string[];
} {
  const events: ExecutorEvent[] = [];
  const writes: string[] = [];
  const adapter = {
    async write(ref: string) {
      writes.push(ref);
    },
  } as unknown as StorageAdapter;
  const ctx = new Shim(
    { ...input, ...overrides },
    adapter,
    "live",
    (event) => events.push(event),
    { get: () => undefined },
    asset,
  );

  return { ctx, events, writes };
}

describe("ctx.processPages", () => {
  it("retries each phase in place and checkpoints only after a durable write", async () => {
    const { ctx, events } = shim();
    let fetchCalls = 0;
    let transformCalls = 0;
    let writeCalls = 0;
    const keys: string[] = [];

    const result = await ctx.processPages({
      fetch: async ({ cursor }) => {
        fetchCalls += 1;
        if (fetchCalls === 1) throw new Error("source timeout");
        return { records: [{ id: 1 }], nextCursor: `${cursor ?? "start"}:next`, done: true };
      },
      transform: async (rows) => {
        transformCalls += 1;
        return rows.map((row) => ({ ...row, transformed: true }));
      },
      write: async (rows, { idempotencyKey }) => {
        writeCalls += 1;
        keys.push(idempotencyKey);
        expect(rows).toEqual([{ id: 1, transformed: true }]);
        if (writeCalls === 1) throw new Error("destination answered 503");
      },
      retry: {
        fetch: { backoffMs: [0] },
        write: { backoffMs: [0] },
      },
    });

    expect(result).toEqual({ pages: 1, records: 1, cursorTo: "start:next" });
    expect(ctx.cursorTo).toBe("start:next");
    expect(fetchCalls).toBe(2);
    expect(transformCalls).toBe(1);
    expect(writeCalls).toBe(2);
    expect(new Set(keys).size).toBe(1);

    const checkpoints = events.filter((event) => event.event === "checkpoint");
    const pageState = { __puppi_process_pages: { cursor: "start:next", page: 1 } };
    expect(checkpoints).toEqual([{ event: "checkpoint", state: pageState }]);
    expect(Buffer.byteLength(JSON.stringify(pageState))).toBeLessThanOrEqual(16 * 1024);
    expect(Buffer.byteLength("start:next")).toBeLessThanOrEqual(4 * 1024);
    expect(events.findIndex((event) => event.event === "checkpoint")).toBeGreaterThan(
      events.findIndex(
        (event) =>
          event.event === "span" &&
          event.name === "write_completed" &&
          event.attributes["attempt"] === 2,
      ),
    );
  });

  it("refuses an append page whose cursor is over 4 KiB before the page is written", async () => {
    const { ctx, writes } = shim({}, { mode: "append", cursor: "created" });

    await expect(
      ctx.processPages({
        fetch: async () => ({
          records: [{ id: 1, created: "1" }],
          nextCursor: "c".repeat(5 * 1024),
          done: true,
        }),
        write: async () => {},
      }),
    ).rejects.toThrow(/a checkpoint is a position, not data/);

    expect(writes).toEqual([]);
  });

  it("refuses a checkpoint that is data, or a cursor over 4 KiB", () => {
    const { ctx } = shim();

    expect(() => ctx.checkpoint({ blob: "x".repeat(17 * 1024) })).toThrow(
      /a checkpoint is a position, not data/,
    );
    expect(() => ctx.checkpoint({ cursor_to: "y".repeat(5 * 1024) })).toThrow(
      /a checkpoint is a position, not data/,
    );
  });

  it("resumes from the last written page", async () => {
    const { ctx } = shim({
      checkpoint: { __puppi_process_pages: { cursor: "page-7", page: 7 } },
    });
    const seen: Array<{ cursor: string | null; page: number; key: string }> = [];

    await ctx.processPages({
      fetch: async ({ cursor, page, idempotencyKey }) => {
        seen.push({ cursor, page, key: idempotencyKey });
        return { records: [], nextCursor: "page-8", done: true };
      },
      write: async () => {},
    });

    expect(seen).toEqual([
      {
        cursor: "page-7",
        page: 7,
        key: "test.source_things__attempt:7",
      },
    ]);
  });

  it("does not retry deterministic transform failures by default", async () => {
    const { ctx, events } = shim();
    let transforms = 0;

    await expect(
      ctx.processPages({
        fetch: async () => ({ records: [{ id: 1 }], nextCursor: "1", done: true }),
        transform: async () => {
          transforms += 1;
          throw new Error("invalid source schema");
        },
        write: async () => {},
      }),
    ).rejects.toThrow("invalid source schema");

    expect(transforms).toBe(1);
    expect(events.some((event) => event.event === "checkpoint")).toBe(false);
  });
});
