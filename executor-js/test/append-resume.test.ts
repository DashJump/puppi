import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client as Filesystem } from "@puppi/adapter-filesystem";
import type { Row, StorageAdapter, TableStorage } from "@puppi/sdk";
import { afterEach, describe, expect, it } from "vitest";

import { execute, type SettleAttempt } from "../src/execute.js";
import type { ExecutorEvent, ExecutorInput } from "../src/protocol.js";
import { Shim } from "../src/shim/ctx.js";
import { PAGE_LIST } from "../src/shim/pages.js";
import { bundleCarryingStorage } from "./support/storage-adapters.js";

/**
 * An append source keeps every row once across a mid-walk failure, for both
 * a checkpoint-then-emit walk and `ctx.processPages`. A successful run
 * commits the watermark as `cursor_to`.
 */

const PAGES = [
  {
    next: "p2",
    data: [
      { id: 1, created: 10 },
      { id: 2, created: 20 },
    ],
  },
  {
    next: "p3",
    data: [
      { id: 3, created: 30 },
      { id: 4, created: 40 },
    ],
  },
  { next: null, data: [{ id: 5, created: 50 }] },
] as const;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("an append source that checkpoints", () => {
  it("keeps every emitted row once after a mid-walk failure and commits the watermark", async () => {
    const { root, control, bundle } = emitScenario();
    const ref = "run.things__attempt";

    writeFileSync(control, JSON.stringify({ failAfter: "p2" }));
    const first = await attempt(bundle, root, ref, null);
    expect(first.error?.message).toMatch(/429/);

    writeFileSync(control, JSON.stringify({ failAfter: null }));
    const second = await attempt(bundle, root, ref, first.checkpoint);

    expect(second.error).toBeUndefined();
    expect(first.checkpoint).toMatchObject({ created: 20, page: "p2" });
    expect(first.checkpoint?.[PAGE_LIST]).toEqual([
      expect.objectContaining({ key: expect.stringMatching(/^[0-9a-f]{32}$/) }),
    ]);
    await expectCommitted(root, ref, second.result, { cursor_to: "50", ids: [1, 2, 3, 4, 5] });
  });

  it("does not append a second copy when the failure is after the last page was stored", async () => {
    const { root, control, bundle } = emitScenario();
    const ref = "run.things__tail";

    writeFileSync(control, JSON.stringify({ failAtEnd: true }));
    const first = await attempt(bundle, root, ref, null);
    expect(first.error?.message).toMatch(/terminal/);

    writeFileSync(control, JSON.stringify({ failAtEnd: false }));
    const second = await attempt(bundle, root, ref, first.checkpoint);

    expect(second.error).toBeUndefined();
    await expectCommitted(root, ref, second.result, { cursor_to: "50", ids: [1, 2, 3, 4, 5] });
  });

  it("keeps the watermark when the next run has nothing newer than cursor_from", async () => {
    const { root, control, bundle } = emitScenario();

    writeFileSync(control, JSON.stringify({}));
    const first = await attempt(bundle, root, "run.things__delta", null);
    expect(first.result?.cursor_to).toBe("50");

    const second = await attempt(
      bundle,
      root,
      "run.things__next",
      null,
      first.result?.cursor_to ?? null,
    );

    expect(second.error).toBeUndefined();
    await expectCommitted(root, "run.things__next", second.result, { cursor_to: "50", ids: [] });
  });

  it("does not drop committed rows when another execution runs", async () => {
    const root = directory();
    const runs = join(root, "runs.txt");
    writeFileSync(runs, "0");
    const bundle = writeBundle(
      root,
      asset(`async (ctx) => {
        const { readFileSync, writeFileSync } = await import("node:fs");
        const next = Number(readFileSync(${JSON.stringify(runs)}, "utf8")) + 1;
        writeFileSync(${JSON.stringify(runs)}, String(next));
        const created = next === 1 ? 20 : 50;
        ctx.checkpoint({ created, page: "p" + next });
        await ctx.emit([{ id: next, created }]);
      }`),
      "retry.mjs",
    );
    const firstRef = "run.things__e1";
    const first = await attempt(bundle, root, firstRef, null, null, async () => "recorded");

    expect(first.error).toBeUndefined();
    expect(first.result?.cursor_to).toBe("20");

    const secondRef = "run.things__e2";
    const second = await attempt(bundle, root, secondRef, null);

    expect(second.error).toBeUndefined();
    expect({
      first: (await readIds(root, firstRef)).map((row) => row["id"]),
      second: (await readIds(root, secondRef)).map((row) => row["id"]),
      runs: readFileSync(runs, "utf8"),
    }).toEqual({ first: [1], second: [2], runs: "2" });
  });

  it("rebuilds staged pages into a new ref when the producer emits nothing", async () => {
    const root = directory();
    const bundle = writeBundle(
      root,
      asset(`async (ctx) => {
        if (ctx.checkpointState?.page === null) return;
        ctx.checkpoint({ created: 20, page: null });
        await ctx.emit([{ id: 1, created: 20 }]);
      }`),
      "quiet.mjs",
    );
    const firstRef = "run.things__quiet1";
    const first = await attempt(bundle, root, firstRef, null, null, async () => "rejected");

    expect(first.error).toBeUndefined();

    const secondRef = "run.things__quiet2";
    const second = await attempt(bundle, root, secondRef, first.checkpoint);

    expect(second.error).toBeUndefined();
    expect(second.result?.cursor_to).toBe("20");
    expect((await readIds(root, secondRef)).map((row) => row["id"])).toEqual([1]);
  });

  it("a fenced checkpoint fails the seal before the output is written", async () => {
    const root = directory();
    const bundle = writeBundle(
      root,
      asset(`async (ctx) => {
        ctx.checkpoint({ created: 20, page: "p1" });
        await ctx.emit([{ id: 1, created: 20 }]);
      }`),
      "fence.mjs",
    );
    const ref = "run.things__fenced";
    const run = await attempt(
      bundle,
      root,
      ref,
      null,
      null,
      async () => "recorded",
      (event) => {
        if (event.event === "checkpoint") throw new Error("attempt fence rejected");
      },
    );

    expect(run.error?.message).toMatch(/attempt fence rejected/);
    await expect(readIds(root, ref)).rejects.toThrow(/nothing at/);
  });

  it("gives a custom check the committed rows, not only the tail", async () => {
    const root = directory();
    const seen = join(root, "seen.json");
    const bundle = writeBundle(
      root,
      asset(
        `async (ctx) => {
          ctx.checkpoint({ created: 20, page: "p2" });
          await ctx.emit([{ id: 1, created: 20 }]);
          await ctx.emit([{ id: 2, created: 50 }]);
        }`,
        {
          checks: `{ custom: { seen: { severity: "warn" } } }`,
          customChecks: `seen: async ({ rows }) => {
            const { writeFileSync } = await import("node:fs");
            writeFileSync(${JSON.stringify(seen)}, JSON.stringify(rows.map((row) => row.id)));
            return { result: "pass" };
          }`,
        },
      ),
      "check.mjs",
    );
    const run = await attempt(bundle, root, "run.things__check", null);

    expect(run.error).toBeUndefined();
    expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual([1, 2]);
  });

  it("commits the tail cursor and fails when stored rows have none", async () => {
    const root = directory();
    const withTail = await attempt(
      writeBundle(
        root,
        asset(`async (ctx) => {
          ctx.checkpoint({ created: 20, page: "p2" });
          await ctx.emit([{ id: 1, created: 20 }]);
          await ctx.emit([{ id: 2, created: 50 }]);
        }`),
        "tail.mjs",
      ),
      root,
      "run.things__tailcursor",
      null,
    );

    expect(withTail.error).toBeUndefined();
    expect(withTail.result?.cursor_to).toBe("50");

    const without = await attempt(
      writeBundle(
        root,
        asset(`async (ctx) => {
          ctx.checkpoint({ page: "p2" });
          await ctx.emit([{ id: 1 }]);
        }`),
        "missing.mjs",
      ),
      root,
      "run.things__nocursor",
      null,
    );

    expect(without.error?.message).toMatch(/append cursor created is missing/);
  });

  it("commits the watermark on a run that finishes in one attempt", async () => {
    const { root, control, bundle } = emitScenario();
    const ref = "run.things__once";

    writeFileSync(control, JSON.stringify({ failAfter: null }));
    const run = await attempt(bundle, root, ref, null);

    expect(run.error).toBeUndefined();
    await expectCommitted(root, ref, run.result, { cursor_to: "50", ids: [1, 2, 3, 4, 5] });
  });

  it("keeps every processPages row once and does not replace pages already stored", async () => {
    const root = directory();
    const control = join(root, "control.json");
    const log = join(root, "writes.jsonl");
    const bundle = writeBundle(root, processPagesBundle(control, log));
    const ref = "run.things__pages";

    writeFileSync(control, JSON.stringify({ failFetch: 1 }));
    writeFileSync(log, "");
    const first = await attempt(bundle, root, ref, null);
    expect(first.error?.message).toMatch(/429/);

    writeFileSync(control, JSON.stringify({ failFetch: null }));
    const second = await attempt(bundle, root, ref, first.checkpoint);

    expect(second.error).toBeUndefined();
    await expectCommitted(root, ref, second.result, { cursor_to: "50", ids: [1, 2, 3, 4, 5] });
    expect(
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as { page: number; ids: number[] }),
    ).toEqual([
      { page: 0, ids: [1, 2] },
      { page: 1, ids: [3, 4] },
      { page: 2, ids: [5] },
    ]);
  });

  it("resumes an expired page token from the watermark without duplicating the boundary", async () => {
    const { root, control, bundle } = emitScenario();
    const ref = "run.things__expired";
    const states: Record<string, unknown>[] = [];

    writeFileSync(control, JSON.stringify({ expire: true }));
    const run = await attempt(bundle, root, ref, null, null, undefined, (event) => {
      if (event.event === "checkpoint") states.push(event.state);
    });

    expect(run.error).toBeUndefined();
    expect(states.some((state) => !("page" in state) && state["created"] === 20)).toBe(true);
    await expectCommitted(root, ref, run.result, { cursor_to: "50", ids: [1, 2, 9, 3, 4, 5] });
  });

  it("re-walks stable cursors after an expired token with two pages stored", async () => {
    const { root, control, bundle } = emitScenario();
    const ref = "run.things__catalog_expired";

    writeFileSync(control, JSON.stringify({ expire: true, catalog: true }));
    const run = await attempt(bundle, root, ref, null);

    expect(run.error).toBeUndefined();
    await expectCommitted(root, ref, run.result, { cursor_to: "50", ids: [1, 2, 3, 4, 5] });
  });

  it("does not commit the later page when the next attempt reseals a stuck cursor", async () => {
    const root = directory();
    const ref = "run.things__stuck";
    const bundle = writeBundle(root, stuckBundle());
    const first = await attempt(bundle, root, ref, null);

    expect(first.error?.message).toMatch(/page cursor did not advance/);

    const stored = pageRef(first.checkpoint);
    expect((await readIds(root, stored)).map((row) => row["id"])).toEqual([0, 199]);

    const second = await attempt(bundle, root, ref, first.checkpoint);

    expect(second.error?.message).toMatch(/page cursor did not advance/);
    expect(second.result).toBeUndefined();
    expect((await readIds(root, stored)).map((row) => row["id"])).toEqual([0, 199]);
  });

  it("does not drop the page when a terminal error wraps a bundled expired token", async () => {
    const { root, control, bundle } = emitScenario();
    const states: Record<string, unknown>[] = [];

    writeFileSync(control, JSON.stringify({ terminalCause: true }));
    const run = await attempt(
      bundle,
      root,
      "run.things__terminal_cause",
      null,
      null,
      undefined,
      (event) => {
        if (event.event === "checkpoint") states.push(event.state);
      },
    );

    expect(run.error?.message).toMatch(/schema mismatch/);
    expect(states.some((state) => state["page"] === "p2" && state["created"] === 20)).toBe(true);
    expect(states.every((state) => "page" in state)).toBe(true);
  });

  it("does not resume a 400 that is not a dead page token", async () => {
    const { root, control, bundle } = emitScenario();

    writeFileSync(control, JSON.stringify({ expire: "no such field" }));
    const run = await attempt(bundle, root, "run.things__bad", null);

    expect(run.error?.message).toMatch(/no such field/);
  });

  it("does not duplicate earlier pages when a restarted walk mints new tokens", async () => {
    const root = directory();
    const calls = join(root, "calls.txt");
    writeFileSync(calls, "0");
    const bundle = writeBundle(root, restartBundle(calls, false), "restart-new.mjs");
    const ref = "run.things__restart_new";
    const run = await attempt(bundle, root, ref, null);

    expect(run.error).toBeUndefined();
    await expectCommitted(root, ref, run.result, { cursor_to: "50", ids: [1, 2, 3, 4, 9, 5] });
  });

  it("does not wipe a page when the restarted walk reseals its token", async () => {
    const root = directory();
    const calls = join(root, "calls.txt");
    writeFileSync(calls, "0");
    const bundle = writeBundle(root, restartBundle(calls, true), "restart-same.mjs");
    const ref = "run.things__restart_same";
    const run = await attempt(bundle, root, ref, null);

    expect(run.error).toBeUndefined();
    await expectCommitted(root, ref, run.result, { cursor_to: "50", ids: [1, 2, 3, 4, 9, 5] });
  });

  it("retries the same processPages fetch from the watermark", async () => {
    const root = directory();
    const control = join(root, "control.json");
    const log = join(root, "writes.jsonl");
    const bundle = writeBundle(root, processPagesBundle(control, log));
    const ref = "run.things__expired_pages";

    writeFileSync(control, JSON.stringify({ expire: true }));
    const run = await attempt(bundle, root, ref, null);

    expect(run.error).toBeUndefined();
    await expectCommitted(root, ref, run.result, { cursor_to: "50", ids: [1, 2, 3, 4, 5] });
  });
});

