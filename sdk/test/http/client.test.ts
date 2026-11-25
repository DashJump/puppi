import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isRateLimited, requestStream } from "../../src/http/client.js";
import {
  authHeaders,
  chunk,
  eachPage,
  ExpiredPageToken,
  HttpStatusError,
  isExpiredPageToken,
  isTransient,
  JsonClient,
  linkHref,
  NotFound,
  query,
  RateLimitError,
  requestJson,
  requireApiVersion,
  retryAfterMs,
  TerminalError,
} from "../../src/index.js";

function fake(handler: (url: URL, init: RequestInit) => unknown) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const body = handler(url, init ?? {});

    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  return { calls, fetchImpl };
}

describe("isTransient", () => {
  it("classifies typed HTTP errors by status, not by digits in the url", () => {
    const missing = new NotFound("https://api.example.com/v1/objects/500");
    const badRequest = new HttpStatusError(
      "demo",
      400,
      "Bad Request",
      "https://api.example.com/v1/search?q=500",
      "",
    );
    const timedOutUrl = new HttpStatusError(
      "demo",
      400,
      "Bad Request",
      "https://api.example.com/v1/search?q=timeout",
      "",
    );
    const unavailable = new HttpStatusError(
      "demo",
      503,
      "Service Unavailable",
      "https://api.example.com/v1/search",
      "down",
    );
    const tooMany = new HttpStatusError(
      "demo",
      429,
      "Too Many Requests",
      "https://api.example.com/v1/search",
      "",
    );

    expect(isTransient(missing)).toBe(false);
    expect(isTransient(badRequest)).toBe(false);
    expect(isTransient(timedOutUrl)).toBe(false);
    expect(isTransient(unavailable)).toBe(true);
    expect(isTransient(tooMany)).toBe(true);
    expect(
      isTransient(new RateLimitError("slack answered https://slack.test/api with ratelimited")),
    ).toBe(true);
    expect(isTransient(new Error("unreachable at https://x: fetch failed"))).toBe(true);
    expect(isTransient(new Error("source timeout"))).toBe(true);
    expect(isTransient(new Error("terminating connection due to administrator command"))).toBe(
      true,
    );
    expect(isTransient(new Error("Minutely API request limit exceeded"))).toBe(true);
    expect(isRateLimited(unavailable)).toBe(false);
    expect(isRateLimited(new NotFound("https://api.example.com/v1/objects/429"))).toBe(false);
    expect(isRateLimited("ratelimited")).toBe(true);
    expect(isRateLimited("rate_limited")).toBe(true);
  });
});

describe("retryAfterMs", () => {
  it("reads delta-seconds and an HTTP-date", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "3" }))).toBe(3_000);
    expect(retryAfterMs(new Headers({ "Retry-After": "0" }))).toBe(0);

    const now = Date.parse("Wed, 21 Oct 2015 07:27:00 GMT");

    expect(retryAfterMs(new Headers({ "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }), now)).toBe(
      60_000,
    );
    expect(retryAfterMs(new Headers({ "retry-after": "Wed, 21 Oct 2015 07:26:00 GMT" }), now)).toBe(
      0,
    );
    expect(retryAfterMs(new Headers())).toBeNull();
    expect(retryAfterMs(new Headers({ "retry-after": "soon" }))).toBeNull();
  });
});

