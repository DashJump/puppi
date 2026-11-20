/**
 * Turns a pinned OpenAPI document into the operation table a connector
 * walks. `read` takes an operation id. A list is a named method on the
 * client; that method passes its page rule to `pages`.
 */

import { TerminalError } from "../errors.js";
import {
  authHeaders,
  type CredentialCheck,
  eachPage,
  ExpiredPageToken,
  type HttpAuth,
  isExpiredPageToken,
  isRateLimited,
  JsonClient,
  type JsonClientDefaults,
  linkHref,
  type Page,
  query,
  RateLimitError,
  requireApiVersion,
  retryAfterMs,
  trimSlash,
} from "./client.js";
import type { ConnectorAuth, ConnectorDefinition } from "./define.js";
import { read } from "./direction.js";

export interface Operation {
  method: "get" | "post";
  path: string;
  /** Query parameter names declared on the operation. */
  query: string[];
}

/**
 * How one list response becomes rows and the next request. A string `next`
 * is a dotted field path (`response_metadata.next_cursor`). An empty token
 * ends the walk. `param` sends the token back: a query parameter on a GET,
 * a field of the JSON body on a POST. With no `param`, a string token is a
 * URL to follow.
 */
export interface PageRule {
  /**
   * Array property, `"$"` when the body is the row array, or a tuple index
   * (`"1"`) when the body is `[meta, rows]`.
   */
  rows: string;
  next:
    | string
    | { last: string; while: string }
    | { header: string; rel: string }
    | { offset: string }
    | { page: string; pages: string };
  param?: string;
}

/** `rows` value that means the JSON body is the row array. */
const ROOT_ROWS = "$";

interface Spec {
  paths?: Record<string, Record<string, OperationObject | undefined>>;
  [extra: string]: unknown;
}

interface OperationObject {
  operationId?: string;
  parameters?: Parameter[];
}

interface Parameter {
  name?: string;
  in?: string;
}

export interface ReadArgs {
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Host for this call, when the connector has more than one server. */
  base?: string;
}

export interface PageArgs extends ReadArgs {
  /**
   * The next-page token from the previous page: an id, a cursor string, a
   * page number, an offset, or a URL. Null starts at the beginning.
   */
  cursor?: string | number | null;
}

/**
 * What `pnpm generate` writes as `Api` in `src/operations.ts`. `requests`
 * is present when the spec has a POST read. An id that is absent, including
 * every GET, takes no body.
 */
export type ApiTypes = {
  responses: Record<string, unknown>;
  requests?: Record<string, unknown>;
};

/** The JSON body of an openapi-typescript operation's 200 response. */
export type BodyOf<Op> = Op extends {
  responses: { 200: { content: { "application/json": infer Body } } };
}
  ? Body
  : unknown;

type JsonBody<Body> = Body extends { content: { "application/json": infer Json } } ? Json : never;

/**
 * JSON request body of an openapi-typescript operation. `never` when the
 * operation has none, so a GET's args have no `body`. `infer` drops the
 * optional modifier, so a required `requestBody` is the body and an
 * optional one includes `undefined`.
 */
export type RequestOf<Op> = Op extends { requestBody?: infer Body }
  ? [JsonBody<Body>] extends [never]
    ? never
    : undefined extends Op["requestBody" & keyof Op]
      ? JsonBody<Body> | undefined
      : JsonBody<Body>
  : never;

type Listed<A extends ApiTypes, Id extends string> =
  A["requests"] extends Record<string, unknown>
    ? Id extends keyof A["requests"]
      ? A["requests"][Id]
      : never
    : never;

/**
 * Parameter list for `read` and `pages`. No body (`never`, including a
 * body-less POST) leaves `args` optional. A required body stays required,
 * and `unknown` is required: `undefined extends unknown`.
 */
type Call<A extends ApiTypes, Id extends string, Base> = [Listed<A, Id>] extends [never]
  ? [args?: Base]
  : undefined extends Listed<A, Id>
    ? unknown extends Listed<A, Id>
      ? [args: Base & { body: Listed<A, Id> }]
      : [args?: Base & { body?: Exclude<Listed<A, Id>, undefined> }]
    : [args: Base & { body: Listed<A, Id> }];

