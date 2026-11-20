/**
 * `puppi env webhook`: one URL per environment, a secret shown once, a test event.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { main } from "../src/index.js";
import { type EngineCall, stubAnswers } from "./support/engine.js";

let calls: EngineCall[];
let stdout: string;
let stderr: string;

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
});

function run(...argv: string[]): Promise<number> {
  return main([...argv, "--engine-url", "http://engine:4000", "--env", "prod"]);
}

describe("puppi env webhook", () => {
  it("sets a url and prints the secret once", async () => {
    stubAnswers(
      {
        "PUT /environments/prod/webhook": {
          status: 200,
          body: {
            data: {
              url: "https://example.com/hooks",
              enabled: true,
              secret: "whsec",
              inserted_at: "2026-11-11T00:00:00Z",
            },
          },
        },
      },
      calls,
    );

    expect(await run("env", "webhook", "set", "--url", "https://example.com/hooks")).toBe(0);
    expect(calls[0]?.body).toEqual({ url: "https://example.com/hooks", enabled: true });
    expect(stdout).toContain("secret whsec");
    expect(stdout).toContain("https://example.com/hooks");
  });

  it("rotates without setting a url", async () => {
    stubAnswers(
      {
        "POST /environments/prod/webhook/rotation": {
          status: 200,
          body: {
            data: {
              url: "https://example.com/hooks",
              enabled: true,
              secret: "next",
              inserted_at: "2026-11-11T00:00:00Z",
            },
          },
        },
      },
      calls,
    );

    expect(await run("env", "webhook", "set", "--rotate")).toBe(0);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /environments/prod/webhook/rotation",
    ]);
    expect(stdout).toContain("secret next");
  });

  it("sends a test event and removes the webhook", async () => {
    stubAnswers(
      {
        "POST /environments/prod/webhook/test": { status: 200, body: { data: { ok: true } } },
        "DELETE /environments/prod/webhook": { status: 200, body: { data: { removed: true } } },
      },
      calls,
    );

    expect(await run("env", "webhook", "test")).toBe(0);
    expect(stdout).toContain("test event sent");

    stdout = "";
    expect(await run("env", "webhook", "rm")).toBe(0);
    expect(stdout).toContain("webhook removed");
  });

  it("refuses a url that is not https", async () => {
    expect(await run("env", "webhook", "set", "--url", "http://example.com/hooks")).toBe(2);
    expect(stderr).toContain("https://");
  });
});
