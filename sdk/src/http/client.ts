/**
 * The HTTP base every API connector in this workspace is built on.
 * It ships in `@puppi/sdk`. The generic `http` connection is
 * `@puppi/adapter-http`.
 *
 * `JsonClient` carries what every adapter repeats: a `fetch` to inject,
 * a user agent, auth headers, a page walk, a call that turns a non-2xx
 * answer into an error the executor can classify, and a wait for rate
 * limits. GET, HEAD, and OPTIONS also wait out a 5xx or a request timeout.
 * Every connector goes through that wait.
 */

import { chain, statusOf, text } from "../error-chain.js";
import { isTerminal, isTransient } from "../errors.js";

/** What an adapter needs beyond its binding: a `fetch` to inject in tests, and who to say it is. */
export interface ClientOptions {
  fetch?: typeof fetch;
  userAgent?: string;
}

/**
 * A bundle inlines its own copy of these classes, so `instanceof` is false
 * in the executor. The symbol is the same value in every copy.
 */
const HTTP_STATUS = Symbol.for("puppi.http_status_error");
const RATE_LIMIT = Symbol.for("puppi.rate_limit_error");
const EXPIRED_PAGE_TOKEN = Symbol.for("puppi.expired_page_token");
const NOT_FOUND = Symbol.for("puppi.not_found");

/**
 * A non-2xx answer other than 404. `check` reads `status` to tell a rejected
 * credential from a refused permission.
 */
export class HttpStatusError extends Error {
  override readonly name = "HttpStatusError";
  readonly [HTTP_STATUS] = true;
  readonly status: number;
  readonly statusText: string;
  /** From `Retry-After` when the response carried one, otherwise null. */
  readonly retryAfterMs: number | null;

  constructor(
    api: string,
    status: number,
    statusText: string,
    url: string,
    body: string,
    headers?: Headers,
  ) {
    super(`${api} answered ${status} ${statusText} for ${url}` + (body ? `: ${body}` : ""));
    this.status = status;
    this.statusText = statusText;
    this.retryAfterMs = headers ? retryAfterMs(headers) : null;
  }
}

/**
 * A rate limit the API reported inside a success body (Slack's
 * `{ ok: false, error: "ratelimited" }`).
 */
export class RateLimitError extends Error {
  override readonly name = "RateLimitError";
  readonly [RATE_LIMIT] = true;
  readonly retryAfterMs: number | null;

  constructor(message: string, waitMs: number | null = null) {
    super(message);
    this.retryAfterMs = waitMs;
  }
}

/**
 * The server rejected the page token. The runtime drops that token and
 * resumes from the watermark. A missing resource is `NotFound`, not this.
 */
export class ExpiredPageToken extends Error {
  override readonly name = "ExpiredPageToken";
  readonly [EXPIRED_PAGE_TOKEN] = true;
}

/** A 404 from the API: the resource does not exist, which some callers treat as data. */
export class NotFound extends Error {
  override readonly name = "NotFound";
  readonly [NOT_FOUND] = true;

  constructor(url: string) {
    super(`nothing at ${url}`);
  }
}

export interface GetOptions {
  /** Named in error messages: `frankfurter answered 503 …`. */
  api: string;
  userAgent?: string;
  headers?: Record<string, string>;
}

export interface RequestOptions extends GetOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON-encoded when set. Sends `content-type: application/json`. */
  body?: unknown;
  /** Aborts the fetch after this many milliseconds. Default 60s. */
  timeoutMs?: number;
}

/** A completed JSON call. `headers` is how a connector reads a `Link` header. */
export interface HttpResult<T> {
  status: number;
  headers: Headers;
  data: T;
}

/**
 * One JSON call. A 404 is `NotFound`. Any other non-2xx answer is
 * `HttpStatusError`. A network failure says `unreachable`.
 */