/**
 * Array field of a list body, `"$"` when the body is the row array, or
 * `"1"` when the body is `[meta, rows]`. A body with no array field falls
 * back to `string`, and the walk checks at runtime.
 */
export type RowsKey<Body> = [ArrayField<NonNullable<Body>>] extends [never]
  ? NonNullable<Body> extends readonly unknown[]
    ? typeof ROOT_ROWS
    : string
  : Extract<ArrayField<NonNullable<Body>>, string>;

type ArrayField<Body> = Body extends readonly unknown[]
  ? {
      [I in keyof Body & `${number}`]: NonNullable<Body[I]> extends readonly unknown[] ? I : never;
    }[keyof Body & `${number}`]
  : {
      [K in keyof Body]-?: NonNullable<Body[K]> extends readonly unknown[] ? K : never;
    }[keyof Body];

/**
 * A refusal the API reports inside a 200 body (Slack's `{ ok: false }`).
 * `reason` settles `check`; without one the call throws with `code`.
 */
export interface ResponseError {
  code: string;
  reason?: "authentication" | "authorization";
}

export interface OpenApiConnector {
  operations: Record<string, Operation>;
  /** Document reads whose body is not the row the caller wants. */
  reshape?: (operationId: string, body: unknown) => unknown;
  /** Checked on every 200 body before `read`, `pages`, or `check` uses it. */
  responseError?: (body: unknown) => ResponseError | undefined;
  /**
   * Page shape a `PageRule` cannot state. Return nothing to keep the rule
   * the caller passed. `pages` still walks with `eachPage`.
   */
  extract?: (
    operationId: string,
    body: unknown,
    headers: Headers,
  ) => { data: unknown[]; next: string | number | null } | undefined;
  /**
   * Replaces the status heuristic in `isExpiredPageToken`. Return true when
   * this error means the page token is dead.
   */
  expiredPageToken?: (error: unknown) => boolean;
}

/**
 * Every GET and POST in `spec`. The key is the operation id, or the path
 * when the operation has none. A second operation that reuses a key is
 * stored under `${method} ${key}`, so the first one stays. Page rules are
 * not here: the method that walks a list passes its own rule to `pages`.
 */
export function classifyOperations(spec: Spec): Record<string, Operation> {
  const operations: Record<string, Operation> = {};

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of ["get", "post"] as const) {
      const operation = item[method];

      if (!operation) continue;

      const id = operation.operationId ?? path;
      const key = Object.hasOwn(operations, id) ? `${method} ${id}` : id;
      const queryNames = (operation.parameters ?? [])
        .filter((parameter) => parameter.in === "query")
        .map((parameter) => parameter.name ?? "")
        .filter((name) => name !== "");

      operations[key] = { method, path, query: queryNames };
    }
  }

  return operations;
}

/**
 * TypeScript source for `src/operations.ts`: the operation table, and the
 * `Api` types read from `src/openapi.ts`, which openapi-typescript writes
 * from the same spec.
 */
export function operationsModule(operations: Record<string, Operation>): string {
  const responses = Object.keys(operations).map(
    (id) => `    ${JSON.stringify(id)}: ${bodyType(id)};`,
  );
  const posts = Object.keys(operations).filter((id) => operations[id]?.method === "post");
  const requests =
    posts.length === 0
      ? ""
      : `
  requests: {
${posts.map((id) => `    ${JSON.stringify(id)}: RequestOf<spec[${JSON.stringify(id)}]>;`).join("\n")}
  };
`;
  const imported = posts.length === 0 ? "BodyOf, Operation" : "BodyOf, Operation, RequestOf";

  return `/** Generated from openapi.json. Do not edit. */

import type { ${imported} } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
${responses.join("\n")}
  };${requests}
};

export const operations: Record<keyof Api["responses"], Operation> = ${JSON.stringify(operations, null, 2)};
`;
}

