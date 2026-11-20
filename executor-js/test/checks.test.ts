import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CheckCtx, Declaration } from "@puppi/sdk";
import Ajv from "ajv";
import { beforeEach, describe, expect, it } from "vitest";

import { runChecks } from "../src/checks.js";
import { reset, sdk } from "./support/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "protocol/executor-v2.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
const defs = schema["$defs"] as Record<string, object>;
const validateResult = new Ajv({ strict: false, allErrors: true }).compile({
  ...defs["check_result"],
  $defs: defs,
});

beforeEach(async () => {
  await reset();
});

function ctx(rows: Record<string, unknown>[], logs: string[] = []): CheckCtx {
  return {
    rows,
    output: "puppi.core_customer",
    query: async () => ({ rows: [] }),
    log: (message) => void logs.push(message),
  };
}

function declared(checks: NonNullable<Parameters<typeof sdk.model>[0]["checks"]>): Declaration {
  sdk.model({ key: "core/customer", run: async () => {}, checks });

  return sdk.collect().assets["core/customer"]!;
}

describe("custom checks", () => {
  it("returns one schema-valid result per check, in name order", async () => {
    const results = await runChecks(
      declared({
        custom: {
          valid_email: {
            run: async ({ rows }) => {
              // Stands in for an async verifier: every row is awaited.
              const bad = (await Promise.all(rows.map((r) => Promise.resolve(r["email"])))).filter(
                (email) => typeof email !== "string" || !email.includes("@"),
              );

              return bad.length === 0
                ? { result: "pass" }
                : { result: "fail", detail: `${bad.length} invalid: ${bad.join(", ")}` };
            },
          },
          has_rows: {
            severity: "warn",
            run: ({ rows }) => ({ result: rows.length ? "pass" : "fail" }),
          },
        },
      }),
      ctx([{ email: "ada@example.com" }, { email: "not-an-email" }]),
    );

    expect(results).toEqual([
      { kind: "custom", name: "has_rows", severity: "warn", result: "pass", detail: null },
      {
        kind: "custom",
        name: "valid_email",
        severity: "block",
        result: "fail",
        detail: "1 invalid: not-an-email",
      },
    ]);

    for (const result of results) {
      expect(validateResult(result), JSON.stringify(validateResult.errors)).toBe(true);
    }
  });

  it("returns nothing when the asset declares no custom checks", async () => {
    expect(await runChecks(declared({ schema_contract: {} }), ctx([]))).toEqual([]);
  });

  it("logs each verdict through the check ctx", async () => {
    const logs: string[] = [];

    await runChecks(
      declared({ custom: { has_rows: { run: () => ({ result: "fail", detail: "empty" }) } } }),
      ctx([], logs),
    );

    expect(logs).toEqual(["check has_rows: fail (empty)"]);
  });

  it("lets a throwing check fail the attempt rather than the data", async () => {
    const declaration = declared({
      custom: {
        valid_email: {
          run: async () => {
            throw new Error("verifier ETIMEDOUT");
          },
        },
      },
    });

    // The runtime classifies this as retryable from the message; a verdict
    // would have recorded the data as bad instead.
    await expect(runChecks(declaration, ctx([]))).rejects.toThrow(/ETIMEDOUT/);
  });

  it("rejects a check that returns something other than a verdict", async () => {
    const declaration = declared({
      custom: { valid_email: { run: (() => true) as unknown as () => { result: "pass" } } },
    });

    await expect(runChecks(declaration, ctx([]))).rejects.toThrow(/returned true/);
    await expect(runChecks(declaration, ctx([]))).rejects.toThrow(/TerminalError|result: "pass"/);
  });
});
