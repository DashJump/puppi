/**
 * Checks an HTTP source against a fake `fetch` and its pinned `openapi.json`.
 *
 * Page walks and a 200 body that means failure are the connector's own test.
 * This suite cannot know what those look like.
 */

import { readFileSync } from "node:fs";

import { classifyOperations, secretFieldsFor, type Operation } from "@puppi/sdk";

import { type ConformanceCheck, equal, message, run } from "./report.js";

/**
 * The catalog module contract. The default export is the `defineConnector`
 * definition. `Client` implements `Source`: `close()` and `check()` are
 * required. `defineConfig` and `puppi build` read that default export.
 */
export interface SourceConnector {
  default: {
    type: string;
    docs: string;
    configSchema: Readonly<Record<string, string>>;
    secretFields: readonly string[];
    auth: {
      scheme: string;
      secret?: string;
      header?: string;
      parameter?: string;
      username?: string;
      usernameSuffix?: string;
    };
    apiVersions: readonly string[];
    defaultApiVersion: string;
    defaultBaseUrl?: string;
  };
  Client: new (
    config: Record<string, unknown>,
    secrets: Record<string, string>,
    options: { fetch: typeof fetch },
  ) => {
    close(): Promise<void>;
    check(): Promise<unknown>;
  };
}

/** The definition plus `Client`, which is how the rest of the suite addresses it. */
type CatalogSource = SourceConnector["default"] & Pick<SourceConnector, "Client">;

export interface SourceConformanceOptions {
  connector: SourceConnector;
  /** `src/operations.ts`, which has to be what generate writes from the spec. */
  operations: Record<string, Operation>;
  /** The package directory, holding `package.json` and `openapi.json`. */
  root: URL;
  /** Binding config the client is built with; point `base_url` at a fake host. */
  config: Record<string, unknown>;
}

/** Stands in for the credential, so the suite can look for it where it must not be. */
const SECRET = "conformance-secret-7f3a";

/** Stand-in username for basic auth. Distinct from `SECRET`, so a swapped pair fails. */
const BASIC_USER = "conformance-user@example.test";

/** Why `api_key_query` does not run the credential checks. */
const QUERY_SKIP = "api_key_query waits until secrets are redacted from URLs";

interface Walkable {
  check(): Promise<{ ok: boolean; reason?: string; message?: string }>;
  close?(): Promise<void>;
}

interface Reply {
  body: unknown;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
}

export async function runSourceConformance(
  options: SourceConformanceOptions,
): Promise<ConformanceCheck[]> {
  const source = new Source(options);
  const connector = source.connector;
  const checks: ConformanceCheck[] = [];

  checks.push(
    await run("the module exports the source interface", async () => {
      assertSourceExports(options.connector);
    }),
  );
  checks.push(
    await run(`the package is @puppi/adapter-${connector.type}`, async () => {
      equal(source.packageName, `@puppi/adapter-${connector.type}`, "package.json name");
    }),
  );
  checks.push(
    await run("secretFields names what auth reads", async () => {
      equal(
        connector.secretFields,
        secretFieldsFor(connector.auth, connector.configSchema),
        "secretFields",
      );
    }),
  );
  checks.push(
    await run("the default API version is listed, and any other fails construction", () =>
      apiVersions(source),
    ),
  );
  checks.push(
    await run(
      "a non-default API version is a path segment of the request, and the default is not",
      () => versionedRequest(source),
    ),
  );
  checks.push(
    await run("operations.ts is what generate writes from openapi.json", async () => {
      equal(options.operations, classifyOperations(source.spec), "operations.ts has drifted");
    }),
  );

  const credentialChecks: [string, (source: Source) => Promise<void>][] = [
    ["check passes on a 200 from its operation", checkPasses],
    ["the credential is a header from the secrets argument, never the URL", credential],
    ["every request carries a user agent", userAgent],
    ["check reports 401 as authentication and 403 as authorization", checkRefusals],
    ["check throws on a 429 and a 503, naming the status, not the secret", checkThrows],
  ];

  for (const [name, body] of credentialChecks) {
    checks.push(await runCredential(connector, name, () => body(source)));
  }

  return checks;
}

/** The package under test: its files, and a client wired to a fake server. */
class Source {
  readonly connector: CatalogSource;
  readonly operations: Record<string, Operation>;
  readonly spec: Parameters<typeof classifyOperations>[0];
  readonly packageName: string;
  private readonly config: Record<string, unknown>;

  constructor(options: SourceConformanceOptions) {
    this.connector = { ...options.connector.default, Client: options.connector.Client };
    this.operations = options.operations;
    this.config = options.config;
    this.spec = readJson(new URL("openapi.json", options.root)) as Parameters<
      typeof classifyOperations
    >[0];
    this.packageName = String(
      (readJson(new URL("package.json", options.root)) as { name?: unknown }).name,
    );
  }