function bodyType(id: string): string {
  return `BodyOf<spec[${JSON.stringify(id)}]>`;
}

/** What a connector passes instead of building `OpenApiClient`'s last two arguments. */
export interface OpenApiOverrides {
  /**
   * Replaces `defaultBaseUrl`. A function runs after the version check and
   * receives the version that check returned.
   */
  baseUrl?: string | ((version: string) => string);
  /**
   * Sent in addition to the auth headers, and overwrites a header of the
   * same name. A function runs after the version check.
   */
  headers?: Record<string, string> | ((version: string) => Record<string, string>);
  reshape?: OpenApiConnector["reshape"];
  extract?: OpenApiConnector["extract"];
  responseError?: OpenApiConnector["responseError"];
}

/**
 * The defaults and operation table an `OpenApiClient` is constructed with.
 * `requireApiVersion` runs first, then `authHeaders` is built from the
 * definition's `auth`. A bad version throws before a `baseUrl` or `headers`
 * function runs.
 */
export function openApiClientOptions(
  definition: ConnectorDefinition,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  operations: Record<string, Operation>,
  overrides: OpenApiOverrides = {},
): [JsonClientDefaults, OpenApiConnector] {
  const version = requireApiVersion(
    definition.type,
    config,
    definition.apiVersions,
    definition.defaultApiVersion,
  );
  const headers = {
    ...authHeaders(httpAuth(definition, config, secrets)),
    ...extraHeaders(overrides.headers, version),
  };
  const defaults: JsonClientDefaults = {
    api: definition.type,
    baseUrl: resolveBaseUrl(definition, version, overrides.baseUrl),
  };

  if (Object.keys(headers).length > 0) defaults.headers = headers;

  return [defaults, operationTable(operations, overrides)];
}

function resolveBaseUrl(
  definition: ConnectorDefinition,
  version: string,
  override: OpenApiOverrides["baseUrl"],
): string {
  const baseUrl =
    typeof override === "function" ? override(version) : (override ?? definition.defaultBaseUrl);

  if (typeof baseUrl !== "string") throw new Error(`${definition.type} requires a base URL`);

  return baseUrl;
}

function extraHeaders(
  headers: OpenApiOverrides["headers"],
  version: string,
): Record<string, string> {
  if (typeof headers === "function") return headers(version);

  return headers ?? {};
}

function operationTable(
  operations: Record<string, Operation>,
  overrides: OpenApiOverrides,
): OpenApiConnector {
  return {
    operations,
    ...(overrides.reshape ? { reshape: overrides.reshape } : {}),
    ...(overrides.extract ? { extract: overrides.extract } : {}),
    ...(overrides.responseError ? { responseError: overrides.responseError } : {}),
  };
}

/** The `authHeaders` input for a definition. `client` sends nothing here. */
function httpAuth(
  definition: ConnectorDefinition,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): HttpAuth {
  const auth = definition.auth;

  switch (auth.scheme) {
    case "none":
    case "client":
      return { scheme: "none" };
    case "bearer":
      return { scheme: "bearer", token: secrets[auth.secret] ?? "" };
    case "api_key_header":
      return {
        scheme: "api_key_header",
        header: auth.header,
        key: secrets[auth.secret] ?? "",
      };
    case "api_key_query":
      return {
        scheme: "api_key_query",
        parameter: auth.parameter,
        key: secrets[auth.secret] ?? "",
      };
    case "basic":
      return {
        scheme: "basic",
        username: basicUsername(definition, config, secrets, auth),
        password: secrets[auth.secret] ?? "",
      };
  }
}

/**
 * Basic's username. A name in `configSchema` is config; any other name is a
 * secret. `usernameSuffix` is appended unless the username already ends with it.
 */
