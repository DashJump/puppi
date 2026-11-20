/**
 * The deploy verdict is the last thing printed. The build summary is only a
 * listing of what was uploaded; when it follows a rejection, the command
 * reads as a success.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Deployment } from "../src/api.js";
import { main } from "../src/index.js";
import { stubDeploy } from "./support/engine.js";
import { copyProjectFixture, removeProjectFixture } from "./support/project-fixture.js";

let fixture: string;

const rejected: Deployment = {
  id: "d1",
  status: "failed",
  active: false,
  git: { branch: "main", sha: "abc" },
  created_by: "cli",
  validation: {
    errors: [
      {
        kind: "unbound_connection",
        message: "connection warehouse is declared but environment prod has no binding for it",
        detail: { connection: "warehouse", environment: "prod" },
      },
    ],
    warnings: [],
  },
  allow_contract_changes: [],
  inserted_at: "2026-10-16T00:00:00Z",
};

let printed: { stream: "stdout" | "stderr"; text: string }[];

beforeEach(async () => {
  printed = [];
  delete process.env["PUPPI_SIGNING_KEY"];
  delete process.env["PUPPI_SIGNING_KEY_FILE"];

  const record =
    (stream: "stdout" | "stderr") =>
    (chunk: unknown): boolean => {
      printed.push({ stream, text: String(chunk) });
      return true;
    };

  vi.spyOn(process.stdout, "write").mockImplementation(record("stdout"));
  vi.spyOn(process.stderr, "write").mockImplementation(record("stderr"));
  fixture = await copyProjectFixture();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env["PUPPI_SIGNING_KEY"];
  delete process.env["PUPPI_SIGNING_KEY_FILE"];
  await removeProjectFixture(fixture);
});

describe("puppi deploy", () => {
  it("ends on the rejection and the commands that would bind the connection", async () => {
    stubRejected();

    expect(await deploy()).toBe(1);

    const text = printed.map((write) => write.text).join("");
    const summary = text.lastIndexOf("assets");
    const outcome = text.slice(summary);
    const rejection = "deployment d1 rejected; prod is unchanged";
    const bind = `puppi env bind warehouse --env prod --config '{"database":"YOUR_DATABASE"}' --secret-ref password=YOUR_PASSWORD`;

    expect(text.trimEnd().split("\n").at(-1)?.trim()).toBe(rejection);
    expect(summary).toBeGreaterThan(-1);
    expect(outcome).toContain("unbound_connection:");
    expect(outcome).toContain(bind);
    expect(outcome).toContain("puppi env secret YOUR_PASSWORD --env prod --from-env YOUR_PASSWORD");
    expect(printed.find((write) => write.text.includes(rejection))?.stream).toBe("stderr");
    expect(printed.find((write) => write.text.includes(bind))?.stream).toBe("stderr");
  });

  it("ends on the line that says the deployment was activated", async () => {
    stubDeploy();

    expect(await deploy()).toBe(0);

    const text = printed.map((write) => write.text).join("");
    const line = "deployed d1 and activated it in prod";

    expect(text.lastIndexOf("assets")).toBeLessThan(text.indexOf(line));
    expect(text.trimEnd().endsWith(line)).toBe(true);
  });

  it("creates the hosted default environment when --env and PUPPI_ENV are omitted", async () => {
    delete process.env["PUPPI_ENV"];
    const posted = stubDefaultEnvironment({ exists: false });

    expect(await deployDefault()).toBe(0);
    expect(posted).toEqual([{ name: "default", executor: "hosted", storage_prefix: "default" }]);
    expect(printed.map((write) => write.text).join("")).toContain(
      "deployed d1 and activated it in default",
    );
  });

  it("reuses the hosted default environment when it already exists", async () => {
    delete process.env["PUPPI_ENV"];
    const posted = stubDefaultEnvironment({ exists: true });

    expect(await deployDefault()).toBe(0);
    expect(posted).toEqual([]);
    expect(printed.map((write) => write.text).join("")).toContain(
      "deployed d1 and activated it in default",
    );
  });
});

function deploy(): Promise<number> {
  return main(["deploy", "--dir", fixture, "--env", "prod", "--engine-url", "http://engine:4000"]);
}

function deployDefault(): Promise<number> {
  return main(["deploy", "--dir", fixture, "--engine-url", "http://engine:4000"]);
}

/** `deploy` with no named environment. Records each `POST /environments` body. */
function stubDefaultEnvironment(options: { exists: boolean }): Record<string, unknown>[] {
  const posted: Record<string, unknown>[] = [];
  const existing = options.exists
    ? [{ name: "default", executor: "hosted", storage_prefix: "default" }]
    : [];

  vi.stubGlobal("fetch", async (input: string | URL, request?: RequestInit) => {
    const method = request?.method ?? "GET";
    const url = new URL(input);
    const path = url.pathname.replace("/api/v1", "");

    if (method === "GET" && path === "/environments") {
      return json(200, { data: existing });
    }

    if (method === "POST" && path === "/environments") {
      const raw = request?.body;

      if (typeof raw !== "string")
        throw new Error("POST /environments expected a JSON string body");

      const body = JSON.parse(raw) as Record<string, unknown>;

      posted.push(body);
      return json(201, {
        data: {
          name: body["name"],
          executor: body["executor"],
          storage_prefix: body["storage_prefix"],
        },
      });
    }

    if (method === "GET" && path === "/environments/default") {
      return json(200, {
        data: { executor: "hosted", name: "default", storage_prefix: "default" },
      });
    }

    if (method === "HEAD" && path.startsWith("/bundles/")) {
      return new Response(null, { status: 404 });
    }

    if (method === "PUT" && path.startsWith("/bundles/")) {
      return new Response(null, { status: 201 });
    }

    if (method === "POST" && path === "/environments/default/deployments") {
      return json(201, {
        data: {
          ...rejected,
          id: "d1",
          status: "ready",
          active: true,
          validation: { errors: [], warnings: [] },
        },
      });
    }

    return json(404, { error: "not found" });
  });

  return posted;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A 422 that still carries the deployment, which is how the engine refuses one. */
function stubRejected(): void {
  vi.stubGlobal("fetch", async (input: string | URL, request?: RequestInit) => {
    const method = request?.method ?? "GET";
    const url = new URL(input);

    if (method === "HEAD" && url.pathname.startsWith("/api/v1/bundles/")) {
      return new Response(null, { status: 404 });
    }

    if (method === "PUT" && url.pathname.startsWith("/api/v1/bundles/")) {
      return new Response(null, { status: 201 });
    }

    if (method === "POST" && url.pathname.endsWith("/deployments")) {
      return new Response(JSON.stringify({ data: rejected }), { status: 422 });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });
}