describe("append page seals", () => {
  it("publishes the checkpoint only after the page is stored, and the state is the producer's", async () => {
    const tables = new Map<string, Row[]>();
    let failPage = true;
    const pageRefs: string[] = [];

    function adapterFor(events: ExecutorEvent[]): StorageAdapter {
      const stored = memoryAdapter(tables);

      return {
        ...stored,
        write: async (ref, rows) => {
          const result = await stored.write(ref, rows);

          if (isPageRef(ref)) {
            pageRefs.push(ref);

            if (events.some((event) => event.event === "checkpoint")) {
              throw new Error("checkpoint published before the page was stored");
            }

            if (failPage) {
              failPage = false;
              throw new Error("died before the checkpoint event");
            }
          }

          return result;
        },
      };
    }

    const firstEvents: ExecutorEvent[] = [];
    const first = new Shim(
      executorInput(),
      adapterFor(firstEvents),
      "live",
      (event) => firstEvents.push(event),
      undefined,
      { mode: "append" },
    );
    first.checkpoint({ created: 20, page: "p2" });
    await expect(first.emit([{ id: 1, created: 20 }])).rejects.toThrow(/died before/);
    expect(firstEvents.some((event) => event.event === "checkpoint")).toBe(false);

    const secondEvents: ExecutorEvent[] = [];
    const second = new Shim(
      executorInput(),
      adapterFor(secondEvents),
      "live",
      (event) => secondEvents.push(event),
      undefined,
      { mode: "append" },
    );
    second.checkpoint({ created: 20, page: "p2" });
    await second.emit([{ id: 1, created: 20 }]);

    expect(await second.finish()).toEqual({ buffer: [], tail: [] });
    expect(await second.stagedRows()).toEqual([{ id: 1, created: 20 }]);
    expect(pageRefs).toHaveLength(2);
    expect(pageRefs[0]).toBe(pageRefs[1]);
    expect(pageRefs[0]).toMatch(/__page_[0-9a-f]{32}$/);
    expect(secondEvents.filter((event) => event.event === "checkpoint")).toEqual([
      {
        event: "checkpoint",
        state: expect.objectContaining({ created: 20, page: "p2" }) as Record<string, unknown>,
      },
    ]);
    const sealed = secondEvents.find((event) => event.event === "checkpoint");

    expect(sealed && sealed.event === "checkpoint" ? sealed.state[PAGE_LIST] : []).toEqual([
      expect.objectContaining({ key: expect.stringMatching(/^[0-9a-f]{32}$/) }),
    ]);
  });

  it("does not stage a full_refresh checkpoint", async () => {
    const tables = new Map<string, Row[]>();
    const events: ExecutorEvent[] = [];
    const ctx = new Shim(
      executorInput(),
      memoryAdapter(tables),
      "live",
      (event) => events.push(event),
      undefined,
      {
        mode: "full_refresh",
      },
    );

    ctx.checkpoint({ offset: 50 });
    await ctx.emit([{ id: 1 }]);

    expect(events.some((event) => event.event === "checkpoint")).toBe(true);
    expect([...tables.keys()]).toEqual([]);
    expect(await ctx.finish()).toEqual({ buffer: [{ id: 1 }], tail: [] });
  });

  it("overwrites the same resume slot when the checkpoint map changes", async () => {
    const tables = new Map<string, Row[]>();
    const adapter = memoryAdapter(tables);
    const first = new Shim(executorInput(), adapter, "live", () => undefined, undefined, {
      mode: "append",
    });
    first.checkpoint({ created: 20, page: "p2", note: "a" });
    await first.emit([{ id: 1, created: 20 }]);

    const second = new Shim(executorInput(), adapter, "live", () => undefined, undefined, {
      mode: "append",
    });
    second.checkpoint({ created: 21, page: "p2", note: "b" });
    await second.emit([{ id: 1, created: 21 }]);

    expect(await second.stagedRows()).toEqual([{ id: 1, created: 21 }]);
    expect([...tables.keys()].filter(isPageRef)).toHaveLength(1);
  });

  it("waits for the checkpoint ack before the seal resolves", async () => {
    let release: (() => void) | undefined;
    const ack = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tables = new Map<string, Row[]>();
    const shim = new Shim(
      executorInput(),
      memoryAdapter(tables),
      "live",
      (event) => {
        if (event.event === "checkpoint") return ack;
        return undefined;
      },
      undefined,
      { mode: "append" },
    );
    shim.checkpoint({ created: 20, page: "p2" });
    let settled = false;
    const pending = shim.emit([{ id: 1, created: 20 }]).then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release?.();
    await pending;
    expect(settled).toBe(true);
  });

  it("keeps both pages when two seals run at the same time", async () => {
    const tables = new Map<string, Row[]>();
    const shim = new Shim(
      executorInput(),
      memoryAdapter(tables),
      "live",
      () => undefined,
      undefined,
      {
        mode: "append",
      },
    );

    shim.checkpoint({ page: "p2" });
    const first = shim.emit([{ id: 1 }]);
    shim.checkpoint({ page: "p3" });
    const second = shim.emit([{ id: 2 }]);
    await Promise.all([first, second]);

    expect(
      (await shim.stagedRows())
        .map((row) => row["id"])
        .sort((leftId, rightId) => Number(leftId) - Number(rightId)),
    ).toEqual([1, 2]);
    expect(shim.stagedPages()).toHaveLength(2);
    expect([...tables.keys()].filter((ref) => ref.endsWith("__page_index"))).toEqual([]);
  });

  it("fails when one walk seals the same resume slot twice", async () => {
    const tables = new Map<string, Row[]>();
    const shim = new Shim(
      executorInput(),
      memoryAdapter(tables),
      "live",
      () => undefined,
      undefined,
      {
        mode: "append",
      },
    );

    shim.checkpoint({ page: "stuck", id: "199" });
    await shim.emit([
      { id: 0, n: 0 },
      { id: 199, n: 199 },
    ]);
    shim.checkpoint({ page: "stuck", id: "399" });

    await expect(
      shim.emit([
        { id: 200, n: 200 },
        { id: 399, n: 399 },
      ]),
    ).rejects.toThrow(/page cursor did not advance/);
    expect(await shim.stagedRows()).toEqual([
      { id: 0, n: 0 },
      { id: 199, n: 199 },
    ]);
    expect(shim.stagedPages()).toHaveLength(1);
    expect([...tables.keys()].filter(isPageRef)).toHaveLength(1);
  });
});

