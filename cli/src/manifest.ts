import {
  type AssetSchema,
  canonicalJson,
  type Declaration,
  type DeclaredChecks,
  type GroupDefinition,
  type Partitioning,
  type Registry,
  type Schedule,
  type Visibility,
} from "@puppi/sdk";
import type { ConnectionDirection } from "@puppi/sdk/protocol";
import { isNil } from "es-toolkit";

import { checkSources, producerSource } from "./collect.js";
import type { CompileResult } from "./compile.js";
import { shortSha256 } from "./hash.js";

export interface ManifestAsset {
  key: string;
  group: string;
  visibility: Visibility;
  role: string;
  producer: string;
  deps: string[];
  /**
   * Connection name -> direction. Compiled from `ctx.connection()` and
   * from `reads` / `writes`. Absent when the producer reaches none, so an
   * asset that reaches nothing keeps its `code_version`.
   */
  connections?: Record<string, ConnectionDirection>;
  partitioning: Partitioning;
  /**
   * When the engine fires this asset by itself. Absent when it declares no
   * schedule, so an unscheduled asset keeps the `code_version` it had
   * before the field existed.
   */
  schedule?: Schedule;
  storage: { connection?: string };
  /** Days to keep a whole materialization. Absent when the asset omitted it, so the hash is unchanged. */
  retention?: number;
  config: Record<string, unknown>;
  checks: DeclaredChecks;
  code_version: string;
  schema?: AssetSchema;
}

export interface ConnectionDeclaration {
  type: string;
  config_schema: Record<string, unknown>;
  secret_fields: string[];
}

/**
 * An adapter the build can see. `Client` stays in memory so the compile pass
 * can read method direction. `stores` is the table surface (`write`, `read`,
 * `query`, `drop`). `files` is the object surface (`put`, `get`, `head`,
 * `drop`). The manifest drops `Client`.
 */
type KnownAdapter = ConnectionDeclaration & {
  stores?: boolean;
  /** The client implements `put`, `get`, `head`, and `drop`. Set when `Client` was not kept. */
  files?: boolean;
  Client?: unknown;
};

/**
 * A connection as `puppi.config.ts` writes it. Only the name and the type
 * are the project's own business: the technical fields describe the adapter,
 * so they come from the client the bundle registered. Writing them here
 * still wins, which is the escape hatch for a binding that is narrower than
 * the adapter allows.
 */
export interface DeclaredConnection {
  type: string;
  config_schema?: Record<string, unknown>;
  secret_fields?: string[];
}

export interface Manifest {
  sdk_version: string;
  lockfile_hash: string;
  groups: GroupDefinition[];
  connections: Record<string, ConnectionDeclaration>;
  assets: ManifestAsset[];
}

/** Roles that may have their own storage default in `puppi.config.ts`. */
export const STORAGE_DEFAULT_ROLES = ["source", "raw", "model", "destination"] as const;
export type StorageDefaultRole = (typeof STORAGE_DEFAULT_ROLES)[number];

/**
 * Where assets write when they do not name a storage connection. A string
 * is one storage for every role; a map is one value per role. A missing map
 * key is not the other roles' value — that fallback is what made raw land
 * in the warehouse.
 */
export type DefaultStorage = string | { [K in StorageDefaultRole]?: string };

export interface BuildManifestOptions {
  registry: Registry;
  compiled: CompileResult;
  sdkVersion: string;
  lockfileHash: string;
  connections: Record<string, DeclaredConnection>;
  /** The connection for any asset that does not name its own. */
  defaultStorage?: DefaultStorage;
}

/** Registry + compiled deps = manifest. Generated, never hand-maintained. */
export function buildManifest(options: BuildManifestOptions): Manifest {
  const { registry, compiled, defaultStorage } = options;
  validateGroups(registry);

  // Sorted by key in code-unit order, so the manifest is the same on every machine.
  const assets = Object.keys(registry.assets)
    .sort()
    .map((key) => manifestAsset(key, registry.assets[key]!, compiled, defaultStorage));

  assertFiles(assets, compiled, options);
  assertSameStorage(assets);

  return {
    sdk_version: options.sdkVersion,
    lockfile_hash: options.lockfileHash,
    groups: Object.values(registry.groups).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    connections: declareConnections(options.connections, options.registry.adapters),
    assets,
  };
}

