import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { HttpStatusError, RateLimitError } from "@puppi/sdk";
import { describe, expect, it } from "vitest";

import { errorEvent } from "../src/execute.js";

describe("errorEvent", () => {
  it("carries Retry-After from a rate limit and omits it otherwise", () => {
    const limited = new HttpStatusError(
      "demo",
      429,
      "Too Many Requests",
      "https://api.test/x",
      "",
      new Headers({ "retry-after": "120" }),
    );
    const body = new RateLimitError("slack answered /conversations.list with ratelimited", 4_000);
    const unavailable = new HttpStatusError(
      "demo",
      503,
      "Service Unavailable",
      "https://api.test/x",
      "down",
    );

    expect(errorEvent(limited)).toEqual({
      event: "error",
      class: "retryable",
      message: limited.message,
      retry_after_ms: 120_000,
    });
    expect(errorEvent(body)).toEqual({
      event: "error",
      class: "retryable",
      message: body.message,
      retry_after_ms: 4_000,
    });
    expect(errorEvent(unavailable)).toEqual({
      event: "error",
      class: "retryable",
      message: unavailable.message,
    });
  });

  it("honors Retry-After on a 503 and does not read it from a cause", () => {
    const waited = new HttpStatusError(
      "demo",
      503,
      "Service Unavailable",
      "https://api.test/x",
      "down",
      new Headers({ "retry-after": "120" }),
    );
    const bare = new HttpStatusError(
      "demo",
      503,
      "Service Unavailable",
      "https://api.test/x",
      "down",
    );
    (bare as { cause?: unknown }).cause = { retryAfterMs: 120_000 };

    expect(errorEvent(waited)).toEqual({
      event: "error",
      class: "retryable",
      message: waited.message,
      retry_after_ms: 120_000,
    });
    expect(errorEvent(bare).retry_after_ms).toBeUndefined();
  });

  it("reads Retry-After from the copy a bundle inlines", () => {
    const HTTP_STATUS = Symbol.for("puppi.http_status_error");
    const RATE_LIMIT = Symbol.for("puppi.rate_limit_error");

    class BundledRateLimit extends Error {
      override readonly name = "RateLimitError";
      readonly [RATE_LIMIT] = true;
      readonly retryAfterMs: number;

      constructor(message: string, waitMs: number) {
        super(message);
        this.retryAfterMs = waitMs;
      }
    }

    const limited = Object.assign(
      new Error("demo answered 429 Too Many Requests for https://api.test/x"),
      {
        [HTTP_STATUS]: true,
        status: 429,
        retryAfterMs: 120_000,
      },
    );
    const body = new BundledRateLimit("slack answered /conversations.list with ratelimited", 4_000);
    const lookalike = Object.assign(new Error("demo answered 429"), {
      name: "HttpStatusError",
      status: 429,
      retryAfterMs: 120_000,
    });

    expect(limited instanceof HttpStatusError).toBe(false);
    expect(body instanceof RateLimitError).toBe(false);
    expect(errorEvent(limited)).toEqual({
      event: "error",
      class: "retryable",
      message: limited.message,
      retry_after_ms: 120_000,
    });
    expect(errorEvent(body)).toEqual({
      event: "error",
      class: "retryable",
      message: body.message,
      retry_after_ms: 4_000,
    });
    expect(errorEvent(lookalike).retry_after_ms).toBeUndefined();
  });

  it("names each cause and the socket a dropped body came from", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-length": "1000000" });
      response.write(Buffer.alloc(1000));
      setTimeout(() => response.socket?.destroy(), 20);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const error = await new Response((await fetch(`http://127.0.0.1:${port}`)).body)
        .arrayBuffer()
        .catch((caught: unknown) => caught);
      const event = errorEvent(error);

      expect(event.message).toMatch(
        /^terminated; cause: SocketError UND_ERR_SOCKET: other side closed/,
      );
      expect(event.message).toMatch(new RegExp(`\\(private:${port}, \\d+ bytes read\\)$`));
      expect(event.message).not.toContain("127.0.0.1");
      expect(event.message).not.toContain("->");
    } finally {
      server.close();
    }
  });

  it("keeps a plain error as is and skips a cause the message already holds", () => {
    const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const outer = new Error(`object-store unreachable: ${inner.message}`, { cause: inner });

    expect(errorEvent(new Error("boom")).message).toBe("boom");
    expect(errorEvent(outer).message).toBe(
      "object-store unreachable: socket hang up; cause: Error ECONNRESET",
    );

    const parse = new Error("unsupported root <?xml-stylesheet>");
    const wrapped = new Error(`podcast-rss could not parse: ${parse.message}`, { cause: parse });
    const unreachable = new Error(`podcast-rss unreachable: ${wrapped.message}`, {
      cause: wrapped,
    });

    expect(errorEvent(unreachable).message).toBe(unreachable.message);
  });

  it("prints private for a loopback, link-local, RFC1918, or ULA address", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fe80::1",
      "fe80::1%eth0",
      "fc00::1",
      "::ffff:10.0.0.1",
    ]) {
      const message = errorEvent(socketCause(address)).message;

      expect(message).toContain("(private:443, 4 bytes read)");
      expect(message).not.toContain(address.split("%")[0] ?? address);
    }

    expect(errorEvent(socketCause("8.8.8.8")).message).toContain("(8.8.8.8:443, 4 bytes read)");
    expect(errorEvent(socketCause("2001:4860:4860::8888")).message).toContain(
      "(2001:4860:4860::8888:443, 4 bytes read)",
    );
  });

  it("prints private for a this-host, CGNAT, hex-mapped, or NAT64 address", () => {
    for (const address of [
      "0.0.0.0",
      "0.1.2.3",
      "100.64.0.1",
      "100.127.255.254",
      "::ffff:a00:1",
      "::ffff:7f00:1",
      "64:ff9b::a00:1",
      "64:ff9b::7f00:1",
    ]) {
      const message = errorEvent(socketCause(address)).message;

      expect(message).toContain("(private:443, 4 bytes read)");
      expect(message).not.toContain(address);
    }

    expect(errorEvent(socketCause("100.128.0.1")).message).toContain(
      "(100.128.0.1:443, 4 bytes read)",
    );
    expect(errorEvent(socketCause("::ffff:808:808")).message).toContain(
      "(::ffff:808:808:443, 4 bytes read)",
    );
    expect(errorEvent(socketCause("64:ff9b::808:808")).message).toContain(
      "(64:ff9b::808:808:443, 4 bytes read)",
    );
  });

  it("redacts userinfo and sensitive query values in a cause", () => {
    const cause = new Error(
      "fetch failed https://ada:s3cret@files.test/a?token=abc&page=2&api_key=k&sig=s",
    );
    const message = errorEvent(new Error("download failed", { cause })).message;

    expect(message).toContain(
      "https://redacted@files.test/a?token=redacted&page=2&api_key=redacted&sig=redacted",
    );
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("token=abc");
  });

  it("redacts password parameters, encoded names, and a password that contains @", () => {
    const cause = new Error(
      "fetch failed user:p@ss@files.test/a?password=hunter2&passwd=w&pwd=p&auth=a&credential=c&code=oauth&api%5Fkey=k&page=2 https://u:a@b@files.test/x",
    );
    const message = errorEvent(new Error("download failed", { cause })).message;

    expect(message).toContain(
      "redacted@files.test/a?password=redacted&passwd=redacted&pwd=redacted&auth=redacted&credential=redacted&code=redacted&api%5Fkey=redacted&page=2 https://redacted@files.test/x",
    );
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("p@ss");
    expect(message).not.toContain("a@b");
    expect(message).not.toContain("oauth");
  });
});

function socketCause(address: string): Error {
  const cause = Object.assign(new Error("other side closed"), {
    code: "UND_ERR_SOCKET",
    socket: { remoteAddress: address, remotePort: 443, bytesRead: 4 },
  });

  return Object.assign(new TypeError("terminated"), { cause });
}
