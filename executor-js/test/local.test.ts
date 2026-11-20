/**
 * The local harness, through the process the CLI actually spawns.
 *
 * Driving `dist/local/main.js` rather than importing `runLocal` is the point:
 * the framing, the stdin contract and the one-terminal-event rule are what the
 * CLI depends on, and a harness that produced the right object but wrote it
 * the wrong way would still be broken.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { LocalInput } from "../src/local/protocol.js";
import { readOnly } from "../src/local/storage.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../dist/local/main.js");
const bundle = resolve(here, "fixtures/local-bundle.js");

type Event = Record<string, unknown>;

function input(over: Partial<LocalInput> = {}): LocalInput {
  return {
    bundle_ref: bundle,
    asset_key: "api/people",
    partition: "default",
    inputs: {},
    checkpoint: null,
    cursor_from: null,
    bindings: {},
    storage_connection: null,
    sample: 10,
    connections: {},
    ...over,
  };
}

function runLocal(payload: LocalInput): Promise<Event[]> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(process.execPath, [entry], (error, stdout) => {
      if (error && !stdout) return reject(error);

      resolvePromise(
        stdout
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as Event),
      );
    });

    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  });
}

const resultOf = (events: Event[]): Event =>
  events.find((event) => event["event"] === "local_result") ?? {};

describe("a source with nothing bound", () => {
  it("runs the producer and reports what it emitted", async () => {
    const events = await runLocal(input());
    const result = resultOf(events);

    expect(result["row_count"]).toBe(3);
    expect(result["role"]).toBe("source");
    expect(result["observed_schema"]).toEqual([
      { name: "id", type: "integer" },
      { name: "name", type: "string" },
    ]);
    expect(result["contract"]).toEqual({ result: "pass", detail: "2 declared columns present" });
    expect(result["content_hash"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("passes `ctx.log` and `ctx.checkpoint` through as they happen", async () => {
    const events = await runLocal(input());

    expect(events.filter((event) => event["event"] === "log")).toContainEqual({
      event: "log",
      level: "info",
      message: "fetching people",
    });
    expect(events.filter((event) => event["event"] === "checkpoint")).toContainEqual({
      event: "checkpoint",
      state: { page: 1 },
    });
  });

  it("runs custom checks for real", async () => {
    const result = resultOf(await runLocal(input()));

    expect(result["check_results"]).toEqual([
      { kind: "custom", name: "not_empty", severity: "block", result: "pass", detail: null },
    ]);
    expect(result["checks_error"]).toBeNull();
  });

  it("carries back at most `sample` rows, and says how many there were", async () => {
    const result = resultOf(await runLocal(input({ sample: 2 })));

    expect(result["row_count"]).toBe(3);
    expect(result["sample"]).toEqual([
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
    ]);
  });

  it("ends in exactly one terminal event", async () => {
    const events = await runLocal(input());
    const terminal = events.filter(
      (event) => event["event"] === "local_result" || event["event"] === "error",
    );

    expect(terminal).toHaveLength(1);
    expect(events.at(-1)).toBe(terminal[0]);
  });
});

describe("the verdict a deploy would have reached later", () => {
  it("reports the contract break instead of quarantining minutes from now", async () => {
    const result = resultOf(await runLocal(input({ asset_key: "api/drifted" })));

    expect(result["contract"]).toEqual({
      result: "fail",
      detail: "id: declared integer, observed string",
    });
    // Still a completed run: the rows are what the user ran this for.
    expect(result["row_count"]).toBe(1);
  });

  it("reports a check that threw, and keeps the rows", async () => {
    const result = resultOf(await runLocal(input({ asset_key: "api/unverifiable" })));

    expect(result["checks_error"]).toBe("the verification API is down");
    expect(result["check_results"]).toEqual([]);
    expect(result["row_count"]).toBe(1);
  });
});

describe("what a local run cannot do", () => {
  it("refuses ctx.query when no storage is bound, and names the file to fix", async () => {
    const events = await runLocal(
      input({
        asset_key: "core/joined",
        inputs: { "api/people": { materialization_id: "--input", storage_ref: "public.people" } },
      }),
    );
    const failure = events.find((event) => event["event"] === "error") ?? {};

    expect(String(failure["message"])).toContain("calls ctx.query()");
    expect(String(failure["message"])).toContain("bindings.local.json");
  });

  it("refuses ctx.input for a key the CLI did not resolve", async () => {
    const events = await runLocal(input({ asset_key: "core/joined" }));
    const failure = events.find((event) => event["event"] === "error") ?? {};

    expect(String(failure["message"])).toContain('ctx.input("api/people")');
  });

  it("cannot write through the storage it was handed", async () => {
    // The getter would throw if a write reached the pool at all; the refusal
    // comes first, which is what makes "writes nothing, ever" structural.
    const adapter = readOnly(() => {
      throw new Error("the pool was asked for an adapter to write through");
    });

    await expect(adapter.write("prod.core_customer", [])).rejects.toThrow(
      /a local run writes nothing/,
    );
  });
});
