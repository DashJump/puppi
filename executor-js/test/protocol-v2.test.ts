import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vite-plus/test";

const here = dirname(fileURLToPath(import.meta.url));
const protocolDir = resolve(here, "protocol");
const v2 = JSON.parse(
  readFileSync(resolve(protocolDir, "executor-v2.schema.json"), "utf8"),
) as Record<string, unknown>;
const fixture = JSON.parse(
  readFileSync(resolve(protocolDir, "fixtures/attempt-input.json"), "utf8"),
) as {
  input: Record<string, unknown>;
  execution: Record<string, unknown>;
};
const input = fixture.input;
const ready = JSON.parse(
  readFileSync(resolve(protocolDir, "fixtures/v2-ready.json"), "utf8"),
) as Record<string, unknown>;
const settled = JSON.parse(
  readFileSync(resolve(protocolDir, "fixtures/v2-settled.json"), "utf8"),
) as Record<string, unknown>;
const fenced = JSON.parse(
  readFileSync(resolve(protocolDir, "fixtures/v2-settled-fenced.json"), "utf8"),
) as Record<string, unknown>;
const trust = JSON.parse(readFileSync(resolve(protocolDir, "fixtures/v2-trust.json"), "utf8")) as {
  ready: Record<string, unknown>;
  worker_secrets: Record<string, unknown>;
  signatures: Record<string, unknown>;
};

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
const validate = ajv.compile(v2);

const execution = {
  attempt_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  run_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  fence: 1,
  runtime_profile: "remote-node",
  bundle_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  output_materialization_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  lease_expires_at: "2026-09-20T08:00:00Z",
  deadline_at: "2026-09-20T09:00:00Z",
};

describe("executor protocol v2 envelopes", () => {
  it("accepts a ready frame and a lease with a claim token", () => {
    expect(ready).toEqual({ message: "ready", slots: 2 });
    expect(validate(ready), JSON.stringify(validate.errors)).toBe(true);

    const leased = { message: "lease", execution, input, claim_token: "claim-token" };
    expect(validate(leased), JSON.stringify(validate.errors)).toBe(true);
  });

  it("settles a recorded complete and reports a fenced error", () => {
    expect(settled).toEqual({
      message: "settled",
      attempt_id: execution.attempt_id,
      fence: 1,
      outcome: "recorded",
    });
    expect(validate(settled), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(fenced), JSON.stringify(validate.errors)).toBe(true);
    expect(fenced).toMatchObject({ outcome: "fenced" });
    expect(validate({ message: "settled", attempt_id: execution.attempt_id, fence: 1 })).toBe(
      false,
    );
    expect(
      validate({ message: "settled", attempt_id: execution.attempt_id, fence: 1, fenced: true }),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(
      validate({
        message: "settled",
        attempt_id: execution.attempt_id,
        fence: 1,
        reason: "cancelled",
      }),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  it("leases one complete attempt", () => {
    const message = { message: "lease", execution, input };

    expect(validate(message), JSON.stringify(validate.errors)).toBe(true);
  });

  it("sequences events under the attempt fence", () => {
    const message = {
      message: "event",
      attempt_id: execution.attempt_id,
      fence: 1,
      seq: 7,
      event: { event: "checkpoint", state: { page: 3 } },
    };

    expect(validate(message), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts a logs batch and rejects a line over 4 KB", () => {
    const event = {
      message: "event",
      attempt_id: execution.attempt_id,
      fence: 1,
      seq: 1,
      event: {
        event: "logs",
        lines: [{ level: "info", message: "hello", truncated: false }],
      },
    };

    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(
      validate({
        ...event,
        event: { event: "logs", lines: [{ level: "info", message: "a".repeat(4097) }] },
      }),
    ).toBe(false);
    expect(
      validate({
        ...event,
        event: {
          event: "logs",
          lines: [{ level: "info", message: "hello", dropped_marker: true }],
        },
      }),
    ).toBe(false);
  });

  it("carries withheld as an optional list on event and complete", () => {
    const event = {
      message: "event",
      attempt_id: execution.attempt_id,
      fence: 1,
      seq: 1,
      event: { event: "log", level: "info", message: "" },
      withheld: ["message"],
    };
    const complete = {
      message: "complete",
      attempt_id: execution.attempt_id,
      fence: 1,
      last_seq: 1,
      result: { event: "error", class: "terminal", message: "terminal" },
      withheld: ["message"],
    };

    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(complete), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...event, withheld: [] })).toBe(false);
  });

  it("rejects unsequenced events and unknown distributed steps", () => {
    expect(
      validate({
        message: "event",
        attempt_id: execution.attempt_id,
        fence: 1,
        event: { event: "checkpoint", state: { page: 3 } },
      }),
    ).toBe(false);

    expect(validate({ message: "run_transform_step", execution, input })).toBe(false);
  });

  it("accepts optional secret names and signatures", () => {
    expect(validate(trust.ready), JSON.stringify(validate.errors)).toBe(true);

    const leased = {
      message: "lease",
      execution,
      input,
      worker_secrets: trust.worker_secrets,
      signatures: trust.signatures,
    };
    expect(validate(leased), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...ready, secrets: [] })).toBe(true);
  });
});