describe("isExpiredPageToken", () => {
  it("matches a dead cursor and not a bad query or a 500", () => {
    const dead = new HttpStatusError(
      "demo",
      400,
      "Bad Request",
      "https://api.test/x",
      "invalid page token",
    );
    const badQuery = new HttpStatusError(
      "demo",
      400,
      "Bad Request",
      "https://api.test/x",
      "no such field",
    );
    const outage = new HttpStatusError(
      "demo",
      500,
      "Internal Server Error",
      "https://api.test/x",
      "invalid page token",
    );

    expect(isExpiredPageToken(dead)).toBe(true);
    expect(isExpiredPageToken(new ExpiredPageToken(dead.message))).toBe(true);
    expect(isExpiredPageToken(badQuery)).toBe(false);
    expect(isExpiredPageToken(outage)).toBe(false);
    expect(isExpiredPageToken(new NotFound("https://api.test/x"))).toBe(false);
    expect(isExpiredPageToken(dead, () => false)).toBe(false);
    expect(isExpiredPageToken(outage, () => true)).toBe(true);
  });

  it("recognizes the copy a bundle inlines, and a lookalike does not drop the page", () => {
    const EXPIRED = Symbol.for("puppi.expired_page_token");
    const HTTP_STATUS = Symbol.for("puppi.http_status_error");

    class BundledExpiredPageToken extends Error {
      override readonly name = "ExpiredPageToken";
      readonly [EXPIRED] = true;
    }

    class BundledHttpStatusError extends Error {
      override readonly name = "HttpStatusError";
      readonly [HTTP_STATUS] = true;
      readonly status: number;

      constructor(status: number, body: string) {
        super(`demo answered ${status}: ${body}`);
        this.status = status;
      }
    }

    const token = new BundledExpiredPageToken("invalid page token");
    const dead = new BundledHttpStatusError(400, "invalid page token");
    const lookalike = Object.assign(new Error("invalid page token"), {
      name: "HttpStatusError",
      status: 400,
    });

    expect(token instanceof ExpiredPageToken).toBe(false);
    expect(dead instanceof HttpStatusError).toBe(false);
    expect(isExpiredPageToken(token)).toBe(true);
    expect(isExpiredPageToken(dead)).toBe(true);
    expect(isExpiredPageToken(lookalike)).toBe(false);
    expect(isExpiredPageToken({ name: "ExpiredPageToken" })).toBe(false);
  });

  it("finds a bundled token on the cause, unless the outer error wins", () => {
    const EXPIRED = Symbol.for("puppi.expired_page_token");
    const NOT_FOUND = Symbol.for("puppi.not_found");
    const TERMINAL = Symbol.for("puppi.terminal_error");

    class BundledExpiredPageToken extends Error {
      override readonly name = "ExpiredPageToken";
      readonly [EXPIRED] = true;
    }

    class BundledNotFound extends Error {
      override readonly name = "NotFound";
      readonly [NOT_FOUND] = true;

      constructor(url: string) {
        super(`nothing at ${url}`);
      }
    }

    const token = new BundledExpiredPageToken("invalid page token");
    const wrapped = new Error("fetch failed", { cause: token });
    const missing = new BundledNotFound("https://api.test/objects/503");
    (missing as { cause?: unknown }).cause = token;
    const terminal = Object.assign(new Error("schema mismatch"), {
      [TERMINAL]: true,
      cause: token,
    });

    expect(isExpiredPageToken(wrapped)).toBe(true);
    expect(isExpiredPageToken(missing)).toBe(false);
    expect(isExpiredPageToken(terminal)).toBe(false);
    expect(isTransient(missing)).toBe(false);
  });

  it("stops when an expired token's cause is itself", () => {
    const token = new ExpiredPageToken("invalid page token");
    (token as { cause?: unknown }).cause = token;

    expect(isExpiredPageToken(token)).toBe(true);
    expect(isRateLimited({ status: 429.2, message: "nope" })).toBe(false);
  });
});

/** Fake timers cover the clock the client sleeps on, and leave the socket clock alone. */
function useWaitTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}

/** Records how `pending` settles, so a retry can fail before the test awaits it. */
function watch<T>(pending: Promise<T>): {
  outcome?: { ok: true; value: T } | { ok: false; error: unknown };
} {
  const box: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};

  void pending.then(
    (value) => {
      box.outcome = { ok: true, value };
    },
    (error: unknown) => {
      box.outcome = { ok: false, error };
    },
  );

  return box;
}