/**
 * The manifest's connection declarations: what the project named, completed
 * from what the adapter for that type declares. Without this the technical
 * fields are hand-copied from the adapter into `puppi.config.ts`, and
 * drift the first time the adapter changes.
 */
function declareConnections(
  declared: Record<string, DeclaredConnection>,
  adapters: Record<string, ConnectionDeclaration>,
): Record<string, ConnectionDeclaration> {
  return Object.fromEntries(
    Object.entries(declared).map(([name, connection]) => [
      name,
      completed(connection, adapters[connection.type]),
    ]),
  );
}

/** Nothing declared for this type: the project's own values, or empty. */
const UNSERVED = { config_schema: {}, secret_fields: [] };

function completed(
  connection: DeclaredConnection,
  registered: ConnectionDeclaration | undefined,
): ConnectionDeclaration {
  const adapter = registered ?? UNSERVED;

  return {
    type: connection.type,
    config_schema: connection.config_schema ?? adapter.config_schema,
    secret_fields: connection.secret_fields ?? adapter.secret_fields,
  };
}

/**
 * Whether this client holds a table materialization. The same question the
 * executor asks: `write`, `read`, `query`, and `drop` are on the class.
 */
export function storesRows(Client: unknown): boolean {
  if (typeof Client !== "function") return false;

  const proto = (Client as { prototype?: Record<string, unknown> }).prototype;

  return (
    typeof proto?.["write"] === "function" &&
    typeof proto?.["read"] === "function" &&
    typeof proto?.["query"] === "function" &&
    typeof proto?.["drop"] === "function"
  );
}

/** Whether this client can hold one object per materialization. */
export function storesFiles(Client: unknown): boolean {
  if (typeof Client !== "function") return false;

  const proto = (Client as { prototype?: Record<string, unknown> }).prototype;

  return (
    typeof proto?.["put"] === "function" &&
    typeof proto?.["get"] === "function" &&
    typeof proto?.["head"] === "function" &&
    typeof proto?.["drop"] === "function"
  );
}

function manifestAsset(
  key: string,
  declaration: Declaration,
  compiled: CompileResult,
  defaultStorage: DefaultStorage | undefined,
): ManifestAsset {
  const storage = storageOf(declaration, defaultStorage);
  const connections = compiled.connections[key] ?? {};

  const config: Record<string, unknown> = {
    ...declaration.config,
    ...(compiled.files[key] ? { output: "file" } : {}),
  };

  const definition = {
    group: declaration.group,
    visibility: declaration.visibility,
    role: declaration.role,
    producer: declaration.producer,
    deps: [...new Set([...(compiled.deps[key] ?? []), ...declaration.deps])].sort(),
    ...(Object.keys(connections).length > 0 ? { connections } : {}),
    partitioning: declaration.partitioning,
    ...(declaration.schedule ? { schedule: declaration.schedule } : {}),
    storage: storage ? { connection: storage } : {},
    ...(typeof declaration.retention === "number" ? { retention: declaration.retention } : {}),
    config,
    checks: declaration.checks,
    ...(declaration.schema ? { schema: declaration.schema } : {}),
  };

  return {
    key,
    ...definition,
    // The SDK's canonical JSON, so a manifest and a signature sort keys the same way.
    code_version: `cli-${shortSha256(canonicalJson(versioned(definition, declaration)))}`,
  };
}

/**
 * Where the asset's materialization lives. `storage` on the declaration
 * wins, then the per-role default, then the project-wide string. The same
 * rule for every role.
 */
function storageOf(
  declaration: Declaration,
  defaultStorage: DefaultStorage | undefined,
): string | undefined {
  return declaration.storage ?? resolveDefaultStorage(declaration.role, defaultStorage);
}

/** The default for one role. A map key that is absent is undefined, not another role's value. */
function resolveDefaultStorage(
  role: string,
  defaults: DefaultStorage | undefined,
): string | undefined {
  if (isNil(defaults)) return undefined;
  if (typeof defaults === "string") return defaults;

  return defaults[role as StorageDefaultRole];
}

/**
 * A role default that names a connection which is missing, or whose client
 * does not implement `write`, `read`, `query`, and `drop`. Silent fallback
 * is the bug; the names that would work are the ones whose client does.
 */