function executorInput(overrides: Partial<ExecutorInput> = {}): ExecutorInput {
  return {
    bundle_ref: "/tmp/bundle.js",
    sdk_version: "0.2.0",
    asset_key: "source/things",
    partition: "",
    inputs: {},
    checkpoint: null,
    cursor_from: null,
    bindings: {},
    storage_connection: "lake",
    output_storage_ref: "run.things__a",
    connections: {},
    ...overrides,
  };
}

function emitScenario(): { root: string; control: string; bundle: string } {
  const root = directory();
  const control = join(root, "control.json");

  return { root, control, bundle: writeBundle(root, emitBundle(control)) };
}

async function expectCommitted(
  root: string,
  ref: string,
  result: { cursor_to: string | null } | undefined,
  expected: { cursor_to: string; ids: number[] },
): Promise<void> {
  expect(result?.cursor_to).toBe(expected.cursor_to);
  expect((await readIds(root, ref)).map((row) => row["id"])).toEqual(expected.ids);
  expect(stagedPages(root)).toEqual([]);
}

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "puppi-append-"));
  roots.push(root);
  return root;
}

function writeBundle(root: string, source: string, name = "bundle.mjs"): string {
  const path = join(root, name);
  writeFileSync(path, bundleCarryingStorage(source));
  return path;
}

