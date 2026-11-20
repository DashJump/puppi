/**
 * `puppi login`, `puppi whoami`, and `puppi logout` against a fake server.
 * The API key is stored and sent. It is not printed.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/index.js";

const spawn = vi.hoisted(() =>
  vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    return child;
  }),
);

vi.mock("node:child_process", async () => {
  const actual: Record<string, unknown> = await vi.importActual("node:child_process");

  return { ...actual, spawn };
});

const KEY = "pup_test_key_do_not_print";
const DEVICE = "device-code-do-not-print";

interface Call {
  method: string;
  url: string;
  authorization?: string;
  body?: unknown;
}

let calls: Call[];
let stdout: string;
let stderr: string;
let configDir: string;
let polls: number;

beforeEach(() => {
  calls = [];
  polls = 0;
  stdout = "";
  stderr = "";
  configDir = mkdtempSync(join(tmpdir(), "puppi-cfg-"));
  process.env["PUPPI_CONFIG_DIR"] = configDir;
  delete process.env["PUPPI_API_TOKEN"];
  delete process.env["PUPPI_ENGINE_URL"];
  spawn.mockClear();

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
  rmSync(configDir, { recursive: true, force: true });
  delete process.env["PUPPI_CONFIG_DIR"];
  delete process.env["PUPPI_API_TOKEN"];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function server(options: { tokenOn?: number; slow?: boolean } = {}): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = input;
    const authorization = header(init, "authorization");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

    calls.push({ method, url, ...(authorization ? { authorization } : {}), body });

    if (url.endsWith("/device/code")) {
      return json(200, {
        device_code: DEVICE,
        user_code: "ABCD-EFGH",
        verification_uri: "/device",
        verification_uri_complete: "/device?user_code=ABCD-EFGH",
        expires_in: 1800,
        interval: 0,
      });
    }

    if (url.endsWith("/device/token")) {
      polls += 1;

      if (options.slow && polls === 1) {
        return json(400, { error: "slow_down", error_description: "Slow down." });
      }

      if (options.tokenOn !== undefined && polls < options.tokenOn) {
        return json(400, { error: "authorization_pending", error_description: "Wait." });
      }

      return json(200, { access_token: KEY, token_type: "Bearer", expires_in: null });
    }

    if (url.endsWith("/api/v1/whoami")) {
      return json(200, {
        data: {
          user: { id: "usr_ada", email: "ada@example.com", name: "Ada" },
          tenant: { id: "ten_ada", name: "Ada", slug: "ada" },
        },
      });
    }

    if (url.endsWith("/api/v1/session") && method === "DELETE") {
      return json(200, { data: { revoked: true } });
    }

    return json(404, { error: "not found" });
  });
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;

  if (!headers || Array.isArray(headers) || headers instanceof Headers) return undefined;

  const value = headers[name];

  return typeof value === "string" ? value : undefined;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function configFile(): string {
  return join(configDir, "config.json");
}

function writeStored(savedServer: string): void {
  writeFileSync(configFile(), `${JSON.stringify({ server: savedServer, token: KEY })}\n`, {
    mode: 0o600,
  });
}

describe("puppi login", () => {
  it("prints the code, stores the key, and does not print the secret", async () => {
    server();

    expect(await main(["login", "--no-browser", "--engine-url", "http://engine:4000"])).toBe(0);
    expect(stdout).toContain("Code: ABCD-EFGH");
    expect(stdout).toContain("http://engine:4000/device?user_code=ABCD-EFGH");
    expect(stdout).toContain("Logged in to http://engine:4000");
    expect(stdout).not.toContain(KEY);
    expect(stdout).not.toContain(DEVICE);
    expect(stderr).not.toContain(KEY);
    expect(spawn).not.toHaveBeenCalled();

    const saved = JSON.parse(readFileSync(configFile(), "utf8")) as {
      server: string;
      token: string;
    };

    expect(saved).toEqual({ server: "http://engine:4000", token: KEY });
    expect(statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);

    const tokenCall = calls.find((call) => call.url.endsWith("/device/token"));

    expect(tokenCall?.body).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: DEVICE,
      client_id: "puppi",
    });
  });

  it("opens the browser when it can", async () => {
    server();

    expect(await main(["login", "--engine-url", "http://engine:4000"])).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      "xdg-open",
      ["http://engine:4000/device?user_code=ABCD-EFGH"],
      {
        stdio: "ignore",
        detached: true,
      },
    );
  });

  it("waits out slow_down and then stores the key", async () => {
    vi.useFakeTimers();
    server({ slow: true });

    const pending = main(["login", "--no-browser", "--engine-url", "http://engine:4000"]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toBe(0);
    expect(polls).toBe(2);
    expect(stdout).not.toContain(KEY);
    vi.useRealTimers();
  });
});

describe("puppi whoami", () => {
  it("uses the stored key", async () => {
    server();
    writeFileSync(
      configFile(),
      `${JSON.stringify({ server: "http://engine:4000", token: KEY })}\n`,
      { mode: 0o600 },
    );

    expect(await main(["whoami"])).toBe(0);
    expect(stdout).toContain("Ada <ada@example.com>");
    expect(stdout).toContain("Ada (ada)");
    expect(stdout).not.toContain(KEY);
    expect(calls[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.url).toBe("http://engine:4000/api/v1/whoami");
  });

  it("ignores PUPPI_API_TOKEN and uses the stored key", async () => {
    server();
    writeStored("http://engine:4000");
    process.env["PUPPI_API_TOKEN"] = "ci-token";

    expect(await main(["whoami", "--json"])).toBe(0);

    const printed = JSON.parse(stdout) as { user: { email: string }; server: string };

    expect(printed.user.email).toBe("ada@example.com");
    expect(printed.server).toBe("http://engine:4000");
    expect(calls[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(stdout).not.toContain("ci-token");
    expect(stdout).not.toContain(KEY);
  });

  it("uses https://app.puppi.dev when no server is configured or passed", async () => {
    server();
    writeStored("https://app.puppi.dev");

    expect(await main(["whoami"])).toBe(0);
    expect(calls[0]?.url).toBe("https://app.puppi.dev/api/v1/whoami");
    expect(calls[0]?.authorization).toBe(`Bearer ${KEY}`);
  });

  it("says to log in when nothing is stored", async () => {
    server();

    expect(await main(["whoami"])).toBe(1);
    expect(stderr).toContain("puppi login");
    expect(calls).toEqual([]);
  });

  it("does not send the stored key to another origin named by --engine-url", async () => {
    server();
    writeStored("http://engine:4000");

    expect(await main(["whoami", "--engine-url", "http://127.0.0.1:8765"])).toBe(1);
    expect(calls).toEqual([]);
    expect(stderr).not.toContain(KEY);
    expect(stdout).not.toContain(KEY);
  });

  it("does not send the stored key to another origin named by PUPPI_ENGINE_URL", async () => {
    server();
    writeStored("http://engine:4000");
    process.env["PUPPI_ENGINE_URL"] = "http://127.0.0.1:8765";

    expect(await main(["whoami"])).toBe(1);
    expect(calls).toEqual([]);
    expect(stderr).not.toContain(KEY);
  });

  it("sends the stored key when the named server has the same origin", async () => {
    server();
    writeStored("https://app.puppi.dev");

    expect(await main(["whoami", "--engine-url", "https://APP.puppi.dev:443"])).toBe(0);
    expect(calls[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.url).toBe("https://APP.puppi.dev:443/api/v1/whoami");
    expect(stdout).not.toContain(KEY);
  });

  it("does not send PUPPI_API_TOKEN to another origin", async () => {
    server();
    writeStored("http://engine:4000");
    process.env["PUPPI_API_TOKEN"] = "ci-token";
    process.env["PUPPI_ENGINE_URL"] = "http://127.0.0.1:8765";

    expect(await main(["whoami"])).toBe(1);
    expect(calls).toEqual([]);
    expect(stderr).toContain("puppi login");
    expect(stdout).not.toContain(KEY);
    expect(stderr).not.toContain("ci-token");
  });
});

describe("puppi logout", () => {
  it("revokes the stored key and deletes the file", async () => {
    server();
    writeFileSync(configFile(), JSON.stringify({ server: "http://engine:4000", token: KEY }));
    process.env["PUPPI_API_TOKEN"] = "ci-token";

    expect(await main(["logout"])).toBe(0);
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.url).toBe("http://engine:4000/api/v1/session");
    expect(stdout).toContain("Logged out of http://engine:4000");
    expect(stderr).not.toContain("PUPPI_API_TOKEN");
    expect(stdout).not.toContain(KEY);
    expect(stderr).not.toContain("ci-token");
    expect(() => statSync(configFile())).toThrow();
  });

  it("removes a corrupt login file", async () => {
    server();
    writeFileSync(configFile(), "{not json");

    expect(await main(["logout"])).toBe(0);
    expect(calls).toEqual([]);
    expect(stdout).toBe("saved credentials could not be read, so they were removed\n");
    expect(stderr).toBe("");
    expect(() => statSync(configFile())).toThrow();

    stdout = "";
    writeFileSync(configFile(), "{not json");

    expect(await main(["logout", "--json"])).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ revoked: false, removed: true });
    expect(stderr).toBe("");
    expect(calls).toEqual([]);
    expect(() => statSync(configFile())).toThrow();
  });

  it("does not call the server when nothing is stored", async () => {
    server();
    process.env["PUPPI_API_TOKEN"] = "ci-token";

    expect(await main(["logout"])).toBe(0);
    expect(calls).toEqual([]);
    expect(stdout).toContain("not logged in");
    expect(stderr).not.toContain("ci-token");
  });
});
