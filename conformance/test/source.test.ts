import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  authHeaders,
  classifyOperations,
  type ClientOptions,
  OpenApiClient,
  requireApiVersion,
} from "@puppi/sdk";
import { describe, expect, it } from "vite-plus/test";

import { runSourceConformance, type ConformanceCheck, type SourceConnector } from "../src/index.js";

/**
 * Each of these sources lies in one way, and the suite has to name it. The
 * honest one passes every check, so a failure below is the lie and nothing
 * else.
 */
interface Lies {
  /** Also sends the key as a query parameter on `check`. */
  secretInUrl?: boolean;
  /** Reports every credential as fine. */
  swallowsRefusals?: boolean;
  /** Builds a client for any `api_version`. */
  anyVersion?: boolean;
}

const spec = {
  openapi: "3.1.0",
  info: { title: "example", version: "1" },
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        parameters: [
          { name: "limit", in: "query" },
          { name: "starting_after", in: "query" },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["data", "has_more"],
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/item" } },
                    has_more: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      item: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
  },
};

const operations = classifyOperations(spec);

const VERSION_REQUEST =
  "a non-default API version is a path segment or header value, and the default is not";

const VERSION_HEADER = "x-api-version";

function root(name = "@puppi/adapter-example", document: unknown = spec): URL {
  const dir = mkdtempSync(join(tmpdir(), "source-conformance-"));

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  writeFileSync(join(dir, "openapi.json"), JSON.stringify(document));

  return pathToFileURL(`${dir}/`);
}

function connector(lies: Lies = {}): SourceConnector {
  const configSchema = { base_url: "string" };

  class Client extends OpenApiClient {
    constructor(
      config: Record<string, unknown>,
      secrets: Record<string, string> = {},
      options: ClientOptions = {},
    ) {
      if (!lies.anyVersion) requireApiVersion("example", config, ["v1"], "v1");

      const key = secrets["api_key"] ?? "";

      super(
        config,
        options,
        {
          api: "example",
          baseUrl: "https://api.test",
          headers: authHeaders({ scheme: "bearer", token: key }),
        },
        { operations },
      );
      this.key = key;
    }

    private readonly key: string;

    override check() {
      if (lies.secretInUrl) return this.checkGet(`/items?limit=1&key=${this.key}`, "api_key");
      if (lies.swallowsRefusals) return Promise.resolve({ ok: true } as const);

      return this.prove("/items?limit=1", "api_key");
    }
  }

  return {
    default: {
      type: "example",
      docs: "https://example.test/items",
      configSchema,
      secretFields: ["api_key"],
      auth: { scheme: "bearer", secret: "api_key" },
      apiVersions: ["v1"],
      defaultApiVersion: "v1",
    },
    Client,
  };
}

type Document = Parameters<typeof classifyOperations>[0];

async function checksFor(
  source: SourceConnector,
  options: { name?: string; drift?: boolean; document?: Document } = {},
): Promise<ConformanceCheck[]> {
  const document = options.document ?? spec;

  return runSourceConformance({
    connector: source,
    operations: options.drift ? {} : document === spec ? operations : classifyOperations(document),
    root: root(options.name, document),
    config: { base_url: "https://api.test" },
  });
}

async function failures(
  source: SourceConnector,
  options: { name?: string; drift?: boolean; document?: Document } = {},
): Promise<string[]> {
  const checks = await checksFor(source, options);

  return checks.filter((check) => check.status === "failed").map((check) => check.name);
}

/** The published spec, with its one operation moved onto `path`. */
function specAt(path: string): Document {
  return { ...spec, paths: { [path]: spec.paths["/items"] } };
}

interface VersionedOptions {
  versions?: readonly string[];
  /** Value of `x-api-version`. Absent means the request has no version header. */
  headerFor?: (version: string) => string;
  /** Also sends the key as a query parameter on `check`. */
  queryKey?: boolean;
  /** Pathnames of `check()` calls made with an explicit `api_version`. */
  pinned?: string[];
}