function take<T>(box: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } }): T {
  if (!box.outcome) throw new Error("the call did not finish");
  if (!box.outcome.ok) throw box.outcome.error;

  return box.outcome.value;
}

/** Runs `start` and advances the resume waits until the call settles. */
async function drive<T>(start: () => Promise<T>): Promise<T> {
  useWaitTimers();

  try {
    const box = watch(start());

    for (let step = 0; step < 200 && box.outcome === undefined; step++) {
      await vi.advanceTimersByTimeAsync(step === 0 ? 0 : 500);
    }

    return take(box);
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("JsonClient transient retries", () => {
  class Probe extends JsonClient {
    constructor(fetchImpl: typeof fetch) {
      super({}, { fetch: fetchImpl }, { api: "demo", baseUrl: "https://api.test" });
    }

    read(): Promise<unknown> {
      return this.get("/x");
    }

    write(method: "POST" | "PUT" | "PATCH" | "DELETE") {
      return this.send("/x", { method, ...(method === "DELETE" ? {} : { body: { a: 1 } }) });
    }

    fail(error: unknown): Promise<unknown> {
      return this.retryRateLimit(async () => {
        throw error;
      }, "GET");
    }
  }

  function probe(fetchImpl: typeof fetch): Probe {
    return new Probe(fetchImpl);
  }

  it("retries a 503 and then returns the body", async () => {
    useWaitTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      if (calls === 1) {
        return new Response("down", { status: 503, statusText: "Service Unavailable" });
      }

      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as typeof fetch;

    const pending = watch(probe(fetchImpl).read());

    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(take(pending)).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it("waits out a 429, honoring Retry-After, then returns the body", async () => {
    useWaitTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      if (calls === 1) {
        return new Response("slow", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "2" },
        });
      }

      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as typeof fetch;

    const pending = watch(probe(fetchImpl).read());

    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(take(pending)).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it("uses the backoff when a 429 carries no Retry-After", async () => {
    useWaitTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      if (calls < 3) return new Response("slow", { status: 429, statusText: "Too Many Requests" });

      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as typeof fetch;

    const pending = watch(probe(fetchImpl).read());

    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(take(pending)).toEqual({ ok: 1 });
    expect(calls).toBe(3);
  });

  it("does not sleep a Retry-After that would blow the attempt budget", async () => {
    useWaitTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      return new Response("slow", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "120" },
      });
    }) as typeof fetch;

    const pending = watch(probe(fetchImpl).read());

    await vi.advanceTimersByTimeAsync(0);
    expect(() => take(pending)).toThrow(/answered 429/);
    expect(calls).toBe(1);
  });

  it("stops once the waits already spent leave no room for the next Retry-After", async () => {
    useWaitTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      return new Response("slow", {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "20" },
      });
    }) as typeof fetch;

    const pending = watch(probe(fetchImpl).read());

    await vi.advanceTimersByTimeAsync(19_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(() => take(pending)).toThrow(/answered 429/);
    expect(calls).toBe(2);
  });

  it("propagates a 429 once the backoff waits are spent", async () => {
    useWaitTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      return new Response("slow", { status: 429, statusText: "Too Many Requests" });
    }) as typeof fetch;

    const pending = watch(probe(fetchImpl).read());

    await vi.advanceTimersByTimeAsync(14_999);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(() => take(pending)).toThrow(/answered 429/);
    expect(calls).toBe(4);
  });

  it("propagates a 503 once the transient waits are spent", async () => {
    useWaitTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      return new Response("down", { status: 503, statusText: "Service Unavailable" });
    }) as typeof fetch;

    const pending = watch(probe(fetchImpl).read());

    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(() => take(pending)).toThrow(/answered 503/);
    expect(calls).toBe(3);
  });

  it("retries a request timeout and then returns the body", async () => {
    useWaitTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      if (calls === 1) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }

      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as typeof fetch;

    const pending = watch(probe(fetchImpl).read());

    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(take(pending)).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it("does not retry a bad request, a 401, a 404, or a dropped socket", async () => {
    const bad = (async () =>
      new Response("nope", { status: 400, statusText: "Bad Request" })) as typeof fetch;
    const unauthorized = (async () =>
      new Response("no", { status: 401, statusText: "Unauthorized" })) as typeof fetch;
    const missing = (async () => new Response("", { status: 404 })) as typeof fetch;
    let resets = 0;
    const reset = (async () => {
      resets += 1;
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    }) as typeof fetch;

    await expect(probe(bad).read()).rejects.toThrow(/answered 400/);
    await expect(probe(unauthorized).read()).rejects.toThrow(/answered 401/);
    await expect(probe(missing).read()).rejects.toThrow(NotFound);
    await expect(probe(reset).read()).rejects.toThrow(/unreachable/);
    expect(resets).toBe(1);
  });

  it("does not retry POST or PATCH", async () => {
    let posts = 0;
    let patches = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") patches += 1;
      else posts += 1;

      return new Response("down", { status: 503, statusText: "Service Unavailable" });
    }) as typeof fetch;

    const client = probe(fetchImpl);

    await expect(client.write("POST")).rejects.toThrow(/answered 503/);
    await expect(client.write("PATCH")).rejects.toThrow(/answered 503/);
    expect(posts).toBe(1);
    expect(patches).toBe(1);
  });

  it("does not retry a 503 on PUT or DELETE", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");

      return new Response("down", { status: 503, statusText: "Service Unavailable" });
    }) as typeof fetch;

    const client = probe(fetchImpl);

    await expect(client.write("PUT")).rejects.toThrow(/answered 503/);
    await expect(client.write("DELETE")).rejects.toThrow(/answered 503/);
    expect(calls).toEqual(["PUT", "DELETE"]);
  });

  it("does not retry an expired page token or a terminal error", async () => {
    let calls = 0;

    class Counting extends Probe {
      override fail(error: unknown): Promise<unknown> {
        return this.retryRateLimit(async () => {
          calls += 1;
          throw error;
        }, "GET");
      }
    }

    const client = new Counting(fetch);
    const cause = new HttpStatusError(
      "demo",
      500,
      "Internal Server Error",
      "https://api.test/x",
      "invalid page token",
    );
    const token = new ExpiredPageToken(cause.message, { cause });

    await expect(client.fail(token)).rejects.toBe(token);
    await expect(client.fail(new TerminalError("demo answered 503"))).rejects.toThrow(
      TerminalError,
    );
    expect(calls).toBe(2);
  });

  it("does not wait out a 503 once the 30s budget is spent", async () => {
    useWaitTimers();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;

      if (calls === 1) {
        return new Response("slow", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "30" },
        });
      }

      return new Response("down", { status: 503, statusText: "Service Unavailable" });
    }) as typeof fetch;

    const pending = watch(probe(fetchImpl).read());

    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(() => take(pending)).toThrow(/answered 503/);
    expect(calls).toBe(2);
  });
});

