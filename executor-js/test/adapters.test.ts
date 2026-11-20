import { Client as Filesystem } from "@puppi/adapter-filesystem";
import { Client as PostgresAdapter } from "@puppi/adapter-postgres";
import { Client as S3 } from "@puppi/adapter-s3";
import type { StorageAdapter } from "@puppi/sdk";
import { describe, expect, it } from "vite-plus/test";

import { construct, isStorage } from "../src/adapters.js";
import { TerminalError } from "../src/errors.js";
import type { Binding, ExecutorInput } from "../src/protocol.js";
import { CheckShim, Shim, storageBinding } from "../src/shim/ctx.js";
import { storageAdapters } from "./support/storage-adapters.js";

const warehouse: Binding = {
  type: "postgres",
  config: { host: "127.0.0.1", database: "x", user: "u" },
  secrets: { password: "p" },
  mode: "live",
};

const http: Binding = {
  type: "http",
  config: { base_url: "https://api.test" },
  secrets: {},
  mode: "live",
};

function input(overrides: Partial<ExecutorInput> = {}): ExecutorInput {
  return {
    bundle_ref: "/b.js",
    sdk_version: "0.2.0",
    asset_key: "core/x",
    partition: "",
    inputs: {},
    checkpoint: null,
    cursor_from: null,
    bindings: { warehouse, http },
    storage_connection: "warehouse",
    output_storage_ref: "p.t",
    connections: {},
    ...overrides,
  };
}

class HttpClient {
  constructor(
    readonly config: Record<string, unknown>,
    readonly secrets: Record<string, string>,
  ) {}
}

const httpAdapter = {
  http: {
    type: "http",
    config_schema: {},
    secret_fields: [],
    Client: HttpClient,
  },
};

describe("the adapter registry", () => {
  it("constructs the adapter a binding's type names, from its config and secrets", async () => {
    const client = construct("http", http, httpAdapter);
    expect(client).toBeInstanceOf(HttpClient);

    const storage = construct("warehouse", warehouse, storageAdapters);
    expect(storage).toBeInstanceOf(PostgresAdapter);
    expect(isStorage(storage)).toBe(true);
    expect(isStorage(client)).toBe(false);
    // Never connected, so closing is a no-op rather than a hang.
    await (storage as PostgresAdapter).close();
  });

  it("holds a materialization on a filesystem or s3 binding as well as on postgres", () => {
    const lake: Binding = {
      type: "filesystem",
      config: { root: "/tmp/x" },
      secrets: {},
      mode: "live",
    };
    const bucket: Binding = {
      type: "s3",
      config: { bucket: "b" },
      secrets: { access_key_id: "k", secret_access_key: "s" },
      mode: "live",
    };

    const files = construct("lake", lake, storageAdapters);
    const objects = construct("bucket", bucket, storageAdapters);

    expect(files).toBeInstanceOf(Filesystem);
    expect(objects).toBeInstanceOf(S3);
    expect(isStorage(files)).toBe(true);
    expect(isStorage(objects)).toBe(true);
  });

  it("refuses an unknown type as terminal: no retry will install a package", () => {
    expect(() => construct("crm", { ...http, type: "salesforce" })).toThrow(TerminalError);
    expect(() => construct("crm", { ...http, type: "salesforce" })).toThrow(/puppi\.config\.ts/);
  });
});

/**
 * The escape hatch: a platform this workspace does not serve is reached by
 * an adapter the user declares in their own project, which rides in the
 * deployment bundle. Nothing is installed on the engine host, and the
 * adapter's version is pinned by the deployment that carries it.
 */