function basicUsername(
  definition: ConnectorDefinition,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
  auth: Extract<ConnectorAuth, { scheme: "basic" }>,
): string {
  const source = Object.hasOwn(definition.configSchema, auth.username) ? config : secrets;
  const value = source[auth.username];
  const username = typeof value === "string" ? value : "";
  const suffix = auth.usernameSuffix ?? "";

  if (username === "" || suffix === "" || username.endsWith(suffix)) return username;

  return `${username}${suffix}`;
}

export class OpenApiClient<A extends ApiTypes = ApiTypes> extends JsonClient {
  private readonly connector: OpenApiConnector;

  constructor(
    config: Record<string, unknown>,
    options: ConstructorParameters<typeof JsonClient>[1],
    defaults: JsonClientDefaults,
    connector: OpenApiConnector,
  ) {
    super(config, options, defaults);
    this.connector = connector;
  }

  /** The operation's response body, reshaped when the connector says so. */
  @read
  async read<Id extends keyof A["responses"] & string>(
    operationId: Id,
    ...args: Call<A, Id, ReadArgs>
  ): Promise<A["responses"][Id]> {
    const operation = this.operation(operationId);
    const given = (args[0] ?? {}) as ReadArgs & { body?: Record<string, unknown> };
    const init = requestInit(operation, given.body);

    return this.retryRateLimit(async () => {
      const url = this.url(operation, given);
      const result = await this.dispatch<unknown>(url, init);

      this.refuse(url, result.data, result.headers);

      return (this.connector.reshape?.(operationId, result.data) ??
        result.data) as A["responses"][Id];
    }, init.method);
  }

  /**
   * Every page of one operation. `rule` says where the rows and the next
   * cursor are. `cursor` is the cursor of a previous page; omit it to start
   * at the beginning. Protected so an asset cannot call it: the connector's
   * named method owns the rule and calls this.
   */
  protected pages<
    Row = unknown,
    Id extends keyof A["responses"] & string = keyof A["responses"] & string,
  >(
    operationId: Id,
    rule: PageRule & { rows: RowsKey<A["responses"][Id]> },
    ...args: Call<A, Id, PageArgs>
  ): AsyncGenerator<Page<Row, string | number>> {
    const operation = this.operation(operationId);
    const given = (args[0] ?? {}) as PageArgs & { body?: Record<string, unknown> };

    return eachPage({
      cursor: given.cursor ?? null,
      fetchPage: (cursor) => {
        const request = this.pageRequest(operation, rule, given, cursor);

        return this.retryRateLimit(async () => {
          try {
            const result = await this.dispatch<unknown>(request.url, request.init);

            this.refuse(request.url, result.data, result.headers);

            const custom = this.connector.extract;
            let override: { data: unknown[]; next: string | number | null } | undefined;

            if (custom) {
              try {
                override = custom(operationId, result.data, result.headers);
              } catch (error) {
                // The connector error stays the cause. The wrapper is a plain Error.
                throw wrappedPageError(this.api, request.url, error, false);
              }
            }

            let extracted: { data: unknown[]; next: string | number | null };

            try {
              extracted = override ?? extract(rule, result.data, result.headers);
            } catch (error) {
              // The request URL can carry a cursor that looks like a status (`starting_after=500`).
              throw wrappedPageError(this.api, request.url, error, true);
            }
            const data = extracted.data as Row[];
            let next = extracted.next;

            if (isOffset(rule.next) && rule.param && next !== null) {
              const start = Number(cursor ?? supplied(operation, rule.param, given) ?? 0);

              next = start + data.length;
            }

            return { data, next };
          } catch (error) {
            if (cursor === null || !isExpiredPageToken(error, this.connector.expiredPageToken)) {
              throw error;
            }

            if (error instanceof ExpiredPageToken) throw error;

            const message = error instanceof Error ? error.message : String(error);

            throw new ExpiredPageToken(message, { cause: error });
          }
        }, request.init.method);
      },
    });
  }

  /**
   * A catalog `Client` implements this. The base throws so a package that
   * forgot the method fails closed instead of reporting a credential it
   * never sent.
   */
  override check(): Promise<CredentialCheck> {
    return Promise.reject(new Error(`${this.api} Client must implement check()`));
  }

