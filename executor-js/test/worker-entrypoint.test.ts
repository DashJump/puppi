import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

const entry = join(import.meta.dirname, "../bin/worker-entrypoint");

function run(env: Record<string, string | undefined>, args: string[]) {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
  }
  return spawnSync(entry, args, { env: merged, encoding: "utf8" });
}

describe("worker entrypoint", () => {
  it("fails closed before the command when the filter cannot be applied", () => {
    const dir = mkdtempSync(join(tmpdir(), "puppi-egress-"));
    const marker = join(dir, "ran");
    const result = run({ PUPPI_EGRESS_FILTER: "1" }, ["sh", "-c", `echo ran > ${marker}`]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/egress filter needs root|resolv.conf/);
    expect(existsSync(marker)).toBe(false);
  });

  it("leaves the filter off unless PUPPI_EGRESS_FILTER=1", () => {
    const result = run({ PUPPI_EGRESS_FILTER: undefined }, ["sh", "-c", "echo ran"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ran");
  });

  it("skips the filter when PUPPI_EGRESS_FILTER=0 and runs the command", () => {
    const result = run({ PUPPI_EGRESS_FILTER: "0" }, ["sh", "-c", "echo ran"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ran");
  });
});