export function unservableStorageDefaults(
  defaults: DefaultStorage | undefined,
  connections: Record<string, { type: string; config_schema?: Record<string, unknown> }>,
  adapters: Record<string, { Client?: unknown; stores?: boolean }>,
): string[] {
  if (isNil(defaults)) return [];

  if (typeof defaults === "string") {
    const error = unservableDefault("defaultStorage", defaults, connections, adapters);

    return error ? [error] : [];
  }

  return STORAGE_DEFAULT_ROLES.flatMap((role) => {
    const name = defaults[role];

    if (!name) return [];

    const error = unservableDefault(`defaultStorage.${role}`, name, connections, adapters);

    return error ? [error] : [];
  });
}

function assertFiles(
  assets: ManifestAsset[],
  compiled: CompileResult,
  options: BuildManifestOptions,
): void {
  const adapters = options.registry.adapters;
  const fileKeys = new Set(Object.keys(compiled.files));

  for (const asset of assets) {
    if (!fileKeys.has(asset.key)) continue;

    if (asset.role === "destination") {
      throw new Error(
        `${asset.key} stores a file and is a destination. A file asset is full_refresh.`,
      );
    }

    const mode = asset.config["mode"];

    if (mode === "append" || mode === "incremental" || mode === "view") {
      throw new Error(`${asset.key} stores a file and is ${mode}. A file asset is full_refresh.`);
    }

    const storage = asset.storage.connection;

    if (!connectionStoresFiles(storage, options.connections, adapters)) {
      throw new Error(
        `${asset.key} stores a file through "${storage ?? ""}", which does not implement put, get, head, and drop.`,
      );
    }
  }

  for (const asset of assets) {
    if (fileKeys.has(asset.key)) continue;

    const storage = namedTableStorage(options.registry.assets[asset.key]);

    if (!storage || !lacksTableSurface(storage, options.connections, adapters)) continue;

    throw new Error(
      `${asset.key} stores a table through "${storage}", which does not implement write, read, query, and drop.`,
    );
  }

  for (const asset of assets) {
    if (asset.producer !== "sql") continue;

    for (const dep of asset.deps) {
      if (!fileKeys.has(dep)) continue;

      throw new Error(
        `${asset.key} is a sql model and reads ${dep}, a file. Only a TS producer can read a file.`,
      );
    }
  }
}

/**
 * A sql producer pastes the input's table name into SQL that runs on the
 * reader's storage. A TS producer is not this check. A file input is refused
 * separately.
 */
function assertSameStorage(assets: ManifestAsset[]): void {
  const byKey = new Map(assets.map((asset) => [asset.key, asset]));
  const errors: string[] = [];

  for (const asset of assets) {
    if (asset.producer !== "sql") continue;

    const reader = asset.storage.connection;

    if (!reader) continue;

    for (const dep of asset.deps) {
      const input = byKey.get(dep);
      const upstream = input?.storage.connection;

      if (!input || !upstream || input.config["output"] === "file" || upstream === reader) {
        continue;
      }

      errors.push(
        `${asset.key} (${reader}) reads ${dep} (${upstream}): inputs must be in the same storage`,
      );
    }
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));
}

/** The storage the asset named, rather than one it inherited from `defaultStorage`. */
function namedTableStorage(declaration: Declaration | undefined): string | undefined {
  return declaration?.storage;
}

/**
 * True when this build can see the client, and the client is not a table
 * store. An adapter the build has not loaded is left to the engine.
 */
function lacksTableSurface(
  name: string,
  connections: Record<string, DeclaredConnection>,
  adapters: Record<string, KnownAdapter>,
): boolean {
  const connection = connections[name];

  if (!connection) return false;

  const adapter = adapters[connection.type];

  if (!adapter) return false;
  if (adapter.Client !== undefined) return !storesRows(adapter.Client);
  if (adapter.stores !== undefined) return !adapter.stores;

  return false;
}

function connectionStoresFiles(
  name: string | undefined,
  connections: Record<string, DeclaredConnection>,
  adapters: Record<string, KnownAdapter>,
): boolean {
  if (!name) return false;

  const connection = connections[name];

  if (!connection) return false;

  const adapter = adapters[connection.type];

  if (!adapter) return false;
  if (adapter.Client !== undefined) return storesFiles(adapter.Client);

  return adapter.files === true;
}

function connectionStores(
  connection: { type: string },
  adapters: Record<string, { Client?: unknown; stores?: boolean }>,
): boolean {
  const adapter = adapters[connection.type];

  if (!adapter) return false;
  if (adapter.Client !== undefined) return storesRows(adapter.Client);

  return adapter.stores === true;
}

