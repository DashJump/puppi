/**
 * `puppi doctor` over a fake engine. It reports every check, and a refused
 * token is not an unmigrated database.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sdkVersion } from "../src/bundle.js";
import { main } from "../src/index.js";
import { type EngineCall, type EngineReply, stubAnswers } from "./support/engine.js";

type Call = EngineCall;
type Answer = EngineReply;

let calls: Call[];
let stdout: string;
let stderr: string;

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/dev-project");

const ok = (body: unknown): Answer => ({ status: 200, body: { data: body } });

function engine(routes: Record<string, Answer>): void {
  stubAnswers(routes, calls);
}

const health = ok({ status: "ok", sdk_version: sdkVersion() });

function healthy(): Record<string, Answer> {
  return {
    "GET /health": health,
    "GET /environments": ok([]),
  };
}

function doctor(...argv: string[]): Promise<number> {
  return main(["doctor", "--dir", PROJECT, "--engine-url", "http://engine:4000", ...argv]);
}

beforeEach(() => {
  calls = [];
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("puppi doctor", () => {
  it("passes when the engine is up, migrated and speaking this project's SDK", async () => {
    engine(healthy());

    expect(await doctor()).toBe(0);
    expect(stdout).toContain("answered /health");
    expect(stdout).not.toContain("docker");
  });

  it("points at the engine that is not there, and exits 1", async () => {
    engine({});

    expect(await doctor()).toBe(1);
    expect(stdout).toContain("PUPPI_ENGINE_URL");
    expect(stdout).not.toContain("puppi dev");
  });

  it("names the token when the engine refuses it", async () => {
    engine({ "GET /health": { status: 401, body: { error: "unauthorized" } } });

    expect(await doctor()).toBe(1);
    expect(stdout).toContain("puppi login");
  });

  it("does not call a refused token an unmigrated database", async () => {
    engine({
      "GET /health": health,
      "GET /environments": { status: 401, body: { error: "unauthorized" } },
    });

    expect(await doctor()).toBe(1);
    expect(stdout).toContain("puppi login");
    expect(stdout).not.toContain("not migrated");
  });

  it("reports an SDK the engine cannot ingest", async () => {
    engine({ ...healthy(), "GET /health": ok({ status: "ok", sdk_version: "0.0.1" }) });

    expect(await doctor()).toBe(1);
    expect(stdout).toContain("the engine speaks 0.0.1");
  });

  it("reports every check at once, not the first failure", async () => {
    engine({
      "GET /health": health,
      "GET /environments": { status: 500, body: { error: "internal_server_error" } },
    });

    expect(await doctor()).toBe(1);
    expect(stdout).toContain("not migrated");
    expect(stdout).toContain("sdk version");
  });
});