describe("requestJson", () => {
  it("returns the parsed body and the response headers", async () => {
    const { calls, fetchImpl } = fake(
      () =>
        new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { link: '<https://api.test/p2>; rel="next"' },
        }),
    );

    const result = await requestJson(fetchImpl, "https://api.test/p1", { api: "demo" });

    expect(result.data).toEqual({ ok: 1 });
    expect(calls[0]?.headers["user-agent"]).toMatch(/^puppi-adapter-demo/);
    expect(calls[0]?.headers["accept"]).toBe("application/json");
    expect(linkHref(result.headers, "next")).toBe("https://api.test/p2");
    expect(linkHref(result.headers, "prev")).toBeNull();
  });

  it("names the status on a refusal and does not wait", async () => {
    const { calls, fetchImpl } = fake(
      () => new Response("slow", { status: 429, statusText: "Too Many" }),
    );

    await expect(requestJson(fetchImpl, "https://x.test/a", { api: "demo" })).rejects.toThrow(
      "demo answered 429 Too Many for https://x.test/a: slow",
    );
    expect(calls).toHaveLength(1);
  });

  it("reports a 404 as NotFound and a network failure as unreachable", async () => {
    const missing = fake(() => new Response("", { status: 404 }));
    await expect(
      requestJson(missing.fetchImpl, "https://x.test/a", { api: "demo" }),
    ).rejects.toThrow(NotFound);

    const down = (() => Promise.reject(new Error("fetch failed"))) as unknown as typeof fetch;
    await expect(requestJson(down, "https://x.test/a", { api: "demo" })).rejects.toThrow(
      /demo unreachable at https:\/\/x.test\/a: fetch failed/,
    );
  });

  it("aborts a fetch that outlives timeoutMs", async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;

      if (!signal) throw new Error("missing abort signal");

      await new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason));
      });

      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const started = Date.now();

    await expect(
      requestJson(fetchImpl, "https://api.test/x", { api: "demo", timeoutMs: 30 }),
    ).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("posts a JSON body", async () => {
    const { calls, fetchImpl } = fake(() => ({ id: "cus_1" }));

    await requestJson(fetchImpl, "https://api.test/customers", {
      api: "demo",
      method: "POST",
      body: { email: "a@example.com" },
    });

    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });
});