  client(server: Server, config: Record<string, unknown> = {}): Walkable {
    const binding = this.binding(config);

    return new this.connector.Client(binding.config, binding.secrets, {
      fetch: server.fetch,
    }) as Walkable;
  }

  /**
   * Config and secrets passed to the client. A basic username in
   * `configSchema` is config; any other basic username is a second secret.
   */
  binding(config: Record<string, unknown> = {}): {
    config: Record<string, unknown>;
    secrets: Record<string, string>;
  } {
    const auth = this.connector.auth;
    const merged = { ...this.config, ...config };
    const secrets: Record<string, string> = {};

    if (auth.secret) secrets[auth.secret] = SECRET;

    if (auth.scheme !== "basic" || !auth.username) return { config: merged, secrets };

    if (auth.username in this.connector.configSchema) {
      const given = merged[auth.username];
      const username = typeof given === "string" && given !== "" ? given : BASIC_USER;

      return { config: { ...merged, [auth.username]: username }, secrets };
    }

    return { config: merged, secrets: { ...secrets, [auth.username]: BASIC_USER } };
  }

  /**
   * The operation `check()` requested. The suite does not read a CHECK
   * export: the client has to call a path the operation table contains.
   */
  checkOperation(url: string): Operation {
    const path = new URL(url).pathname;
    const operation = Object.values(this.operations).find((candidate) =>
      new RegExp(`${candidate.path.replace(/\{[^}]+}/g, "[^/]+")}$`).test(path),
    );

    if (!operation) throw new Error(`check requested ${path}, which operations.ts does not have`);

    return operation;
  }
}

/** Answers each request with the next queued reply, and records what was asked. */
class Server {
  readonly calls: { url: string; headers: Headers }[] = [];
  private readonly replies: (Reply | ((url: string) => Reply))[];

  constructor(...replies: (Reply | ((url: string) => Reply))[]) {
    this.replies = replies;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);

    this.calls.push({ url, headers: new Headers(init?.headers) });

    return replyResponse(this.reply(url));
  }) as typeof fetch;

  /** A lone function answers every request, so a 429 can be retried. */
  private reply(url: string): Reply | undefined {
    const only = this.replies.length === 1 ? this.replies[0] : undefined;

    if (typeof only === "function") return only(url);

    const next = this.replies.shift();

    return typeof next === "function" ? next(url) : next;
  }
}

/**
 * A non-default `api_version` has to be its own segment of the request
 * path, and the default version must not be. Reading the operation path
 * cannot show that: the client may replace a version baked into it.
 * Segment equality, so `v1` does not match `v10`. One listed version has
 * no other request to make.
 */
async function versionedRequest(source: Source): Promise<void> {
  const { apiVersions: versions, defaultApiVersion: fallback } = source.connector;

  for (const version of versions) {
    if (version === fallback) continue;

    const server = new Server(() => ({ body: {} }));
    const client = source.client(server, { api_version: version });

    try {
      await client.check();
    } catch (error: unknown) {
      if (server.calls.length === 0) throw error;
    }

    const url = server.calls[0]?.url;

    if (!url) throw new Error(`api_version ${JSON.stringify(version)} made no request`);

    const segments = new Set(new URL(url).pathname.split("/").filter((segment) => segment !== ""));

    if (!segments.has(version) || segments.has(fallback)) {
      throw new Error(
        `api_version ${JSON.stringify(version)} requested ${url}; that path must contain ${JSON.stringify(version)} and not defaultApiVersion ${JSON.stringify(fallback)}`,
      );
    }
  }
}

async function apiVersions(source: Source): Promise<void> {
  const { apiVersions: versions, defaultApiVersion: fallback } = source.connector;

  if (!versions.includes(fallback)) {
    throw new Error(`defaultApiVersion ${JSON.stringify(fallback)} is not in apiVersions`);
  }

  try {
    source.client(new Server(), { api_version: "conformance-unlisted" });
  } catch {
    return;
  }

  throw new Error("an api_version the package does not list built a client");
}

async function checkPasses(source: Source): Promise<void> {
  const server = new Server({ body: {} });

  equal(await source.client(server).check(), { ok: true }, "check on a 200");
  equal(server.calls.length, 1, "check requests");
  source.checkOperation(server.calls[0]!.url);
}

async function credential(source: Source): Promise<void> {
  const server = new Server({ body: {} });

  await source.client(server).check();

  const call = server.calls[0];

  if (!call) throw new Error("check made no request");

  source.checkOperation(call.url);
  assertSecretNotInUrl(call.url, source);
  assertSchemeHeader(call.headers, source);
}