describe("an adapter the bundle carries", () => {
  class AcmeClient {
    constructor(
      readonly config: Record<string, unknown>,
      readonly secrets: Record<string, string>,
    ) {}
  }

  const acme: Binding = {
    type: "acme",
    config: { base_url: "https://acme.test" },
    secrets: { api_key: "k" },
    mode: "live",
  };
  const bundled = {
    acme: {
      type: "acme",
      config_schema: {},
      secret_fields: ["api_key"],
      Client: AcmeClient,
    },
  };

  it("is constructed from the binding the bundle carries", () => {
    const client = construct("acme", acme, bundled) as AcmeClient;

    expect(client).toBeInstanceOf(AcmeClient);
    expect(client.config).toEqual({ base_url: "https://acme.test" });
    expect(client.secrets).toEqual({ api_key: "k" });
  });

  it("can hold a materialization when it implements the storage surface", () => {
    class Lake {
      async write() {
        return {
          storage_ref: "p.t",
          observed_schema: [],
          stats: { row_count: 0, bytes: null, content_hash: null },
        };
      }
      async read() {
        return [];
      }
      async query() {
        return [];
      }
      async drop() {}
      async close() {}
    }

    expect(isStorage(new Lake())).toBe(true);
    expect(isStorage(new AcmeClient({}, {}))).toBe(false);
  });

  it("is not a table store without drop", () => {
    class Rows {
      async write() {
        return {
          storage_ref: "p.t",
          observed_schema: [],
          stats: { row_count: 0, bytes: null, content_hash: null },
        };
      }
      async read() {
        return [];
      }
      async query() {
        return [];
      }
      async close() {}
    }

    expect(isStorage(new Rows())).toBe(false);
  });

  it("keeps filesystem, s3, and postgres on the table surface", () => {
    for (const Client of [Filesystem, S3, PostgresAdapter]) {
      const proto = Client.prototype as unknown as Record<string, unknown>;

      expect(typeof proto["write"]).toBe("function");
      expect(typeof proto["read"]).toBe("function");
      expect(typeof proto["query"]).toBe("function");
      expect(typeof proto["drop"]).toBe("function");
    }

    for (const Client of [Filesystem, PostgresAdapter]) {
      const proto = Client.prototype as unknown as Record<string, unknown>;

      expect(typeof proto["put"]).not.toBe("function");
      expect(typeof proto["get"]).not.toBe("function");
      expect(typeof proto["head"]).not.toBe("function");
    }

    const files = S3.prototype as unknown as Record<string, unknown>;

    expect(typeof files["put"]).toBe("function");
    expect(typeof files["get"]).toBe("function");
    expect(typeof files["head"]).toBe("function");
  });

  it("holds a file when it implements put, get, head, and drop", () => {
    class Files {
      async put(): Promise<{ sha256: string; bytes: number; contentType: string | null }> {
        return { sha256: "a", bytes: 1, contentType: null };
      }
      async get(): Promise<ReadableStream<Uint8Array>> {
        return new ReadableStream();
      }
      async head(): Promise<null> {
        return null;
      }
      async drop(): Promise<void> {}
      async close(): Promise<void> {}
    }

    expect(isStorage(new Files())).toBe(true);
  });

  it("uses the postgres client the bundle carries", () => {
    const carried = { ...bundled, postgres: { ...bundled["acme"], type: "postgres" } };

    expect(construct("warehouse", warehouse, carried)).toBeInstanceOf(AcmeClient);
  });

  it("uses the http client the bundle carries", () => {
    const impostor = { ...bundled, http: { ...bundled["acme"], type: "http" } };

    expect(construct("http", http, impostor)).toBeInstanceOf(AcmeClient);
  });

  it("is still an unknown type when the bundle does not carry it", () => {
    expect(() => construct("acme", acme)).toThrow(TerminalError);
    expect(() => construct("acme", acme)).toThrow(/puppi\.config\.ts/);
  });
});

describe("the storage binding", () => {
  it("is the one the engine named, whatever its config looks like", () => {
    expect(storageBinding(input()).name).toBe("warehouse");
  });

  it("is the named postgres when two postgres bindings are present", () => {
    const oltp: Binding = {
      ...warehouse,
      config: { ...warehouse.config, database: "oltp" },
    };

    const named = storageBinding(
      input({ bindings: { oltp, warehouse }, storage_connection: "warehouse" }),
    );

    expect(named.name).toBe("warehouse");
    expect(named.binding.config["database"]).toBe("x");
  });

  it("is a filesystem storage with no postgres binding anywhere", () => {
    const lake: Binding = {
      type: "filesystem",
      config: { root: "/tmp/lake" },
      secrets: {},
      mode: "live",
    };

    expect(storageBinding(input({ bindings: { lake }, storage_connection: "lake" })).name).toBe(
      "lake",
    );
    expect(isStorage(construct("lake", lake, storageAdapters))).toBe(true);
  });

  it("is terminal when the engine named none, or one it did not resolve", () => {
    expect(() => storageBinding(input({ storage_connection: null }))).toThrow(
      /no storage connection/,
    );
    expect(() => storageBinding(input({ storage_connection: "lake" }))).toThrow(
      /resolved no binding/,
    );
  });
});

describe("a shim taken apart", () => {
  // A check is written `({ rows, output, query }) => …` and a producer may
  // do `const { emit } = ctx`; a destructured method would lose `this`.
  it("keeps working when a check destructures query and log", async () => {
    const logs: string[] = [];
    const adapter = { query: async () => [{ n: 1 }] } as unknown as StorageAdapter;
    const shim = new CheckShim([], "p.t", adapter, (event) => {
      if (event.event === "log") logs.push(event.message);
    });

    const { query, log } = shim;

    await expect(query("select 1")).resolves.toEqual({ rows: [{ n: 1 }] });
    log("judged");
    expect(logs).toEqual(["judged"]);
  });

  it("keeps working when a producer destructures input, emit and checkpoint", async () => {
    const events: string[] = [];
    const shim = new Shim(
      { ...input(), inputs: { "raw/a": { materialization_id: "m1", storage_ref: "p.raw_a" } } },
      {} as StorageAdapter,
      "live",
      (event) => void events.push(event.event),
    );

    const { input: read, emit, checkpoint, log } = shim;

    expect(read("raw/a")).toBe("p.raw_a");
    await emit([{ id: "x" }]);
    checkpoint({ page: 1 });
    log("emitted");

    expect(shim.collect()).toEqual([{ id: "x" }]);
    // The shim's own spans ride along, so its instrumentation survives being
    // taken apart too.
    expect(events).toEqual(["read", "span", "span", "checkpoint", "span", "log"]);
  });
});

describe("ctx.connection()", () => {
  it("hands out the client the pool constructed for a bound connection", () => {
    const constructed: string[] = [];
    const shim = new Shim(input(), {} as StorageAdapter, "live", () => {}, {
      get: (name) => {
        constructed.push(name);
        return { name };
      },
    });

    expect(shim.connection("http")).toEqual({ name: "http" });
    expect(constructed).toEqual(["http"]);
  });

  it("is terminal for a connection the attempt did not resolve", () => {
    const shim = new Shim(input(), {} as StorageAdapter, "live", () => {});

    expect(() => shim.connection("clearbit")).toThrow(TerminalError);
    expect(() => shim.connection("clearbit")).toThrow(/Bound for this attempt: warehouse, http/);
  });
});
