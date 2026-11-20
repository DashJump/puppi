/**
 * Returning without emitting writes an empty table. `ctx.unchanged()` skips
 * that write. `ctx.latest` is the table the producer can read before it decides.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { execute } from "../src/execute.js";
import type { ExecutorEvent, ExecutorInput, ResultEvent } from "../src/protocol.js";
import { bundleCarryingStorage } from "./support/storage-adapters.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("skipping a fetch", () => {
  it("does not replace the output with an empty table", async () => {
    const root = directory();
    const ref = "run.source__skip";
    const bundle = writeBundle(
      root,
      `export default {
        adapters: {},
        assets: {
          "a/source": {
            key: "a/source",
            role: "source",
            config: { mode: "full_refresh" },
            checks: {},
            run: async (ctx) => {
              if (typeof ctx.unchanged === "function") return ctx.unchanged();
            },
          },
        },
      };`,
    );

    const outcome = await attempt(bundle, root, ref, {});
    const result = outcome.result;

    // Returning without emitting writes the empty table and reports an
    // ordinary result. A skip has to do neither.
    expect({
      error: outcome.error?.message,
      unchanged: result?.unchanged ?? null,
      wroteEmptyTable: existsSync(join(root, "run", "source__skip.parquet")),
    }).toEqual({ error: undefined, unchanged: true, wroteEmptyTable: false });
  });

  it("reads the current latest table", async () => {
    const root = directory();
    const report = join(root, "report.json");
    const bundle = writeBundle(
      root,
      `export default {
        adapters: {},
        assets: {
          "a/source": {
            key: "a/source",
            role: "source",
            config: { mode: "full_refresh" },
            checks: {},
            run: async (ctx) => {
              const { writeFileSync } = await import("node:fs");
              const latest = ctx.latest;
              writeFileSync(${JSON.stringify(report)}, JSON.stringify({
                ref: latest == null ? null : String(latest),
              }));
              await ctx.emit([{ id: 1 }]);
            },
          },
        },
      };`,
    );

    const outcome = await attempt(bundle, root, "run.source__next", {
      latest: {
        materialization_id: "11111111-1111-1111-1111-111111111111",
        storage_ref: "run.source__prev",
      },
    });
    const seen = JSON.parse(
      await import("node:fs").then((fs) => fs.readFileSync(report, "utf8")),
    ) as { ref: string | null };

    expect({ error: outcome.error?.message, seen }).toEqual({
      error: undefined,
      seen: { ref: "run.source__prev" },
    });
  });

  it("rejects unchanged after a row was emitted", async () => {
    const root = directory();
    const bundle = writeBundle(
      root,
      `export default {
        adapters: {},
        assets: {
          "a/source": {
            key: "a/source",
            role: "source",
            config: { mode: "full_refresh" },
            checks: {},
            run: async (ctx) => {
              await ctx.emit([{ id: 1 }]);
              return ctx.unchanged();
            },
          },
        },
      };`,
    );

    const outcome = await attempt(bundle, root, "run.source__late", {
      latest: {
        materialization_id: "11111111-1111-1111-1111-111111111111",
        storage_ref: "run.source__prev",
      },
    });

    expect(outcome.error?.message).toMatch(/after emitting/);
    expect(outcome.result).toBeUndefined();
  });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "puppi-conditional-"));
  roots.push(root);
  return root;
}

function writeBundle(root: string, source: string): string {
  const path = join(root, "bundle.mjs");
  writeFileSync(path, bundleCarryingStorage(source));
  return path;
}

async function attempt(
  bundle: string,
  root: string,
  ref: string,
  extra: Record<string, unknown>,
): Promise<{ error?: Error; result?: ResultEvent }> {
  const input = {
    bundle_ref: bundle,
    sdk_version: "0.2.0",
    asset_key: "a/source",
    partition: "",
    inputs: {},
    checkpoint: null,
    cursor_from: null,
    bindings: {
      lake: { type: "filesystem", config: { root }, secrets: {}, mode: "live" },
    },
    storage_connection: "lake",
    output_storage_ref: ref,
    connections: {},
    ...extra,
  } as ExecutorInput;

  const events: ExecutorEvent[] = [];

  try {
    const result = await execute(input, (event) => events.push(event));
    return { result };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}