/** The secret value, and a secret username, stay out of the URL. The Basic encoding does too. */
function assertSecretNotInUrl(url: string, source: Source): void {
  const auth = source.connector.auth;
  const forbidden = [SECRET];

  if (auth.scheme === "basic") {
    const encoded = btoa(`${basicUsername(source)}:${SECRET}`);

    forbidden.push(encoded);

    if (auth.username && !(auth.username in source.connector.configSchema)) {
      forbidden.push(BASIC_USER);
    }
  }

  for (const value of forbidden) {
    if (value !== "" && url.includes(value)) throw new Error(`the secret is in the URL ${url}`);
  }
}

/**
 * The header value the scheme requires. Bearer is `Authorization: Bearer`
 * and the secret. An API key header is that header set to the secret.
 * Basic is `Authorization: Basic` of `username:secret`, with `usernameSuffix`
 * appended when the username does not already end with it.
 */
function assertSchemeHeader(headers: Headers, source: Source): void {
  const auth = source.connector.auth;

  switch (auth.scheme) {
    case "bearer":
      expectHeader(headers, "authorization", `Bearer ${SECRET}`);
      return;
    case "api_key_header":
      expectHeader(headers, auth.header ?? "", SECRET);
      return;
    case "basic":
      expectHeader(headers, "authorization", `Basic ${btoa(`${basicUsername(source)}:${SECRET}`)}`);
      return;
    default:
      throw new Error(`scheme ${auth.scheme} has no credential check`);
  }
}

function expectHeader(headers: Headers, name: string, expected: string): void {
  const value = headers.get(name);

  if (value !== expected) {
    throw new Error(`${name} is ${JSON.stringify(value)}, not ${JSON.stringify(expected)}`);
  }
}

/** The username the client must send: the field the suite supplied, plus any suffix. */
function basicUsername(source: Source): string {
  const auth = source.connector.auth;
  const binding = source.binding();
  const field = auth.username ?? "";
  const supplied =
    field in source.connector.configSchema ? binding.config[field] : binding.secrets[field];
  const username = typeof supplied === "string" ? supplied : "";
  const suffix = auth.usernameSuffix ?? "";

  if (username === "" || suffix === "" || username.endsWith(suffix)) return username;

  return `${username}${suffix}`;
}

async function runCredential(
  connector: CatalogSource,
  name: string,
  body: () => Promise<void>,
): Promise<ConformanceCheck> {
  if (!connector.auth.secret) return skipped(name, "no auth secret");
  if (connector.auth.scheme === "api_key_query") return skipped(name, QUERY_SKIP);

  return run(name, body);
}

async function userAgent(source: Source): Promise<void> {
  const server = new Server({ body: {} });

  await source.client(server).check();

  const call = server.calls[0];

  if (!call) throw new Error("check made no request");

  source.checkOperation(call.url);

  if (!call.headers.get("user-agent")) throw new Error("no user-agent header");
}

async function checkRefusals(source: Source): Promise<void> {
  const secret = source.connector.auth?.secret ?? "";

  for (const [status, reason] of [
    [401, "authentication"],
    [403, "authorization"],
  ] as const) {
    const result = await source.client(new Server({ body: "nope", status })).check();

    equal({ ok: result.ok, reason: result.reason }, { ok: false, reason }, `check on a ${status}`);

    if (!result.message?.includes(secret)) {
      throw new Error(`the ${status} message does not name ${secret}: ${result.message}`);
    }
    if (JSON.stringify(result).includes(SECRET)) {
      throw new Error(`the ${status} result contains the secret`);
    }
  }
}

async function checkThrows(source: Source): Promise<void> {
  // A 429 from this server carries Retry-After: 0, so the client retries at once.
  await expectStatus(
    source,
    429,
    (calls) => {
      if (calls < 2) {
        throw new Error(
          `check should send at least 2 requests for a 429 (the first try plus a wait), but sent ${calls}`,
        );
      }
    },
    { "retry-after": "0" },
  );
  await expectStatus(source, 503, (calls) => {
    if (calls !== 3) {
      throw new Error(
        `check should send 3 requests for a 503 (the first try plus 2 retries), but sent ${calls}`,
      );
    }
  });
}

async function expectStatus(
  source: Source,
  status: number,
  assertCalls: (calls: number) => void,
  headers?: Record<string, string>,
): Promise<void> {
  const server = new Server(() => ({ body: "busy", status, headers }));
  const thrown = await thrownBy(source, server);

  if (!message(thrown).includes(String(status))) {
    throw new Error(
      `check should name status ${status} in the error, but said: ${message(thrown)}`,
    );
  }
  if (message(thrown).includes(SECRET)) {
    throw new Error(`check should leave the secret out of the ${status} error`);
  }

  assertCalls(server.calls.length);
}

async function thrownBy(source: Source, server: Server): Promise<unknown> {
  try {
    await source.client(server).check();
  } catch (error: unknown) {
    return error;
  }

  throw new Error("check did not throw");
}