export async function requestJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  options: RequestOptions,
): Promise<HttpResult<T>> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": options.userAgent ?? userAgentFor(options.api),
    ...options.headers,
  };

  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetchChecked(fetchImpl, url, options.api, {
    method: options.method ?? "GET",
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  return {
    status: response.status,
    headers: response.headers,
    data: (await response.json()) as T,
  };
}

/**
 * One GET for a file, returned as its body stream. The same errors as
 * `requestJson`. `timeoutMs` bounds the wait for the response headers only,
 * so a long download is not cut off.
 *
 * A body cut short is resumed from the byte it stopped at, with `Range` and
 * `If-Range` on the first response's validator. A host that answers 200
 * instead of 206, sends no validator, or uses a content-encoding other
 * than `identity`, raises the original error. So does a 206 whose
 * `Content-Range` start is not the bytes already read, whose end is not
 * the last byte of its total, or whose total differs from the first
 * response. A finished stream whose total is known, from that range or
 * from `content-length`, raises an error when the bytes read differ.
 * Three resumes in a row without a new byte stop it, and so does the 21st
 * resume.
 */
export async function requestStream(
  fetchImpl: typeof fetch,
  url: string,
  options: GetOptions & { timeoutMs?: number },
): Promise<ReadableStream<Uint8Array>> {
  const headers = {
    "user-agent": options.userAgent ?? userAgentFor(options.api),
    ...options.headers,
  };
  const first = await openStream(fetchImpl, url, options, headers);
  const validator = strongValidator(first.headers);
  // fetch decodes the body, so `received` is not a `Range` offset.
  const canResume = validator !== null && identityEncoded(first.headers);
  // A decoded gzip body is not the `content-length` figure.
  let expectedTotal = identityEncoded(first.headers) ? contentLength(first.headers) : null;
  let reader = first.body.getReader();
  let received = 0;
  let stalls = 0;
  let resumes = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        let read: Awaited<ReturnType<typeof reader.read>>;

        try {
          read = await reader.read();
        } catch (error) {
          if (
            !canResume ||
            !isTransient(error) ||
            ++stalls > MAX_STALLS ||
            resumes >= MAX_RESUMES
          ) {
            throw error;
          }

          resumes += 1;
          await defaultSleep(RESUME_MS * stalls);
          reader = await resume(error, received);
          continue;
        }

        if (read.done) {
          if (expectedTotal !== null && received !== expectedTotal) {
            throw new Error(`download ended at ${received} of ${expectedTotal} bytes`);
          }

          return controller.close();
        }

        received += read.value.byteLength;
        stalls = 0;
        return controller.enqueue(read.value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  async function resume(
    cause: unknown,
    from: number,
  ): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const next = await openStream(fetchImpl, url, options, {
      ...headers,
      range: `bytes=${from}-`,
      "if-range": validator ?? "",
    }).catch(() => null);

    if (next === null) return failing(cause);

    const range = parsedRange(next.headers.get("content-range"));

    if (
      next.status !== 206 ||
      !acceptableRange(range, from, expectedTotal) ||
      !identityEncoded(next.headers)
    ) {
      await next.body.cancel().catch(() => undefined);
      throw cause;
    }

    if (expectedTotal === null && range !== null) expectedTotal = range.total;

    return next.body.getReader();
  }
}

const MAX_STALLS = 3;
const MAX_RESUMES = 20;
const RESUME_MS = 500;

async function openStream(
  fetchImpl: typeof fetch,
  url: string,
  options: GetOptions & { timeoutMs?: number },
  headers: Record<string, string>,
): Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> }> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("request timed out", "TimeoutError")),
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetchChecked(fetchImpl, url, options.api, {
      headers,
      signal: controller.signal,
    });

    if (response.body === null) throw new Error(`${options.api} answered with no body for ${url}`);

    return { status: response.status, headers: response.headers, body: response.body };
  } finally {
    clearTimeout(timer);
  }
}

/** A failed resume request: the next read raises the drop that caused it, so the loop counts a stall. */
function failing(cause: unknown): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(cause);
    },
  }).getReader();
}

/** `If-Range` takes a strong ETag or a Last-Modified date. */
function strongValidator(headers: Headers): string | null {
  const etag = headers.get("etag");

  if (etag && !etag.startsWith("W/")) return etag;

  return headers.get("last-modified");
}

/** Returns the `content-length` when it is a byte count. */
function contentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");

  if (raw === null || !/^\d+$/.test(raw)) return null;

  return Number(raw);
}

/** `bytes START-END/TOTAL`, or null when the header is missing or open-ended. */
function parsedRange(header: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header?.trim() ?? "");

  if (match === null) return null;

  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

/**
 * Reports whether a 206 starts at `from`, ends on the last byte, and matches
 * the first response's total when that response named one.
 */
function acceptableRange(
  range: { start: number; end: number; total: number } | null,
  from: number,
  expectedTotal: number | null,
): boolean {
  if (range === null) return false;
  if (range.start !== from || range.end !== range.total - 1) return false;

  return expectedTotal === null || range.total === expectedTotal;
}