describe("requestStream", () => {
  it("returns the body as bytes, with the user agent and no json accept", async () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 0, 1]);
    const { calls, fetchImpl } = fake(() => new Response(bytes));

    const stream = await requestStream(fetchImpl, "https://files.test/a.tgz", { api: "demo" });

    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(bytes);
    expect(calls[0]?.headers["user-agent"]).toMatch(/^puppi-adapter-demo/);
    expect(calls[0]?.headers).not.toHaveProperty("accept");
  });

  it("throws NotFound on 404 and HttpStatusError on another refusal", async () => {
    const missing = fake(() => new Response("", { status: 404 }));
    await expect(
      requestStream(missing.fetchImpl, "https://files.test/a", { api: "demo" }),
    ).rejects.toThrow(NotFound);

    const refused = fake(() => new Response("no", { status: 403, statusText: "Forbidden" }));
    await expect(
      requestStream(refused.fetchImpl, "https://files.test/a", { api: "demo" }),
    ).rejects.toThrow(HttpStatusError);
  });

  it("does not time out a body that streams past timeoutMs", async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          async start(controller) {
            await new Promise((resolve) => setTimeout(resolve, 60));

            if (init?.signal?.aborted) controller.error(init.signal.reason);
            else controller.enqueue(new Uint8Array([7]));

            controller.close();
          },
        }),
      )) as typeof fetch;

    const stream = await requestStream(fetchImpl, "https://files.test/a", {
      api: "demo",
      timeoutMs: 20,
    });

    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(new Uint8Array([7]));
  });
});

/** Reads the whole stream, advancing the resume waits without a real pause. */
function readAll(url: string): Promise<Uint8Array> {
  return drive(async () => {
    const stream = await requestStream(fetch, url, { api: "demo" });

    return new Uint8Array(await new Response(stream).arrayBuffer());
  });
}