  /**
   * One authenticated GET for `check()`. A 200 body that `responseError`
   * reads as a refusal settles the same way a 401 or 403 does.
   */
  protected prove(path: string, secret: string): Promise<CredentialCheck> {
    return this.checkGet(path, secret, (body, headers) => {
      const refused = this.connector.responseError?.(body);

      if (!refused) return undefined;

      if (!refused.reason) throw refusalError(this.api, path, refused.code, headers);

      return {
        ok: false,
        reason: refused.reason,
        message: `${this.api} ${refused.reason} failed for ${secret} (${refused.code})`,
      };
    });
  }

  /** Throws when the connector reads a refusal out of a 200 body. */
  private refuse(url: string, body: unknown, headers: Headers): void {
    const refused = this.connector.responseError?.(body);

    if (refused) throw refusalError(this.api, url, refused.code, headers);
  }

  /**
   * A next-page URL the API sent. The client's headers carry the credential,
   * so a URL on another origin is refused rather than followed.
   */
  private sameOrigin(url: string, base: string | undefined): string {
    let next: URL;

    try {
      next = new URL(url, `${trimSlash(base ?? this.base)}/`);
    } catch {
      throw new Error(`${this.api} sent a next page that is not a URL: ${url}`);
    }

    const expected = new URL(`${trimSlash(base ?? this.base)}/`).origin;

    if (next.origin !== expected) {
      throw new Error(`${this.api} sent a next page on ${next.origin}, not ${expected}`);
    }

    return next.href;
  }

  private operation(operationId: string): Operation {
    const operation = this.connector.operations[operationId];

    if (!operation) throw new Error(`${this.api} has no operation ${operationId}`);

    return operation;
  }

  private url(operation: Operation, args: ReadArgs): string {
    const path = `${fillPath(operation.path, args.path ?? {})}${query(args.query ?? {})}`;

    return args.base ? `${trimSlash(args.base)}${path}` : path;
  }

  private pageRequest(
    operation: Operation,
    rule: PageRule,
    args: PageArgs & { body?: Record<string, unknown> },
    cursor: string | number | null,
  ): { url: string; init: { method: "GET" | "POST"; body?: unknown } } {
    if (followsUrl(rule) && typeof cursor === "string") {
      return { url: this.sameOrigin(cursor, args.base), init: { method: "GET" } };
    }

    const params: Record<string, string | number | boolean | undefined> = { ...args.query };
    let body = args.body;

    const send = (value: string | number) => {
      if (!rule.param) return;

      if (operation.method === "post") {
        body = { ...body, [rule.param]: value };
        return;
      }

      params[rule.param] = value;
    };

    if (rule.param && cursor !== null && (isLastId(rule.next) || typeof rule.next === "string")) {
      send(cursor);
    }
    if (rule.param && isPageNumber(rule.next)) {
      send(cursor ?? supplied(operation, rule.param, args) ?? 1);
    }
    if (rule.param && isOffset(rule.next)) {
      send(cursor ?? supplied(operation, rule.param, args) ?? 0);
    }

    const path = `${fillPath(operation.path, args.path ?? {})}${query(params)}`;

    return {
      url: args.base ? `${trimSlash(args.base)}${path}` : path,
      init: requestInit(operation, body),
    };
  }
}

function requestInit(operation: Operation, body: unknown) {
  return {
    method: operation.method.toUpperCase() as Uppercase<Operation["method"]>,
    ...(body === undefined ? {} : { body }),
  };
}

/** The offset or page already in the query (GET) or the JSON body (POST). */
function supplied(
  operation: Operation,
  name: string,
  args: PageArgs & { body?: Record<string, unknown> },
): string | number | undefined {
  const value = operation.method === "post" ? args.body?.[name] : args.query?.[name];

  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function wrappedPageError(api: string, url: string, error: unknown, terminal: boolean): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = `${api} answered ${url} with ${message}`;

  if (terminal && error instanceof TerminalError)
    return new TerminalError(wrapped, { cause: error });

  return new Error(wrapped, { cause: error });
}