/** True when there is no `content-encoding`, or it is `identity`. */
function identityEncoded(headers: Headers): boolean {
  const encoding = headers.get("content-encoding")?.trim().toLowerCase() ?? "";

  return encoding === "" || encoding === "identity";
}

/** `fetch`, with a 404 as `NotFound`, another non-2xx as `HttpStatusError`, and a network failure as `unreachable`. */
async function fetchChecked(
  fetchImpl: typeof fetch,
  url: string,
  api: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;

  try {
    response = await fetchImpl(url, init);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`${api} unreachable at ${url}: ${message}`, { cause: error });
  }

  if (response.status === 404) throw new NotFound(url);

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 200);

    throw new HttpStatusError(
      api,
      response.status,
      response.statusText,
      url,
      body,
      response.headers,
    );
  }

  return response;
}

/**
 * Milliseconds until a retry is welcome, from a `Retry-After` header.
 * Delta-seconds (`3`) or an HTTP-date. Null when the header is missing or
 * neither of those. A date already in the past is `0`.
 */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const value = headers.get("retry-after")?.trim();

  if (!value) return null;

  const seconds = Number(value);

  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));

  const date = Date.parse(value);

  if (Number.isNaN(date)) return null;

  return Math.max(0, date - now);
}

/**
 * The wait stored on `HttpStatusError` or `RateLimitError`, including a copy
 * the bundle inlined. The engine accepts that integer as `retry_after_ms`.
 * Null when this error did not carry one.
 */
export function storedRetryAfter(error: unknown): number | null {
  if (!isHttpStatus(error) && !isRateLimit(error)) return null;

  const wait = (error as { retryAfterMs?: unknown }).retryAfterMs;

  return typeof wait === "number" && Number.isInteger(wait) && wait >= 0 ? wait : null;
}

/** A rate limit: HTTP 429, or a body the connector reported as one. */
export function isRateLimited(error: unknown): boolean {
  if (error instanceof NotFound) return false;
  if (error instanceof RateLimitError) return true;

  const status = statusOf(error);

  // A numeric status is the answer. Digits in the message are not, so an id
  // of 429 on a 400 does not wait.
  if (status !== null) return status === 429;

  return RATE_MESSAGE.test(text(error));
}

/**
 * A dead page token. `classify`, when the connector provides one, replaces
 * the heuristic. Status alone is not enough: 400 is also a bad query.
 * `NotFound` is a missing resource. An outer `NotFound` or terminal error
 * wins over a token on `cause`.
 */
export function isExpiredPageToken(
  error: unknown,
  classify?: (error: unknown) => boolean,
): boolean {
  if (classify) return classify(error);

  for (const node of chain(error)) {
    if (isNotFound(node) || isTerminalBrand(node)) return false;
    if (isExpiredToken(node)) return true;
  }

  return false;
}

function isExpiredToken(error: unknown): boolean {
  if (error instanceof ExpiredPageToken || branded(error, EXPIRED_PAGE_TOKEN)) return true;
  if (!isHttpStatus(error)) return false;

  const status = statusOf(error);

  if (status !== 400 && status !== 404 && status !== 410 && status !== 422) return false;

  return EXPIRED_PAGE.test(text(error));
}

const EXPIRED_PAGE =
  /\binvalid[_\s-]*cursor\b|\bexpired\s+(?:cursor|page)\b|\bpage[_\s-]*token\b|\bpage_info\b|\binvalid or expired\b/i;

/** Same symbol the SDK's `TerminalError` brands. A bundle inlines its own copy. */
const TERMINAL = Symbol.for("puppi.terminal_error");

const RATE_MESSAGE = /\b429\b|rate[_\s-]*limit|limit exceeded/i;

function branded(error: unknown, brand: symbol): boolean {
  return Boolean(error && typeof error === "object" && (error as Record<symbol, unknown>)[brand]);
}

function isTerminalBrand(error: unknown): boolean {
  return branded(error, TERMINAL);
}

function isNotFound(error: unknown): boolean {
  return error instanceof NotFound || branded(error, NOT_FOUND);
}

function isRateLimit(error: unknown): boolean {
  return error instanceof RateLimitError || branded(error, RATE_LIMIT);
}

function isHttpStatus(error: unknown): boolean {
  return error instanceof HttpStatusError || branded(error, HTTP_STATUS);
}