function versionedClient(
  pathFor: (version: string) => string,
  options: VersionedOptions = {},
): SourceConnector {
  const versions = options.versions ?? ["v1", "v2"];
  const source = connector();

  class Client extends OpenApiClient {
    private readonly version: string;
    private readonly pinned: boolean;
    private readonly key: string;

    constructor(
      config: Record<string, unknown>,
      secrets: Record<string, string> = {},
      clientOptions: ClientOptions = {},
    ) {
      const version = requireApiVersion("example", config, versions, "v1");
      const key = secrets["api_key"] ?? "";

      super(
        config,
        clientOptions,
        {
          api: "example",
          baseUrl: "https://api.test",
          headers: {
            ...authHeaders({ scheme: "bearer", token: key }),
            ...(options.headerFor ? { [VERSION_HEADER]: options.headerFor(version) } : {}),
          },
        },
        { operations },
      );
      this.version = version;
      this.pinned = typeof config["api_version"] === "string";
      this.key = key;
    }

    override check() {
      const path = pathFor(this.version);
      const requested = options.queryKey
        ? `${path}${path.includes("?") ? "&" : "?"}key=${this.key}`
        : path;

      if (this.pinned) options.pinned?.push(new URL(requested, "https://api.test").pathname);

      return this.prove(requested, "api_key");
    }
  }

  return {
    ...source,
    default: { ...source.default, apiVersions: versions, defaultApiVersion: "v1" },
    Client,
  };
}

