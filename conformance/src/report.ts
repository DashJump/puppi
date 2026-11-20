/** What every suite in this package returns, and how a test reads it. */

export interface ConformanceCheck {
  name: string;
  status: "passed" | "failed" | "skipped";
  /** Why it failed, or why it did not apply. */
  detail?: string;
}

/** Throws with a readable report unless every check passed or was skipped. */
export function assertConformant(checks: readonly ConformanceCheck[]): void {
  const failed = checks.filter((check) => check.status === "failed");

  if (failed.length === 0) return;

  throw new Error(
    `adapter is not conformant:\n${failed.map((check) => `  - ${check.name}: ${check.detail ?? "failed"}`).join("\n")}`,
  );
}

/** One line per check; what a failing CI run should print. */
export function formatConformance(checks: readonly ConformanceCheck[]): string {
  const mark = { passed: "ok", failed: "FAILED", skipped: "skipped" } as const;

  return checks
    .map(
      (check) => `${mark[check.status]}  ${check.name}${check.detail ? ` (${check.detail})` : ""}`,
    )
    .join("\n");
}

/** Runs one check body, turning a throw into a `failed` check. */
export async function run(name: string, body: () => Promise<void>): Promise<ConformanceCheck> {
  try {
    await body();
    return { name, status: "passed" };
  } catch (error: unknown) {
    return { name, status: "failed", detail: message(error) };
  }
}

export function equal(actual: unknown, expected: unknown, why: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);

  if (a !== b) throw new Error(`${why}: got ${a}, want ${b}`);
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