async function attempt(
  bundle: string,
  root: string,
  ref: string,
  checkpoint: Record<string, unknown> | null,
  cursorFrom: string | null = null,
  settle?: SettleAttempt,
  onEvent?: (event: ExecutorEvent) => void,
): Promise<{
  error?: Error;
  result?: { cursor_to: string | null };
  checkpoint: Record<string, unknown> | null;
}> {
  const events: ExecutorEvent[] = [];
  const input: ExecutorInput = {
    bundle_ref: bundle,
    sdk_version: "0.2.0",
    asset_key: "source/things",
    partition: "",
    inputs: {},
    checkpoint,
    cursor_from: cursorFrom,
    bindings: {
      lake: { type: "filesystem", config: { root }, secrets: {}, mode: "live" },
    },
    storage_connection: "lake",
    output_storage_ref: ref,
    connections: {},
  };

  const emit = (event: ExecutorEvent): void => {
    onEvent?.(event);
    events.push(event);
  };

  try {
    const result = await execute(input, emit, settle);
    return { result, checkpoint: lastCheckpoint(events) };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      checkpoint: lastCheckpoint(events),
    };
  }
}

function lastCheckpoint(events: ExecutorEvent[]): Record<string, unknown> | null {
  const found = events.filter((event) => event.event === "checkpoint");
  const last = found.at(-1);
  return last && last.event === "checkpoint" ? last.state : null;
}