describe("runSourceConformance", () => {
  it("passes an honest source on every check", async () => {
    const checks = await runSourceConformance({
      connector: connector(),
      operations,
      root: root(),
      config: { base_url: "https://api.test" },
    });

    expect(checks.map((check) => [check.status, check.name])).toEqual([
      ["passed", "the module exports the source interface"],
      ["passed", "the package is @puppi/adapter-example"],
      ["passed", "secretFields names what auth reads"],
      ["passed", "the default API version is listed, and any other fails construction"],
      ["passed", VERSION_REQUEST],
      ["passed", "operations.ts is what generate writes from openapi.json"],
      ["passed", "check passes on a 200 from its operation"],
      ["passed", "the credential is a header from the secrets argument, never the URL"],
      ["passed", "every request carries a user agent"],
      ["passed", "check reports 401 as authentication and 403 as authorization"],
      ["passed", "check throws on a 429 and a 503, naming the status, not the secret"],
    ]);
  });

  it("names a package that is not @puppi/adapter-<type>", async () => {
    expect(await failures(connector(), { name: "example-connector" })).toEqual([
      "the package is @puppi/adapter-example",
    ]);
  });

  it("names an operations table that has drifted from the spec", async () => {
    expect(await failures(connector(), { drift: true })).toEqual([
      "operations.ts is what generate writes from openapi.json",
      "check passes on a 200 from its operation",
      "the credential is a header from the secrets argument, never the URL",
      "every request carries a user agent",
    ]);
  });

  it("names a secret sent in the URL", async () => {
    // The 503 error quotes the URL, so the key leaks into the error text too.
    expect(await failures(connector({ secretInUrl: true }))).toEqual([
      "the credential is a header from the secrets argument, never the URL",
      "check throws on a 429 and a 503, naming the status, not the secret",
    ]);
  });

  it("names a check that reports every credential as fine", async () => {
    // It never sends a request, so it proves nothing about the key either.
    expect(await failures(connector({ swallowsRefusals: true }))).toEqual([
      "check passes on a 200 from its operation",
      "the credential is a header from the secrets argument, never the URL",
      "every request carries a user agent",
      "check reports 401 as authentication and 403 as authorization",
      "check throws on a 429 and a 503, naming the status, not the secret",
    ]);
  });

  it("names a client that keeps the default API version in the request path", async () => {
    expect(await failures(versionedClient(() => "/v1/items?limit=1"))).toEqual([VERSION_REQUEST]);
  });

  it("names a request that keeps the default API version next to the selected one", async () => {
    expect(await failures(versionedClient((version) => `/${version}/v1/items?limit=1`))).toEqual([
      VERSION_REQUEST,
    ]);
  });

  it("passes a longer segment that only starts with the default API version", async () => {
    expect(
      await failures(
        versionedClient((version) => `/${version}/items?limit=1`, { versions: ["v1", "v10"] }),
      ),
    ).toEqual([]);
  });

  it("names a longer segment that only starts with the selected API version", async () => {
    expect(await failures(versionedClient(() => "/v20/items?limit=1"))).toEqual([VERSION_REQUEST]);
  });

  it("passes a spec path that contains the default when the request uses the other version", async () => {
    const document = specAt("/v1/items");

    expect(
      await failures(
        versionedClient((version) => `/${version}/items?limit=1`),
        { document },
      ),
    ).toEqual([]);
  });

  it("makes no extra request when the package lists one API version", async () => {
    const pinned: string[] = [];
    const document = specAt("/v1/items");

    expect(
      await failures(
        versionedClient(() => "/v1/items?limit=1", { versions: ["v1"], pinned }),
        {
          document,
        },
      ),
    ).toEqual([]);
    expect(pinned).toEqual([]);
  });

  it("passes a header value that is the selected API version", async () => {
    expect(
      await failures(versionedClient(() => "/items?limit=1", { headerFor: (version) => version })),
    ).toEqual([]);
  });

  it("passes a header value that only starts with the default API version", async () => {
    expect(
      await failures(
        versionedClient(() => "/items?limit=1", {
          versions: ["v1", "v10"],
          headerFor: (version) => version,
        }),
      ),
    ).toEqual([]);
  });

  it("names a header that stays on the default API version", async () => {
    const checks = await checksFor(
      versionedClient(() => "/items?limit=1", { headerFor: () => "v1" }),
    );
    const version = checks.find((check) => check.name === VERSION_REQUEST);

    expect(checks.filter((check) => check.status === "failed").map((check) => check.name)).toEqual([
      VERSION_REQUEST,
    ]);
    expect(version?.detail).toContain(VERSION_HEADER);
    expect(version?.detail).not.toContain("conformance-secret-7f3a");
    expect(version?.detail).not.toContain("?");
  });

  it("leaves the secret out of a version failure when the key is in the query", async () => {
    const checks = await checksFor(versionedClient(() => "/v1/items?limit=1", { queryKey: true }));
    const version = checks.find((check) => check.name === VERSION_REQUEST);

    expect(version?.status).toBe("failed");
    expect(version?.detail).toContain("/v1/items");
    expect(version?.detail).not.toContain("conformance-secret-7f3a");
    expect(version?.detail).not.toContain("?");
  });

  it("names a client that accepts an API version it does not list", async () => {
    expect(await failures(connector({ anyVersion: true }))).toEqual([
      "the default API version is listed, and any other fails construction",
    ]);
  });

  it("names a module that does not export the source interface", async () => {
    const source = connector();

    expect(await failures({ ...source, default: { ...source.default, docs: "" } })).toEqual([
      "the module exports the source interface",
    ]);
  });

  it("names a Client that does not implement Source", async () => {
    class Bare {
      readonly label: string;

      constructor(
        _config: Record<string, unknown>,
        _secrets: Record<string, string>,
        _options: { fetch: typeof fetch },
      ) {
        this.label = "no source methods";
      }
    }

    const checks = await runSourceConformance({
      connector: { ...connector(), Client: Bare as unknown as SourceConnector["Client"] },
      operations,
      root: root(),
      config: { base_url: "https://api.test" },
    });
    const exported = checks.find(
      (check) => check.name === "the module exports the source interface",
    );

    expect(exported?.status).toBe("failed");
    expect(exported?.detail).toMatch(/Source/);
  });

  it("passes a Client whose Source methods are instance fields", async () => {
    class Fields {
      check = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });
      close = (): Promise<void> => Promise.resolve();
    }

    const checks = await runSourceConformance({
      connector: { ...connector(), Client: Fields },
      operations,
      root: root(),
      config: { base_url: "https://api.test" },
    });
    const exported = checks.find(
      (check) => check.name === "the module exports the source interface",
    );

    expect(exported?.status).toBe("passed");
  });

  it("passes an API key header, and basic with a config or secret username", async () => {
    expect(await failures(schemeConnector({ scheme: "api_key_header" }))).toEqual([]);
    expect(await failures(schemeConnector({ scheme: "basic" }))).toEqual([]);
    expect(await failures(schemeConnector({ scheme: "basic", secretUsername: true }))).toEqual([]);
    expect(await failures(schemeConnector({ scheme: "basic", usernameSuffix: "/token" }))).toEqual(
      [],
    );
  }, 10_000);

  it("names a credential sent in the wrong header", async () => {
    const name = "the credential is a header from the secrets argument, never the URL";

    for (const scheme of ["bearer", "api_key_header", "basic"] as const) {
      const checks = await runSourceConformance({
        connector: schemeConnector({ scheme, wrongHeader: true }),
        operations,
        root: root(),
        config: { base_url: "https://api.test" },
      });
      const failed = checks.filter((check) => check.status === "failed");

      expect(failed.map((check) => check.name)).toEqual([name]);
      expect(failed[0]?.detail).toMatch(/authorization|x-api-key/);
    }
  });

  it("names a basic secret sent in the URL", async () => {
    const checks = await runSourceConformance({
      connector: schemeConnector({ scheme: "basic", secretInUrl: true }),
      operations,
      root: root(),
      config: { base_url: "https://api.test" },
    });
    const failed = checks.filter((check) => check.status === "failed");

    expect(failed.map((check) => check.name)).toEqual([
      "the credential is a header from the secrets argument, never the URL",
      "check throws on a 429 and a 503, naming the status, not the secret",
    ]);
    expect(failed[0]?.detail).toMatch(/URL/);
  });

  it("names a basic username suffix the client forgot", async () => {
    expect(
      await failures(
        schemeConnector({ scheme: "basic", usernameSuffix: "/token", forgetSuffix: true }),
      ),
    ).toEqual(["the credential is a header from the secrets argument, never the URL"]);
  });

  it("names basic secretFields that do not match the username's home", async () => {
    const secretUsername = schemeConnector({
      scheme: "basic",
      secretUsername: true,
      omitUsername: true,
    });
    const configUsername = schemeConnector({ scheme: "basic" });

    expect(await failures(secretUsername)).toEqual(["secretFields names what auth reads"]);
    expect(
      await failures({
        ...configUsername,
        default: { ...configUsername.default, secretFields: ["email", "api_token"] },
      }),
    ).toEqual(["secretFields names what auth reads"]);
  });

  it("skips api_key_query credential checks until URLs redact secrets", async () => {
    const checks = await runSourceConformance({
      connector: schemeConnector({ scheme: "api_key_query" }),
      operations,
      root: root(),
      config: { base_url: "https://api.test" },
    });
    const credential = [
      "check passes on a 200 from its operation",
      "the credential is a header from the secrets argument, never the URL",
      "every request carries a user agent",
      "check reports 401 as authentication and 403 as authorization",
      "check throws on a 429 and a 503, naming the status, not the secret",
    ];

    expect(checks.filter((check) => check.status === "failed")).toEqual([]);
    expect(
      checks
        .filter((check) => credential.includes(check.name))
        .map((check) => [check.status, check.detail]),
    ).toEqual(
      credential.map(() => ["skipped", "api_key_query waits until secrets are redacted from URLs"]),
    );
  });
});