/**
 * A fetch that never answers. Heartbeats reset the executor's silence clock,
 * so without this a stalled request would keep the attempt alive.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * How long one attempt will spend waiting inside the client. An attempt has a
 * 60 second budget, so a longer `Retry-After` is thrown for the engine to
 * retry rather than slept here. A 5xx or a request timeout spends the same
 * budget.
 */
const RATE_LIMIT_BUDGET_MS = 30_000;

/** Used when the response carries no `Retry-After`. Three waits, then the error propagates. */
const RATE_LIMIT_BACKOFF_MS = [1_000, 4_000, 10_000] as const;

/** A 5xx or a request timeout on GET, HEAD, or OPTIONS waits these, then the error leaves the client. */
const TRANSIENT_BACKOFF_MS = [250, 1_000] as const;

/**
 * GET, HEAD, and OPTIONS are retried. PUT and DELETE are not: a DELETE that
 * succeeded during a timeout comes back as 404, and `NotFound` then fails it.
 */
const RETRIED_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** These codes mean the request timed out. A reset is not one of them. */
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, waiting out a rate limit. `Retry-After` wins over the backoff.
 * A 5xx or a request timeout on GET, HEAD, or OPTIONS uses the short backoff.
 * A dead socket, a 4xx, and any other failure are thrown at once, for the
 * executor to classify.
 */
async function awaitRateLimit<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  method: string,
): Promise<T> {
  let spent = 0;
  let rateWaits = 0;
  let faultWaits = 0;

  for (;;) {
    try {
      return await fn();
    } catch (error: unknown) {
      const delay = retryDelay(error, rateWaits, faultWaits, spent, method);

      if (delay === null) throw error;

      await sleep(delay);
      spent += delay;

      if (isRateLimited(error)) rateWaits += 1;
      else faultWaits += 1;
    }
  }
}

function retryDelay(
  error: unknown,
  rateWaits: number,
  faultWaits: number,
  spent: number,
  method: string,
): number | null {
  if (isRateLimited(error)) return rateLimitDelay(error, rateWaits, spent);

  return transientFaultDelay(error, faultWaits, spent, method);
}

function transientFaultDelay(
  error: unknown,
  waited: number,
  spent: number,
  method: string,
): number | null {
  if (!isTransientFault(error, method) || waited >= TRANSIENT_BACKOFF_MS.length) return null;

  const delay = TRANSIENT_BACKOFF_MS[waited]!;

  if (spent + delay > RATE_LIMIT_BUDGET_MS) return null;

  return delay;
}

/**
 * A 5xx or a request timeout that `isTransient` also calls retryable, on
 * GET, HEAD, or OPTIONS. A rate limit stays on its own backoff. A 4xx, a 404,
 * an expired page token, and a terminal error are not waited out.
 */
function isTransientFault(error: unknown, method: string): boolean {
  if (!retriedMethod(method) || isRateLimited(error) || classifiedTerminal(error)) return false;
  if (!isTransient(error)) return false;

  return chain(error).some((node) => serverStatus(node) || requestTimedOut(node));
}

function retriedMethod(method: string): boolean {
  return RETRIED_METHODS.has(method.toUpperCase());
}

function classifiedTerminal(error: unknown): boolean {
  return chain(error).some(
    (node) => branded(node, EXPIRED_PAGE_TOKEN) || branded(node, NOT_FOUND) || isTerminal(node),
  );
}

/** True when `status` is a 5xx. */
function serverStatus(error: unknown): boolean {
  const status = statusOf(error);

  return status !== null && status >= 500 && status <= 599;
}

/** True when the request timer fired. A dropped socket is a different code and is not retried. */
function requestTimedOut(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  if ((error as { name?: unknown }).name === "TimeoutError") return true;

  const code = (error as { code?: unknown }).code;

  return typeof code === "string" && TIMEOUT_CODES.has(code);
}

function rateLimitDelay(error: unknown, waited: number, spent: number): number | null {
  if (!isRateLimited(error) || waited >= RATE_LIMIT_BACKOFF_MS.length) return null;

  const hinted = indicatedWait(error);
  const delay = hinted ?? RATE_LIMIT_BACKOFF_MS[waited]!;

  if (spent + delay > RATE_LIMIT_BUDGET_MS) return null;

  return delay;
}