function arrayRows(rows: Row[] | AsyncIterable<Row[]>): Row[] {
  if (!Array.isArray(rows)) throw new Error("this adapter stores an array");

  return rows;
}

function isPageRef(ref: string): boolean {
  return ref.includes("__page_") && !ref.endsWith("__page_index");
}

function memoryAdapter(tables: Map<string, Row[]>): TableStorage {
  return {
    write: async (ref, rows) => {
      const stored = arrayRows(rows);
      tables.set(
        ref,
        stored.map((row) => ({ ...row })),
      );
      return {
        storage_ref: ref,
        observed_schema: [],
        stats: { row_count: stored.length, bytes: 0, content_hash: null },
      };
    },
    read: async (ref) => {
      const found = tables.get(ref);

      if (!found) throw new Error(`nothing at ${ref}`);

      return found.map((row) => ({ ...row }));
    },
    query: async () => [],
    drop: async () => {},
    close: async () => {},
  };
}

function stagedPages(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);

      if (statSync(path).isDirectory()) walk(path);
      else if (name.includes("__page_")) found.push(name);
    }
  };

  walk(root);
  return found;
}

async function readIds(root: string, ref: string): Promise<Record<string, unknown>[]> {
  const storage = new Filesystem({ root }, {});

  try {
    return await storage.read(ref);
  } finally {
    await storage.close();
  }
}

