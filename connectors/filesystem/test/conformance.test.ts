import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertConformant, formatConformance, runStorageConformance } from "@puppi/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "../src/index.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "puppi-conformance-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the filesystem adapter", () => {
  it("does everything it declares", async () => {
    const checks = await runStorageConformance({
      adapter: new Client({ root }),
      prefix: "conformance",
      sharedDigest: true,
    });

    expect(formatConformance(checks)).not.toContain("FAILED");
    // It implements drop and dropPrefix and returns a digest, so nothing is skipped.
    expect(checks.filter((check) => check.status === "skipped")).toEqual([]);
    assertConformant(checks);
  });
});