function indicatedWait(error: unknown): number | null {
  if (error instanceof HttpStatusError || error instanceof RateLimitError)
    return error.retryAfterMs;

  return null;
}

export function userAgentFor(api: string): string {
  return `puppi-adapter-${api}/0.1 (+https://github.com/DashJump/puppi)`;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** `?a=1&b=x` from a record, skipping undefined values; empty when nothing is set. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }

  const encoded = search.toString();

  return encoded ? `?${encoded}` : "";
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }

  return chunks;
}

/**
 * How a connector authenticates. The secret values come from the binding.
 * An empty token, key, username, or password sends nothing: a missing
 * secret fails as a 401 from the API, which names the status, rather than
 * as a header of `Bearer ` or `Basic `. Omitting `password` sends
 * `username:`.
 */
export type HttpAuth =
  | { scheme: "none" }
  | { scheme: "bearer"; token: string }
  | { scheme: "api_key_header"; header: string; key: string }
  | { scheme: "api_key_query"; parameter: string; key: string }
  | { scheme: "basic"; username: string; password?: string };

/** The headers for `auth`. Query-parameter schemes contribute no header. */
export function authHeaders(auth: HttpAuth): Record<string, string> {
  switch (auth.scheme) {
    case "none":
    case "api_key_query":
      return {};
    case "bearer":
      return auth.token === "" ? {} : { authorization: `Bearer ${auth.token}` };
    case "api_key_header":
      return auth.key === "" ? {} : { [auth.header]: auth.key };
    case "basic": {
      if (auth.username === "" || auth.password === "") return {};

      return {
        authorization: `Basic ${btoa(`${auth.username}:${auth.password ?? ""}`)}`,
      };
    }
  }
}

/**
 * The binding's `api_version`, or `fallback` when the binding omits it.
 * A value outside `supported` fails at construction: the package only sends
 * a version it has fixtures for.
 */
export function requireApiVersion(
  api: string,
  config: Record<string, unknown>,
  supported: readonly string[],
  fallback: string,
): string {
  const version = typeof config["api_version"] === "string" ? config["api_version"] : fallback;

  if (!supported.includes(version)) {
    throw new Error(
      `${api} api_version ${JSON.stringify(version)} is not supported by this connector (${supported.join(", ")})`,
    );
  }

  return version;
}

/**
 * The URL for `rel` in a `Link` header (`<https://api/customers?page=2>; rel="next"`),
 * or null when that relation is absent.
 */