function asset(run: string, checks: { checks?: string; customChecks?: string } = {}): string {
  const declared = checks.checks ?? "{}";
  const custom =
    checks.customChecks === undefined ? "" : `customChecks: { ${checks.customChecks} },`;

  return `
    export default {
      assets: {
        "source/things": {
          key: "source/things",
          group: "default",
          visibility: "project",
          role: "source",
          producer: "ts",
          deps: [],
          connections: [],
          partitioning: {},
          checks: ${declared},
          ${custom}
          config: { mode: "append", cursor: "created" },
          run: ${run},
        },
      },
      adapters: {},
    };
  `;
}

/**
 * Two pages share one next cursor. The second attempt resumes at that cursor
 * and would otherwise overwrite the stored page with the later rows.
 */
function stuckBundle(): string {
  const first = [
    { id: 0, created: 1 },
    { id: 199, created: 10 },
  ];
  const later = [
    { id: 200, created: 20 },
    { id: 399, created: 30 },
  ];

  return asset(`async (ctx) => {
    const state = ctx.checkpointState ?? {};
    if ("page" in state && state.page === null) return;
    const token = "page" in state ? state.page : null;
    const pages = token === "stuck"
      ? [{ next: "stuck", data: ${JSON.stringify(later)} }]
      : [
          { next: "stuck", data: ${JSON.stringify(first)} },
          { next: "stuck", data: ${JSON.stringify(later)} },
        ];
    for (const page of pages) {
      const created = page.data.at(-1)?.created;
      if (created !== undefined) ctx.checkpoint({ created, page: page.next });
      await ctx.emit(page.data);
    }
  }`);
}

