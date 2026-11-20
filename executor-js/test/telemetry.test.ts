import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { StorageAdapter } from "@puppi/sdk";
import Ajv from "ajv";
import { describe, expect, it } from "vite-plus/test";

import type { ExecutorEvent, ExecutorInput, SpanEvent } from "../src/protocol.js";
import { Shim } from "../src/shim/ctx.js";
import { TelemetryShim } from "../src/telemetry.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "protocol/executor-v2.schema.json");
const fixturePath = resolve(here, "protocol/fixtures/attempt-input.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
const fixture = (JSON.parse(readFileSync(fixturePath, "utf8")) as { input: ExecutorInput }).input;

const defs = schema["$defs"] as Record<string, object>;
const validateEvent = new Ajv({ strict: false, allErrors: true }).compile({
  ...defs["ExecutorEvent"],
  $defs: defs,
});

/** A shim over a fake adapter, with every event it emits captured. */
function shim(): { ctx: Shim; events: ExecutorEvent[]; spans: () => SpanEvent[] } {
  const events: ExecutorEvent[] = [];
  const adapter = {
    query: async () => [{ id: "cus_1" }, { id: "cus_2" }],
  } as unknown as StorageAdapter;
  const ctx = new Shim(fixture, adapter, "live", (event) => events.push(event));

  return {
    ctx,
    events,
    spans: () => events.filter((event): event is SpanEvent => event.event === "span"),
  };
}

describe("the shim's own instrumentation", () => {
  it("reports every ctx call as a shim span that validates against the protocol", async () => {
    const { ctx, events, spans } = shim();

    ctx.input("stripe/customers");
    await ctx.query("select 1");
    await ctx.emit([{ a: 1 }, { a: 2 }, { a: 3 }]);
    ctx.checkpoint({ page: 2 });

    for (const event of events) {
      expect(validateEvent(event), JSON.stringify([event, validateEvent.errors])).toBe(true);
    }

    expect(spans().map((span) => [span.name, span.source, span.kind])).toEqual([
      ["input_read", "shim", "event"],
      ["query", "shim", "span"],
      ["emit", "shim", "span"],
      ["checkpoint", "shim", "event"],
    ]);

    const [read, query, emit, checkpoint] = spans();
    expect(read).toMatchObject({
      duration_ms: null,
      attributes: {
        key: "stripe/customers",
        materialization_id: "11111111-1111-1111-1111-111111111111",
      },
    });
    expect(query).toMatchObject({ attributes: { connection: "warehouse", rows: 2 } });
    expect(query?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(emit).toMatchObject({ attributes: { rows: 3 } });
    expect(checkpoint).toMatchObject({ duration_ms: null, attributes: { keys: 1 } });

    // The lineage `read` and the `checkpoint` protocol events are still
    // there: telemetry is added beside them, never in place of them.
    expect(events.map((event) => event.event)).toEqual([
      "read",
      "span",
      "span",
      "span",
      "checkpoint",
      "span",
    ]);
  });
});

describe("ctx.telemetry", () => {
  it("tags everything user code reports as user-sourced", async () => {
    const { ctx, spans } = shim();

    const value = await ctx.telemetry.span("enrich", async () => 42, { pages: 2 });
    ctx.telemetry.event("rate_limited", { retry_after: 30 });
    ctx.telemetry.gauge("pages_fetched", 12);

    expect(value).toBe(42);
    expect(spans().every((span) => span.source === "user")).toBe(true);

    for (const span of spans()) {
      expect(validateEvent(span), JSON.stringify(validateEvent.errors)).toBe(true);
    }

    const [enrich, limited, pages] = spans();
    expect(enrich).toMatchObject({ name: "enrich", kind: "span", attributes: { pages: 2 } });
    expect(enrich?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(limited).toMatchObject({
      name: "rate_limited",
      kind: "event",
      duration_ms: null,
      attributes: { retry_after: 30 },
    });
    expect(pages).toMatchObject({
      name: "pages_fetched",
      kind: "gauge",
      duration_ms: null,
      attributes: { value: 12 },
    });
  });

  it("reports a span whose body threw, and still throws", async () => {
    const { ctx, spans } = shim();

    await expect(
      ctx.telemetry.span("enrich", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(spans()).toHaveLength(1);
    expect(spans()[0]).toMatchObject({ name: "enrich", attributes: { error: true } });
  });

  it("rejects an attribute that is not a scalar, before anything is emitted", () => {
    const { ctx, spans } = shim();
    const rows = [{ id: 1 }] as unknown as string;

    expect(() => ctx.telemetry.event("leak", { rows })).toThrow(/must be a string/);
    expect(() => ctx.telemetry.gauge("nan", Number.NaN)).toThrow(/finite number/);
    expect(() => ctx.telemetry.event("")).toThrow(/non-empty name/);
    expect(spans()).toHaveLength(0);
  });

  it("is the same code path as the shim's, differing only in source", () => {
    const events: SpanEvent[] = [];
    new TelemetryShim((event) => events.push(event), "shim").event("bundle_loaded", { assets: 4 });

    expect(events).toEqual([
      {
        event: "span",
        name: "bundle_loaded",
        source: "shim",
        kind: "event",
        duration_ms: null,
        attributes: { assets: 4 },
      },
    ]);
  });
});