export function linkHref(headers: Headers, rel: string): string | null {
  const header = headers.get("link");

  if (!header) return null;

  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?([^";]+)"?/.exec(part.trim());

    if (match?.[2] === rel) return match[1] ?? null;
  }

  return null;
}

/**
 * One page of a list. `cursor` fetches the following page; null means this
 * page was the last. A producer checkpoints `cursor` and passes it back to
 * resume.
 */
export interface Page<T, C> {
  cursor: C | null;
  data: T[];
}

/**
 * What `check` returns. `{ ok: true }` means the credentials were accepted,
 * or the connector has nothing to check. A failure names which case it was.
 * `check` does not throw for these two; any other failure still throws.
 */
export type CredentialCheck =
  | { ok: true }
  | { ok: false; reason: "authentication" | "authorization"; message: string };

/**
 * A source connector: it reads an external system and does not store a
 * materialization. Resource methods are the connector's own, because each
 * API names different ones. `close` and `check` are required. `JsonClient`
 * supplies both: an empty `close`, and a `check` that returns `{ ok: true }`.
 * `OpenApiClient` throws from `check` until a catalog `Client` implements it.
 */
export interface Source {
  close(): Promise<void>;
  check(): Promise<CredentialCheck>;
}

/**
 * Walks `fetchPage` until it reports no further cursor. An empty page with a
 * next cursor is not the end: some APIs filter after paging. A cursor that
 * repeats one already fetched ends the walk, so a stuck API cannot loop.
 */
export async function* eachPage<T, C>(options: {
  cursor?: C | null;
  fetchPage: (cursor: C | null) => Promise<{ data: T[]; next: C | null }>;
}): AsyncGenerator<Page<T, C>> {
  let cursor: C | null = options.cursor ?? null;
  const fetched = new Set<string>([JSON.stringify(cursor)]);

  for (;;) {
    const page = await options.fetchPage(cursor);

    if (page.data.length > 0) yield { cursor: page.next, data: page.data };

    if (page.next === null) return;

    const key = JSON.stringify(page.next);

    if (fetched.has(key)) return;

    fetched.add(key);
    cursor = page.next;
  }
}

export interface JsonClientDefaults {
  api: string;
  baseUrl: string;
  /** Sent with every request, under whatever the binding's config adds. */
  headers?: Record<string, string>;
}

/**
 * What every API adapter's `Client` starts from: the binding's `base_url`
 * (or the adapter's default), an injectable `fetch`, and `get` / `send`.
 * Adapters add the typed methods.
 */
export class JsonClient {
  protected readonly base: string;
  protected readonly fetchImpl: typeof fetch;
  protected readonly userAgent: string;
  protected readonly api: string;
  protected readonly headers: Record<string, string>;

  constructor(
    config: Record<string, unknown>,
    options: ClientOptions,
    defaults: JsonClientDefaults,
  ) {
    this.api = defaults.api;
    this.base = trimSlash((config["base_url"] as string | undefined) ?? defaults.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? userAgentFor(defaults.api);
    this.headers = {
      ...defaults.headers,
      ...(config["headers"] as Record<string, string> | undefined),
    };
  }

  /**
   * Runs `fn` and waits out a rate limit before the error reaches the
   * caller. GET, HEAD, and OPTIONS also wait out a 5xx or a request timeout.
   * `method` is the verb `fn` sends. It is required, so a POST cannot pick
   * up a GET retry by leaving the verb off.
   */
  protected retryRateLimit<T>(
    fn: () => Promise<T>,
    method: "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE",
  ): Promise<T> {
    return awaitRateLimit(fn, defaultSleep, method);
  }

  /**
   * JSON request to `pathOrUrl`. An absolute URL is fetched as given, which
   * is how a `Link` header's `next` is followed. Anything else is resolved
   * under `base_url`.
   */
  protected send<T>(
    pathOrUrl: string,
    init: { method?: RequestOptions["method"]; body?: unknown } = {},
  ): Promise<HttpResult<T>> {
    return this.retryRateLimit(() => this.dispatch<T>(pathOrUrl, init), init.method ?? "GET");
  }

  /** One JSON call, with no rate-limit wait. `read` and `pages` add their own. */
  protected dispatch<T>(
    pathOrUrl: string,
    init: { method?: RequestOptions["method"]; body?: unknown } = {},
  ): Promise<HttpResult<T>> {
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${this.base}${pathOrUrl}`;

    return requestJson<T>(this.fetchImpl, url, {
      api: this.api,
      userAgent: this.userAgent,
      headers: this.headers,
      ...init,
    });
  }

  /**
   * GET `pathOrUrl` as a byte stream, for a file rather than JSON. Waits out
   * a rate limit. Sends the user agent and `headers` only, not the client's
   * own headers, so a signed API's credentials do not reach a file host.
   */
  protected download(
    pathOrUrl: string,
    headers: Record<string, string> = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${this.base}${pathOrUrl}`;

    return this.retryRateLimit(
      () =>
        requestStream(this.fetchImpl, url, {
          api: this.api,
          userAgent: this.userAgent,
          headers,
        }),
      "GET",
    );
  }

  /** GET `<base_url><path>`, decoded as JSON. */
  protected get<T>(path: string): Promise<T> {
    return this.send<T>(path).then((result) => result.data);
  }

  /** Nothing to release. A client that opens a socket overrides this. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Nothing to prove. A connector with a secret overrides this and calls
   * `checkGet` against one cheap authenticated path.
   */
  check(): Promise<CredentialCheck> {
    return Promise.resolve({ ok: true });
  }

  /**
   * One authenticated GET. 2xx is success. 401 is authentication, 403 is
   * authorization, and the message names the secret field, not its value.
   * Any other status throws, so the executor can classify it.
   */
  protected checkGet(
    path: string,
    secret: string,
    inspect?: (body: unknown, headers: Headers) => CredentialCheck | undefined,
  ): Promise<CredentialCheck> {
    return this.retryRateLimit(async () => {
      try {
        const result = await this.dispatch(path);

        return inspect?.(result.data, result.headers) ?? { ok: true };
      } catch (error) {
        if (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) {
          const reason = error.status === 401 ? "authentication" : "authorization";

          return {
            ok: false,
            reason,
            message: `${this.api} ${reason} failed for ${secret} (${error.status} ${error.statusText})`,
          };
        }

        throw error;
      }
    }, "GET");
  }
}
