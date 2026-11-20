import { describe, expect, it } from "vitest";

import { HttpStatusError, isTransient, NotFound, RateLimitError } from "../../src/index.js";

const TERMINAL = Symbol.for("puppi.terminal_error");

/** A bundled `TerminalError`: the brand, not this package's class. */
class TerminalError extends Error {
  override readonly name = "TerminalError";
  readonly [TERMINAL] = true;
}

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function withFields(message: string, fields: { code?: string; status?: number }): Error {
  return Object.assign(new Error(message), fields);
}

describe("isTransient", () => {
  it("retries the allowlisted node codes", () => {
    for (const code of [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "EPIPE",
      "EAI_AGAIN",
      "UND_ERR_SOCKET",
      "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
    ]) {
      expect(isTransient(withCode("boom", code))).toBe(true);
    }
  });

  it("retries undici's body cut short, as fetch raises it", () => {
    const cut = new TypeError("terminated", {
      cause: withCode(
        "Response body length does not match content-length header",
        "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
      ),
    });

    expect(isTransient(cut)).toBe(true);
  });

  it("retries connection, shutdown, and serialization SQLSTATEs", () => {
    for (const code of ["08006", "08001", "08P01", "57P01", "57P02", "57P03", "40001", "40P01"]) {
      expect(isTransient(withCode("postgres", code))).toBe(true);
    }

    expect(isTransient(withCode("duplicate key", "23505"))).toBe(false);
    expect(isTransient(withCode("undefined table", "42P01"))).toBe(false);
  });

  it("retries 429 and every 5xx, not the digits in a message", () => {
    for (const status of [429, 500, 501, 502, 503, 504]) {
      expect(isTransient({ status, message: "nope" })).toBe(true);
    }

    const badRequest = new HttpStatusError(
      "demo",
      400,
      "Bad Request",
      "https://api.example.com/v1/objects/503",
      "id 503",
    );

    expect(isTransient(badRequest)).toBe(false);
    expect(isTransient(new NotFound("https://api.example.com/v1/objects/503"))).toBe(false);
  });

  it("lets an unknown code fall through to the message", () => {
    const enotfound = new Error("demo unreachable at https://x: fetch failed", {
      cause: withCode("getaddrinfo ENOTFOUND x", "ENOTFOUND"),
    });
    const premature = new Error("demo unreachable at https://x: Premature close", {
      cause: withCode("Premature close", "ERR_STREAM_PREMATURE_CLOSE"),
    });

    expect(isTransient(enotfound)).toBe(true);
    expect(isTransient(premature)).toBe(true);
    expect(isTransient(withCode("socket timeout", "ESOCKETTIMEDOUT"))).toBe(true);
    expect(isTransient(withCode("no such file or directory", "ENOENT"))).toBe(false);
  });

  it("lets a settled status or SQLSTATE on the same object win", () => {
    expect(isTransient(withFields("reset", { code: "ECONNRESET", status: 400 }))).toBe(false);
    expect(isTransient(withFields("duplicate", { code: "23505", status: 503 }))).toBe(false);
    expect(isTransient(withFields("reset", { code: "ECONNRESET", status: 503 }))).toBe(true);
  });

  it("stops when cause points at the same error", () => {
    const loop = withCode("socket", "ECONNRESET");
    (loop as { cause?: unknown }).cause = loop;
    const fractional = { status: 500.5, message: "nope" };

    expect(isTransient(loop)).toBe(true);
    expect(isTransient(fractional)).toBe(false);
  });

  it("walks cause and stops at a terminal brand", () => {
    const reset = new Error("wrapper", { cause: withCode("socket", "ECONNRESET") });
    const nested = new Error("outer", {
      cause: new Error("middle", { cause: withCode("admin", "57P01") }),
    });
    const branded = new TerminalError("starting_after=500", {
      cause: withCode("socket", "ECONNRESET"),
    });

    expect(isTransient(reset)).toBe(true);
    expect(isTransient(nested)).toBe(true);
    expect(isTransient(branded)).toBe(false);
  });

  it("recognizes a bundled rate limit and a bundled NotFound", () => {
    const RATE_LIMIT = Symbol.for("puppi.rate_limit_error");
    const NOT_FOUND = Symbol.for("puppi.not_found");

    class BundledRateLimit extends Error {
      override readonly name = "RateLimitError";
      readonly [RATE_LIMIT] = true;
    }

    class BundledNotFound extends Error {
      override readonly name = "NotFound";
      readonly [NOT_FOUND] = true;

      constructor(url: string) {
        super(`nothing at ${url}`);
      }
    }

    expect(new BundledRateLimit("slow down") instanceof RateLimitError).toBe(false);
    expect(isTransient(new BundledRateLimit("slow down"))).toBe(true);
    expect(isTransient(new BundledNotFound("https://api.example.com/v1/objects/503"))).toBe(false);
  });

  it("does not retry a settled failure", () => {
    expect(isTransient(new Error("schema does not match"))).toBe(false);
    expect(isTransient(withCode("fetch failed", "23505"))).toBe(false);
  });

  it("falls back to the message only when no field is set", () => {
    expect(isTransient(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isTransient(new Error("source timeout"))).toBe(true);
    expect(isTransient(new Error("id 503 was not a status"))).toBe(true);
  });
});