function unservableDefault(
  where: string,
  name: string,
  connections: Record<string, { type: string; config_schema?: Record<string, unknown> }>,
  adapters: Record<string, { Client?: unknown; stores?: boolean }>,
): string | undefined {
  const capable = Object.entries(connections)
    .filter(([, connection]) => connectionStores(connection, adapters))
    .map(([connectionName]) => connectionName)
    .sort();
  const wouldWork =
    capable.length > 0
      ? `Connections that would work: ${capable.join(", ")}.`
      : "No connection in this project holds a materialization.";

  const declared = connections[name];

  if (!declared) {
    return `${where} is "${name}", which is not a declared connection. ${wouldWork}`;
  }

  // No adapter and an empty schema means the type was not completed —
  // `undeclaredTypes` already warns. Refusing here would hide that warning
  // behind a storage error for a connection we do not yet know.
  const schema = declared.config_schema ?? {};
  if (!adapters[declared.type] && Object.keys(schema).length === 0) return undefined;

  if (!connectionStores(declared, adapters)) {
    return `${where} is "${name}", which holds no materialization. ${wouldWork}`;
  }

  return undefined;
}

/**
 * What `code_version` hashes: the definition plus the code the engine cannot
 * see. Check sources join only when there are any, so an asset without
 * custom checks keeps the version it had before they existed.
 */
function versioned(definition: object, declaration: Declaration): Record<string, unknown> {
  const checks = checkSources(declaration);
  const behavior = Object.fromEntries(
    Object.entries(definition).filter(
      ([key]) => key !== "group" && key !== "visibility" && key !== "retention",
    ),
  );

  return {
    ...behavior,
    source: producerSource(declaration) ?? "",
    ...(Object.keys(checks).length > 0 ? { checks_source: checks } : {}),
  };
}

function validateGroups(registry: Registry): void {
  const definitions = Object.values(registry.groups);
  const names = new Set(definitions.map((definition) => definition.name));

  if (!names.has("default"))
    throw new Error('manifest groups must include the implicit "default" group');

  for (const asset of Object.values(registry.assets)) {
    const selected = registry.groups[asset.group];

    if (!selected) throw new Error(`${asset.key} references unknown group ${asset.group}`);
    if (rank(asset.visibility) < rank(selected.visibility)) {
      throw new Error(
        `${asset.key} cannot lower visibility from ${selected.visibility} to ${asset.visibility}`,
      );
    }
    if (asset.visibility === "public" && !asset.schema) {
      throw new Error(`public asset ${asset.key} must declare a schema`);
    }
  }
}

function rank(visibility: Visibility): number {
  return { group: 0, project: 1, public: 2 }[visibility];
}

/** Illegal dependency edges after compiled and explicit deps have been unioned. */
export function visibilityViolations(manifest: Manifest): {
  asset: string;
  dep: string;
  message: string;
}[] {
  const assets = new Map(manifest.assets.map((asset) => [asset.key, asset]));
  const violations: { asset: string; dep: string; message: string }[] = [];

  for (const consumer of manifest.assets) {
    for (const dep of consumer.deps) {
      const upstream = assets.get(dep);

      if (upstream?.visibility === "group" && upstream.group !== consumer.group) {
        violations.push({
          asset: consumer.key,
          dep,
          message:
            `${consumer.key} (${consumer.group}) depends on group-visible ${dep} ` +
            `(${upstream.group}); this deployment is valid only in a lenient environment`,
        });
      }
    }
  }

  return violations;
}

/**
 * Every connection an attempt resolves for this asset: the ones behind
 * `ctx.connection()`, then storage. A wider set would let a typo pass
 * locally and fail on the engine. When one name is reached more than one
 * way, the first reason is the one a warning reports.
 */
export function reachedConnections(asset: ManifestAsset): { name: string; via: string }[] {
  const reached = [
    ...Object.keys(asset.connections ?? {})
      .sort()
      .map((name) => ({ name, via: "ctx.connection()" })),
    ...(asset.storage.connection ? [{ name: asset.storage.connection, via: "storage" }] : []),
  ];
  const seen = new Set<string>();

  return reached.filter(({ name }) => {
    if (seen.has(name)) return false;

    seen.add(name);
    return true;
  });
}