describe("requestStream resume", () => {
  const BODY = Uint8Array.from({ length: 300_000 }, (_, i) => i % 251);

  /** Serves `BODY`, cutting the response at each offset in `cuts` once. */
  async function host(options: {
    cuts: number[];
    how?: "destroy" | "end";
    ranges?: boolean;
    etag?: string | null;
    encoding?: string;
    rangeEncoding?: string;
    body?: Uint8Array;
    contentRange?: (from: number, length: number) => string;
    contentLength?: boolean;
    clip?: number;
  }) {
    const body = options.body ?? BODY;
    const cuts = [...options.cuts];
    const seen: { range: string | undefined; ifRange: string | undefined }[] = [];
    const server = createServer((request, response) => {
      seen.push({
        range: request.headers.range,
        ifRange: request.headers["if-range"] as string | undefined,
      });
      const asked = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
      const from = asked && options.ranges !== false ? Number(asked[1]) : 0;
      const etag = options.etag === undefined ? '"v1"' : options.etag;
      const encoding = from > 0 && options.rangeEncoding ? options.rangeEncoding : options.encoding;

      response.writeHead(from > 0 ? 206 : 200, {
        ...(options.contentLength === false
          ? {}
          : { "content-length": String(body.length - from) }),
        ...(etag ? { etag } : {}),
        ...(encoding ? { "content-encoding": encoding } : {}),
        ...(from > 0
          ? {
              "content-range":
                options.contentRange?.(from, body.length) ??
                `bytes ${from}-${body.length - 1}/${body.length}`,
            }
          : {}),
      });

      if (from > 0 && options.clip !== undefined) {
        response.end(body.subarray(from, from + options.clip));
        return;
      }

      const cut = cuts.find((at) => at > from);

      if (cut === undefined) {
        response.end(body.subarray(from));
        return;
      }

      cuts.splice(cuts.indexOf(cut), 1);
      response.write(body.subarray(from, cut), () => {
        if (options.how === "end") response.socket?.end();
        else response.socket?.destroy();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    return { url: `http://127.0.0.1:${port}/dump.tgz`, seen, close: () => server.close() };
  }

  it("resumes a dropped socket and a short body from the byte they stopped at", async () => {
    const dropped = await host({ cuts: [70_000, 200_000] });
    const short = await host({ cuts: [120_000], how: "end" });

    try {
      expect(await readAll(dropped.url)).toEqual(BODY);
      expect(dropped.seen).toEqual([
        { range: undefined, ifRange: undefined },
        { range: "bytes=70000-", ifRange: '"v1"' },
        { range: "bytes=200000-", ifRange: '"v1"' },
      ]);

      expect(await readAll(short.url)).toEqual(BODY);
      expect(short.seen[1]).toEqual({ range: "bytes=120000-", ifRange: '"v1"' });
    } finally {
      dropped.close();
      short.close();
    }
  });

  it("raises the drop when a gzip response is cut short", async () => {
    const encoded = await host({
      cuts: [80],
      encoding: "gzip",
      body: gzipSync(BODY),
    });

    try {
      await expect(readAll(encoded.url)).rejects.toThrow("terminated");
      expect(encoded.seen).toEqual([{ range: undefined, ifRange: undefined }]);
    } finally {
      encoded.close();
    }
  });

  it("raises the drop when the resumed 206 is gzip-encoded", async () => {
    const resumed = await host({ cuts: [70_000], rangeEncoding: "gzip" });

    try {
      await expect(readAll(resumed.url)).rejects.toThrow("terminated");
      expect(resumed.seen).toEqual([
        { range: undefined, ifRange: undefined },
        { range: "bytes=70000-", ifRange: '"v1"' },
      ]);
    } finally {
      resumed.close();
    }
  });

  it("raises the drop when a 206 stops at bytes 70000-70009/100000", async () => {
    const body = Uint8Array.from({ length: 100_000 }, (_, i) => i % 251);
    const partial = await host({
      cuts: [70_000],
      body,
      contentRange: (from) => `bytes ${from}-${from + 9}/100000`,
    });

    try {
      await expect(readAll(partial.url)).rejects.toThrow("terminated");
      expect(partial.seen).toEqual([
        { range: undefined, ifRange: undefined },
        { range: "bytes=70000-", ifRange: '"v1"' },
      ]);
    } finally {
      partial.close();
    }
  });

  it("raises the drop when a response with no content-length ends short of its total", async () => {
    const whole = await host({ cuts: [], contentLength: false });
    const short = await host({ cuts: [70_000], contentLength: false, clip: 10 });

    try {
      expect(await readAll(whole.url)).toEqual(BODY);
      await expect(readAll(short.url)).rejects.toThrow("download ended at 70010 of 300000 bytes");
      expect(short.seen).toHaveLength(2);
    } finally {
      whole.close();
      short.close();
    }
  });

  it("raises the drop when the 206 range disagrees", async () => {
    const short = await host({
      cuts: [70_000],
      contentRange: (from) => `bytes ${from}-${from + 9}/999`,
    });
    const otherTotal = await host({
      cuts: [70_000],
      contentRange: (from, length) => `bytes ${from}-${length - 1}/${length + 5}`,
    });

    try {
      await expect(readAll(short.url)).rejects.toThrow("terminated");
      expect(short.seen).toHaveLength(2);

      await expect(readAll(otherTotal.url)).rejects.toThrow("terminated");
      expect(otherTotal.seen).toHaveLength(2);
    } finally {
      short.close();
      otherTotal.close();
    }
  });

  it("raises the drop after 20 resumes that each bring a byte", async () => {
    const drip = await host({ cuts: Array.from({ length: 21 }, (_, index) => index + 1) });

    try {
      await expect(readAll(drip.url)).rejects.toThrow("terminated");
      expect(drip.seen).toHaveLength(21);
    } finally {
      drip.close();
    }
  });

  it("raises the drop when the host ignores the range or has no validator", async () => {
    const ignores = await host({ cuts: [70_000], ranges: false });
    const unvalidated = await host({ cuts: [70_000], etag: null });

    try {
      await expect(readAll(ignores.url)).rejects.toThrow("terminated");
      expect(ignores.seen).toHaveLength(2);

      await expect(readAll(unvalidated.url)).rejects.toThrow("terminated");
      expect(unvalidated.seen).toHaveLength(1);
    } finally {
      ignores.close();
      unvalidated.close();
    }
  });

  it("counts only resumes that bring no new byte, and gives up after three", async () => {
    const trickle = await host({ cuts: [70_000, 70_001, 70_002, 70_003, 70_004] });

    try {
      expect(await readAll(trickle.url)).toEqual(BODY);
    } finally {
      trickle.close();
    }

    const dead = await host({ cuts: [70_000] });
    let calls = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;

      if (calls > 1)
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

      return fetch(input, init);
    }) as typeof fetch;

    try {
      await expect(
        drive(async () => {
          const stream = await requestStream(fetchImpl, dead.url, { api: "demo" });

          await new Response(stream).arrayBuffer();
        }),
      ).rejects.toThrow("terminated");
      expect(calls).toBe(4);
    } finally {
      dead.close();
    }
  });
});

describe("JsonClient download", () => {
  class Files extends JsonClient {
    fetchFile(path: string) {
      return this.download(path, { "x-extra": "1" });
    }
  }

  it("resolves a path under base_url, waits out a 429, and leaves client headers off", async () => {
    let attempt = 0;
    const { calls, fetchImpl } = fake(() =>
      attempt++ === 0
        ? new Response("slow", { status: 429, headers: { "retry-after": "0" } })
        : new Response("ok"),
    );
    useWaitTimers();
    const client = new Files(
      { base_url: "https://files.test", headers: { authorization: "Bearer s3cret" } },
      { fetch: fetchImpl },
      { api: "demo", baseUrl: "https://unused.test" },
    );
    const pending = watch(client.fetchFile("/a.tgz").then((stream) => new Response(stream).text()));

    await vi.advanceTimersByTimeAsync(0);
    expect(take(pending)).toBe("ok");
    expect(calls.map((call) => call.url.href)).toEqual([
      "https://files.test/a.tgz",
      "https://files.test/a.tgz",
    ]);
    expect(calls[1]?.headers["x-extra"]).toBe("1");
    expect(calls[1]?.headers).not.toHaveProperty("authorization");
  });
});

describe("auth", () => {
  it("builds a bearer header, a named api-key header, and basic", () => {
    expect(authHeaders({ scheme: "bearer", token: "sk_test" })).toEqual({
      authorization: "Bearer sk_test",
    });
    expect(
      authHeaders({ scheme: "api_key_header", header: "x-shopify-access-token", key: "shpat" }),
    ).toEqual({
      "x-shopify-access-token": "shpat",
    });
    expect(authHeaders({ scheme: "basic", username: "ada", password: "secret" })).toEqual({
      authorization: `Basic ${btoa("ada:secret")}`,
    });
  });

  it("sends user: when basic omits the password, and nothing when a named password is empty", () => {
    expect(authHeaders({ scheme: "basic", username: "ada" })).toEqual({
      authorization: `Basic ${btoa("ada:")}`,
    });
    expect(authHeaders({ scheme: "basic", username: "ada", password: "secret" })).toEqual({
      authorization: `Basic ${btoa("ada:secret")}`,
    });
    expect(authHeaders({ scheme: "basic", username: "ada", password: "" })).toEqual({});
    expect(authHeaders({ scheme: "basic", username: "", password: "secret" })).toEqual({});
  });

  it("sends nothing for an empty secret or a query-parameter scheme", () => {
    expect(authHeaders({ scheme: "bearer", token: "" })).toEqual({});
    expect(authHeaders({ scheme: "basic", username: "", password: "secret" })).toEqual({});
    expect(authHeaders({ scheme: "basic", username: "ada", password: "" })).toEqual({});
    expect(authHeaders({ scheme: "api_key_query", parameter: "api_key", key: "k" })).toEqual({});
  });
});

describe("requireApiVersion", () => {
  it("uses the fallback, and refuses a version the package does not list", () => {
    expect(requireApiVersion("stripe", {}, ["2024-06-20"], "2024-06-20")).toBe("2024-06-20");
    expect(
      requireApiVersion("stripe", { api_version: "2024-06-20" }, ["2024-06-20"], "2024-06-20"),
    ).toBe("2024-06-20");
    expect(() =>
      requireApiVersion("stripe", { api_version: "2099-01-01" }, ["2024-06-20"], "2024-06-20"),
    ).toThrow(/2099-01-01/);
  });
});

describe("eachPage", () => {
  it("yields every page and stops when the next cursor is null", async () => {
    const seen: (string | null)[] = [];

    const pages = eachPage<{ id: string }, { after: string }>({
      fetchPage: async (cursor) => {
        seen.push(cursor?.after ?? null);

        if (cursor === null) return { data: [{ id: "a" }], next: { after: "a" } };

        return { data: [{ id: "b" }], next: null };
      },
    });

    const collected = [];

    for await (const page of pages) collected.push(page);

    expect(seen).toEqual([null, "a"]);
    expect(collected).toEqual([
      { cursor: { after: "a" }, data: [{ id: "a" }] },
      { cursor: null, data: [{ id: "b" }] },
    ]);
  });

  it("keeps walking past an empty page that still has a cursor", async () => {
    const pages = eachPage<string, string>({
      fetchPage: async (cursor) => {
        if (cursor === null) return { data: [], next: "b" };

        return { data: ["c"], next: null };
      },
    });

    const collected = [];

    for await (const page of pages) collected.push(page);

    expect(collected).toEqual([{ cursor: null, data: ["c"] }]);
  });

  it("ends when the API hands back a cursor it already served", async () => {
    let calls = 0;
    const pages = eachPage<string, string>({
      fetchPage: async () => {
        calls += 1;

        return { data: [], next: "again" };
      },
    });

    const collected = [];

    for await (const page of pages) collected.push(page);

    expect(collected).toEqual([]);
    expect(calls).toBe(2);
  });
});

describe("helpers", () => {
  it("builds a query string, skipping undefined", () => {
    expect(query({ a: 1, b: "x y", c: undefined, d: false })).toBe("?a=1&b=x+y&d=false");
    expect(query({})).toBe("");
  });

  it("chunks evenly and keeps the remainder", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});
