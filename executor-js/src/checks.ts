/**
 * Runs custom checks after the write. A throw fails the attempt.
 * The engine decides `success` or `failed_by_check` from the results.
 */

import type { CheckCtx, CheckVerdict, Declaration } from "@puppi/sdk";

import { TerminalError } from "./errors.js";
import type { CheckResult } from "./protocol.js";

/**
 * Runs every custom check in name order. A throw fails the attempt
 * and is retried when it looks transient.
 */
export async function runChecks(declaration: Declaration, ctx: CheckCtx): Promise<CheckResult[]> {
  const checks = declaration.customChecks ?? {};
  const results: CheckResult[] = [];

  for (const name of Object.keys(checks).sort()) {
    const severity = declaration.checks.custom?.[name]?.severity ?? "block";
    const verdict = asVerdict(declaration.key, name, await checks[name]!(ctx));

    ctx.log(`check ${name}: ${verdict.result}${verdict.detail ? ` (${verdict.detail})` : ""}`);

    results.push({
      kind: "custom",
      name,
      severity,
      result: verdict.result,
      detail: verdict.detail ?? null,
    });
  }

  return results;
}

/** A check returning something other than a verdict is a bug in the check, not a data failure. */
function asVerdict(asset: string, name: string, value: unknown): CheckVerdict {
  if (
    typeof value === "object" &&
    value !== null &&
    "result" in value &&
    (value.result === "pass" || value.result === "fail") &&
    (!("detail" in value) || value.detail === undefined || typeof value.detail === "string")
  ) {
    return value as CheckVerdict;
  }

  throw new TerminalError(
    `check ${name} on ${asset} returned ${JSON.stringify(value)}; a check returns ` +
      `{ result: "pass" | "fail", detail?: string }`,
  );
}