function pageRef(checkpoint: Record<string, unknown> | null): string {
  const listed = checkpoint?.[PAGE_LIST];
  const page = Array.isArray(listed) ? listed[0] : undefined;

  if (typeof page !== "object" || page === null || typeof page.ref !== "string") {
    throw new Error("checkpoint has no staged page");
  }

  return page.ref;
}

/**
 * Throws the `HttpStatusError` a bundle inlines. The brand is the symbol the
 * class carries, and `instanceof` is false across that boundary.
 */
function bundledStatusThrow(bodyExpr: string): string {
  return `class BundledHttpStatusError extends Error {
      constructor(status, body) {
        super("demo answered " + status + " Bad Request for https://api.test/things: " + body);
        this.name = "HttpStatusError";
        this.status = status;
        this.retryAfterMs = null;
        this[Symbol.for("puppi.http_status_error")] = true;
      }
    }
    throw new BundledHttpStatusError(400, ${bodyExpr});`;
}

/** Checkpoint, then emit. The page token stored is the next page, matching the catalog producers. */
function emitBundle(controlPath: string): string {
  return asset(`async (ctx) => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const control = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, "utf8"));
    const pages = ${JSON.stringify(PAGES)};
    const state = ctx.checkpointState ?? {};

    if ("page" in state && state.page === null) return;

    if (!control.catalog && control.expire && typeof state.created === "number" && !("page" in state)) {
      const rows = pages.flatMap((page) => page.data).filter((row) => row.created >= state.created);
      rows.splice(1, 0, { id: 9, created: state.created });
      const created = rows.at(-1)?.created;
      if (created !== undefined) ctx.checkpoint({ created, page: null });
      if (rows.length > 0) await ctx.emit(rows);
      return;
    }

    const token = "page" in state ? state.page : null;
    const since = ctx.checkpointState || ctx.cursorFrom == null ? null : Number(ctx.cursorFrom);
    const incoming = [null, "p2", "p3"];
    const start = incoming.indexOf(token);
    if (start < 0) throw new Error("resume token " + token + " is not a page");

    for (let index = start; index < pages.length; index++) {
      const page = pages[index];
      const data = since == null ? page.data : page.data.filter((row) => row.created > since);
      if (data.length === 0) continue;
      const created = data.at(-1)?.created;
      if (created !== undefined) ctx.checkpoint({ created, page: page.next });
      await ctx.emit(data);
      if (control.terminalCause && page.next === "p2") {
        const token = new Error("invalid page token");
        token.name = "ExpiredPageToken";
        token[Symbol.for("puppi.expired_page_token")] = true;
        const outer = new Error("schema mismatch", { cause: token });
        outer[Symbol.for("puppi.terminal_error")] = true;
        throw outer;
      }
      if (control.expire && page.next === (control.catalog ? "p3" : "p2")) {
        if (control.catalog) writeFileSync(${JSON.stringify(controlPath)}, JSON.stringify({ catalog: true }));
        const body = typeof control.expire === "string" ? control.expire : "invalid page token";
        ${bundledStatusThrow("body")}
      }
      if (typeof control.failAfter === "string" && control.failAfter === page.next) {
        throw new Error("429 rate limit");
      }
    }

    if (control.failAtEnd) throw new Error("terminal failure");
  }`);
}