/** A 200 body the connector called a refusal. A rate-limit code keeps `Retry-After`. */
function refusalError(api: string, url: string, code: string, headers: Headers): Error {
  const message = `${api} answered ${url} with ${code}`;

  if (isRateLimited(code)) return new RateLimitError(message, retryAfterMs(headers));

  return new Error(message);
}

function extract(
  list: PageRule,
  body: unknown,
  headers: Headers,
): { data: unknown[]; next: string | number | null } {
  if (isPageNumber(list.next)) return extractPage(list, body);

  const record = asRecord(body);
  const rows = list.rows === ROOT_ROWS ? rootRows(body) : rowsAt(record, list.rows);

  if (isHeader(list.next)) {
    return { data: rows, next: linkHref(headers, list.next.rel) };
  }

  if (isOffset(list.next)) {
    const token = record[list.next.offset];

    return {
      data: rows,
      next: token === null || token === undefined || !list.param ? null : 0,
    };
  }

  if (isLastId(list.next)) {
    const last = rows.at(-1);
    const id =
      last && typeof last === "object"
        ? (last as Record<string, unknown>)[list.next.last]
        : undefined;
    const more = record[list.next.while] === true;
    const idOk = typeof id === "string" || typeof id === "number";

    if (more && !idOk) {
      throw new TerminalError(`${list.next.while} is true and the page has no ${list.next.last}`);
    }

    return { data: rows, next: more ? String(id) : null };
  }

  const token = fieldAt(record, list.next);

  return { data: rows, next: typeof token === "string" && token !== "" ? token : null };
}

function extractPage(
  list: PageRule,
  body: unknown,
): { data: unknown[]; next: string | number | null } {
  const next = list.next;

  if (!isPageNumber(next)) throw new Error("expected a page rule");

  const index = Number(list.rows);

  if (!Array.isArray(body) || body.length < 2 || !Array.isArray(body[index])) {
    const messages =
      Array.isArray(body) && body[0] && typeof body[0] === "object" && "message" in body[0]
        ? (body[0] as { message: { value?: string; key?: string }[] }).message
        : null;

    throw new Error(
      messages
        ? messages.map((message) => message.value ?? message.key ?? "").join("; ")
        : `expected a [meta, rows] page, received ${JSON.stringify(body).slice(0, 200)}`,
    );
  }

  const meta = asRecord(body[0]);
  const page = Number(meta[next.page] ?? 1);
  const pages = Number(meta[next.pages] ?? page);
  const rows = body[index] as unknown[];
  return { data: rows, next: page >= pages ? null : page + 1 };
}

function followsUrl(list: PageRule): boolean {
  return isHeader(list.next) || (typeof list.next === "string" && list.param === undefined);
}

function isHeader(next: PageRule["next"]): next is { header: string; rel: string } {
  return typeof next === "object" && "header" in next;
}

function isOffset(next: PageRule["next"]): next is { offset: string } {
  return typeof next === "object" && "offset" in next;
}

function isLastId(next: PageRule["next"]): next is { last: string; while: string } {
  return typeof next === "object" && "last" in next;
}

function isPageNumber(next: PageRule["next"]): next is { page: string; pages: string } {
  return typeof next === "object" && "page" in next;
}

function rowsAt(record: Record<string, unknown>, rows: string): unknown[] {
  const value = record[rows];

  if (!Array.isArray(value)) throw new Error(`rows "${rows}" is not an array`);

  return value;
}

function rootRows(body: unknown): unknown[] {
  if (!Array.isArray(body)) throw new Error(`rows "${ROOT_ROWS}" is not an array`);

  return body;
}

function fieldAt(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;

  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

function fillPath(path: string, params: Record<string, string | number>): string {
  return path.replace(/\{([^}]+)}/g, (_, name: string) => {
    const value = params[name];

    if (value === undefined) throw new Error(`missing path param ${name} for ${path}`);

    return encodeURIComponent(String(value));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