interface SchemeOptions {
  scheme: "bearer" | "api_key_header" | "basic" | "api_key_query";
  header?: string;
  username?: string;
  usernameSuffix?: string;
  /** The basic username is a secret, not a config field. */
  secretUsername?: boolean;
  /** Leave that username out of `secretFields`. */
  omitUsername?: boolean;
  /** Send a header the scheme does not name. */
  wrongHeader?: boolean;
  /** Also put the secret on the query string. */
  secretInUrl?: boolean;
  /** Declare `usernameSuffix` but do not send it. */
  forgetSuffix?: boolean;
}

/** A catalog client whose only variable is how it authenticates. */
function schemeConnector(options: SchemeOptions): SourceConnector {
  const secret = options.scheme === "basic" ? "api_token" : "api_key";
  const username = options.username ?? "email";
  const configSchema =
    options.scheme === "basic" && !options.secretUsername
      ? { base_url: "string", [username]: "string" }
      : { base_url: "string" };
  const secretFields =
    options.scheme === "basic" && options.secretUsername && !options.omitUsername
      ? [username, secret]
      : [secret];

  class Client extends OpenApiClient {
    private readonly key: string;

    constructor(
      config: Record<string, unknown>,
      secrets: Record<string, string> = {},
      clientOptions: ClientOptions = {},
    ) {
      requireApiVersion("example", config, ["v1"], "v1");
      const key = secrets[secret] ?? "";

      super(
        config,
        clientOptions,
        {
          api: "example",
          baseUrl: "https://api.test",
          headers: schemeHeaders(options, config, secrets),
        },
        { operations },
      );
      this.key = key;
    }

    override check() {
      const path =
        options.secretInUrl === true || options.scheme === "api_key_query"
          ? `/items?limit=1&key=${this.key}`
          : "/items?limit=1";

      return this.prove(path, secret);
    }
  }

  return {
    default: {
      type: "example",
      docs: "https://example.test/items",
      configSchema,
      secretFields,
      auth: schemeAuth(options, secret, username),
      apiVersions: ["v1"],
      defaultApiVersion: "v1",
    },
    Client,
  };
}