/**
 * Checkpoint, then emit, and die after the first page on the first call.
 * `page` absent starts at the first page, so the retry emits the walk again.
 * `sameTokens` reseals that page; otherwise the retry mints new tokens.
 */
function restartBundle(callsPath: string, sameTokens: boolean): string {
  return asset(`async (ctx) => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const state = ctx.checkpointState ?? {};

    if ("page" in state && state.page === null) return;

    const n = Number(readFileSync(${JSON.stringify(callsPath)}, "utf8")) + 1;
    writeFileSync(${JSON.stringify(callsPath)}, String(n));
    const first = ${sameTokens ? "true" : "n === 1"};
    const pages = [
      {
        cursor: first ? "p2" : "q2",
        data: [
          { id: 1, created: 10 },
          { id: 2, created: 20 },
        ],
      },
      {
        cursor: first ? "p3" : "q3",
        data: [
          { id: 3, created: 30 },
          { id: 4, created: 40 },
        ],
      },
      {
        cursor: null,
        data: [
          { id: 9, created: 20 },
          { id: 5, created: 50 },
        ],
      },
    ];

    for (const page of pages) {
      const created = page.data.at(-1)?.created;

      if (created !== undefined) ctx.checkpoint({ created, page: page.cursor });
      await ctx.emit(page.data);

      if (n === 1) {
        ${bundledStatusThrow('"invalid page token"')}
      }
    }
  }`);
}

function processPagesBundle(controlPath: string, logPath: string): string {
  return asset(`async (ctx) => {
    const { appendFileSync, readFileSync } = await import("node:fs");
    const control = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, "utf8"));
    const pages = ${JSON.stringify(PAGES)};

    await ctx.processPages({
      fetch: async ({ cursor, page }) => {
        if (control.expire && page > 0 && cursor !== "20") {
          ${bundledStatusThrow('"invalid page token"')}
        }
        if (control.expire && cursor === "20") {
          const records = pages.flatMap((page) => page.data).filter((row) => row.created >= 20);
          return { records, nextCursor: null, done: true };
        }
        if (control.failFetch === page) throw new Error("429 rate limit");
        if (page >= pages.length) return { records: [], nextCursor: null, done: true };
        const current = pages[page];
        const done = page === pages.length - 1;
        return { records: current.data, nextCursor: done ? null : String(page + 1), done };
      },
      write: async (rows, context) => {
        appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ page: context.page, ids: rows.map((row) => row.id) }) + "\\n");
      },
      retry: { fetch: { attempts: 1 } },
    });
  }`);
}
