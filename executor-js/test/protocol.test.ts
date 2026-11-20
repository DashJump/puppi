import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vite-plus/test";

import {
  assertValidInput,
  assertValidLease,
  type CompleteEnvelope,
  type EventEnvelope,
  type ExecutorInput,
  type Lease,
  type OutboundEnvelope,
} from "../src/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "protocol/executor-v2.schema.json");
const fixturePath = resolve(here, "protocol/fixtures/attempt-input.json");

const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Lease;

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const validate = ajv.compile(schema);
const defs = schema["$defs"] as Record<string, object>;
const validateEvent = ajv.compile({ ...defs["ExecutorEvent"], $defs: defs });

function runExecutor(lease: unknown): Promise<OutboundEnvelope[]> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      process.execPath,
      [resolve(here, "../dist/runtime.js")],
      (error, stdout) => {
        if (error && !stdout) return reject(error);

        resolvePromise(
          stdout
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as OutboundEnvelope),
        );
      },
    );

    child.stdin?.end(`${JSON.stringify(lease)}\n`);
  });
}

function leaseWith(input: ExecutorInput): Lease {
  return { ...fixture, input };
}

describe("the lease contract", () => {
  it("accepts the golden fixture", () => {
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(() => assertValidLease(fixture)).not.toThrow();
    expect(() => assertValidInput(fixture.input)).not.toThrow();
  });

  it("rejects an input missing a required field", () => {
    const { asset_key: _omitted, ...incomplete } = fixture.input;
    const leased = leaseWith(incomplete as ExecutorInput);

    expect(validate(leased)).toBe(false);
    expect(() => assertValidLease(leased)).toThrow(/asset_key/);
  });

  it("rejects a bare V1 input", () => {
    expect(validate(fixture.input)).toBe(false);
    expect(() => assertValidLease(fixture.input)).toThrow(/V2 lease/);
  });
});

describe("the event stream", () => {
  it("emits only schema-valid envelopes, ending in exactly one complete", async () => {
    // A bundle that does not exist: the run fails before touching postgres,
    // which is what keeps this test hermetic while still going through the
    // real runtime and the real framing.
    const envelopes = await runExecutor(
      leaseWith({ ...fixture.input, bundle_ref: "/nonexistent/bundle.js" }),
    );

    expect(envelopes.length).toBeGreaterThan(0);

    for (const envelope of envelopes) {
      expect(
        validate(envelope),
        `${JSON.stringify(envelope)} ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }

    const terminal = envelopes.filter(
      (envelope): envelope is CompleteEnvelope => envelope.message === "complete",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.result).toMatchObject({ event: "error", class: "terminal" });
    expect(terminal[0]?.last_seq).toBe(envelopes.length - 1);

    const first = envelopes[0] as EventEnvelope;
    // The runtime reported the load it failed at, as a shim span, before
    // the terminal envelope. The child assigned seq.
    expect(first).toMatchObject({
      message: "event",
      seq: 1,
      event: {
        event: "span",
        name: "bundle_loaded",
        source: "shim",
        kind: "span",
        attributes: { assets: 0, error: true },
      },
    });
  });

  it("accepts retry_after_ms on a rate-limit error", () => {
    const event = {
      event: "error",
      class: "retryable",
      message: "demo answered 429 Too Many Requests",
      retry_after_ms: 120_000,
    };

    expect(validateEvent(event), JSON.stringify(validateEvent.errors)).toBe(true);
  });

  it("classifies a document that is not a lease as terminal, not retryable", async () => {
    const envelopes = await runExecutor(fixture.input);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      message: "complete",
      result: { event: "error", class: "terminal" },
    });
    for (const envelope of envelopes) expect(validate(envelope)).toBe(true);
  });

  it("reports a missing asset as terminal", async () => {
    const envelopes = await runExecutor(
      leaseWith({
        ...fixture.input,
        bundle_ref: resolve(here, "fixtures/local-bundle.js"),
        asset_key: "not/declared",
      }),
    );

    const terminal = envelopes.at(-1) as CompleteEnvelope;
    expect(terminal.result).toMatchObject({ event: "error", class: "terminal" });
    if (terminal.result.event !== "error") throw new Error("expected an error envelope");
    expect(terminal.result.message).toContain("not/declared");
  });
});