function schemeAuth(
  options: SchemeOptions,
  secret: string,
  username: string,
): SourceConnector["default"]["auth"] {
  if (options.scheme === "api_key_header") {
    return { scheme: "api_key_header", header: options.header ?? "x-api-key", secret };
  }

  if (options.scheme === "api_key_query") {
    return { scheme: "api_key_query", parameter: "api_key", secret };
  }

  if (options.scheme === "basic") {
    return {
      scheme: "basic",
      username,
      secret,
      ...(options.usernameSuffix ? { usernameSuffix: options.usernameSuffix } : {}),
    };
  }

  return { scheme: "bearer", secret };
}

function schemeHeaders(
  options: SchemeOptions,
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): Record<string, string> {
  const secret = options.scheme === "basic" ? "api_token" : "api_key";
  const key = secrets[secret] ?? "";

  if (options.wrongHeader) {
    return options.scheme === "api_key_header"
      ? authHeaders({ scheme: "bearer", token: key })
      : { "x-api-key": key };
  }

  if (options.scheme === "bearer") return authHeaders({ scheme: "bearer", token: key });

  if (options.scheme === "api_key_header") {
    return authHeaders({
      scheme: "api_key_header",
      header: options.header ?? "x-api-key",
      key,
    });
  }

  if (options.scheme === "basic") {
    const field = options.username ?? "email";
    const raw = options.secretUsername ? secrets[field] : config[field];
    const user = typeof raw === "string" ? raw : "";
    const suffix = options.forgetSuffix ? undefined : options.usernameSuffix;

    return authHeaders({ scheme: "basic", username: applySuffix(user, suffix), password: key });
  }

  return {};
}

function applySuffix(username: string, suffix: string | undefined): string {
  if (username === "" || !suffix || username.endsWith(suffix)) return username;

  return `${username}${suffix}`;
}