function replyResponse(reply: Reply | undefined): Response {
  if (!reply) return new Response("the conformance suite queued no reply", { status: 404 });

  return new Response(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), {
    status: reply.status ?? 200,
    statusText: reply.statusText ?? "",
    headers: reply.headers,
  });
}

const SCHEMES = ["none", "bearer", "api_key_header", "api_key_query", "basic"] as const;
const CONFIG_VALUES = ["string", "integer", "boolean", "json"] as const;

/**
 * The default export and `Client`. A package can typecheck its own helpers
 * and still not be something `defineConfig` can register. Read as `unknown`
 * so a cast at the call site does not skip the check.
 */
function assertSourceExports(connector: SourceConnector): void {
  const exported = connector as unknown as Record<string, unknown>;
  const definition = exported["default"];

  if (!isRecord(definition)) throw new Error("default is not the connector definition");

  assertText(definition["type"], "type is not a connection type name");
  assertDocs(definition["docs"]);
  assertAuth(definition["auth"]);
  assertConfigSchema(definition["configSchema"]);
  assertStringList(definition["secretFields"], "secretFields is not a list of names");
  assertVersions(definition["apiVersions"], definition["defaultApiVersion"]);
  assertBaseUrl(definition["defaultBaseUrl"]);
  assertClient(exported["Client"]);
}

function assertDocs(docs: unknown): void {
  if (typeof docs !== "string" || !docs.startsWith("https://")) {
    throw new Error("docs is not an https URL");
  }
}

function assertVersions(versions: unknown, fallback: unknown): void {
  if (!isStringList(versions) || versions.length === 0) {
    throw new Error("apiVersions is not a list of versions");
  }

  if (typeof fallback !== "string" || fallback === "") {
    throw new Error("defaultApiVersion is not a version");
  }
}

function assertBaseUrl(baseUrl: unknown): void {
  if (baseUrl !== undefined && typeof baseUrl !== "string") {
    throw new Error("defaultBaseUrl is not a string");
  }
}

function assertClient(Client: unknown): void {
  if (typeof Client !== "function") throw new Error("Client is not a constructor");

  if (!hasMethod(Client, "close") || !hasMethod(Client, "check")) {
    throw new Error("Client does not implement Source: close() and check() are required");
  }
}

function assertAuth(auth: unknown): void {
  if (!isRecord(auth) || !isScheme(auth["scheme"])) {
    throw new Error(
      `auth.scheme ${JSON.stringify(isRecord(auth) ? auth["scheme"] : auth)} is not a catalog scheme`,
    );
  }

  if (auth["scheme"] === "none") return;

  assertText(auth["secret"], "auth.secret is missing");
  assertSchemeDetail(auth, "api_key_header", "header");
  assertSchemeDetail(auth, "api_key_query", "parameter");
  assertSchemeDetail(auth, "basic", "username");
}

function assertSchemeDetail(auth: Record<string, unknown>, scheme: string, field: string): void {
  if (auth["scheme"] !== scheme) return;

  assertText(auth[field], `auth.${field} is missing`);
}

function assertConfigSchema(schema: unknown): void {
  if (!isStringRecord(schema)) throw new Error("configSchema is not an object");

  for (const [key, value] of Object.entries(schema)) {
    if (!(CONFIG_VALUES as readonly string[]).includes(value)) {
      throw new Error(
        `configSchema.${key} is ${JSON.stringify(value)}, not ${CONFIG_VALUES.join(" | ")}`,
      );
    }
  }
}

function assertText(value: unknown, why: string): void {
  if (typeof value !== "string" || value === "") throw new Error(why);
}

function assertStringList(value: unknown, why: string): void {
  if (!isStringList(value)) throw new Error(why);
}

function isScheme(value: unknown): value is (typeof SCHEMES)[number] {
  return typeof value === "string" && (SCHEMES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * `Source` methods are prototype methods (`JsonClient` supplies `close`) or
 * instance fields (`check = () => ...`). A constructor that throws never
 * built an instance, so only the prototype result counts.
 */
function hasMethod(ctor: unknown, name: string): boolean {
  if (typeof ctor !== "function") return false;

  let onPrototype = false;
  let current: object | null = ctor.prototype as object | null;

  while (current && current !== Object.prototype) {
    if (typeof (current as Record<string, unknown>)[name] === "function") {
      onPrototype = true;
      break;
    }

    current = Object.getPrototypeOf(current) as object | null;
  }

  try {
    const instance: unknown = new (ctor as new (...args: unknown[]) => unknown)({}, {}, {});

    return onPrototype || functionField(instance, name);
  } catch {
    return onPrototype;
  }
}

function functionField(instance: unknown, name: string): boolean {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as Record<string, unknown>)[name] === "function"
  );
}

function skipped(name: string, detail: string): ConformanceCheck {
  return { name, status: "skipped", detail };
}

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8"));
}
