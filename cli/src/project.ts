import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isNil } from "es-toolkit";

import { importConfig } from "./bundle.js";
import { shortSha256 } from "./hash.js";
import {
  type DeclaredConnection,
  type DefaultStorage,
  STORAGE_DEFAULT_ROLES,
  type StorageDefaultRole,
} from "./manifest.js";

/** `puppi.config.ts`: `defineConfig({ entry, out, defaultStorage, connections })`. */
export const CONFIG_FILE = "puppi.config.ts";

/** Whether `path` can be reached. Any failure, a missing path included, is false. */
export async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

const DEFAULTS = { entry: "src/pipeline.ts", out: "dist" };

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

/**
 * The source of `puppi.config.ts`. A leftover `puppi.config.json` is named
 * in the error: the build no longer reads it.
 */
async function readConfigSource(dir: string): Promise<string> {
  try {
    return await readFile(resolve(dir, CONFIG_FILE), "utf8");
  } catch {
    const json = await readFile(resolve(dir, "puppi.config.json"), "utf8").catch(() => null);

    if (json !== null) {
      throw new Error(
        `no ${CONFIG_FILE} in ${dir}; puppi.config.json is no longer read. ` +
          `Export defineConfig() from ${CONFIG_FILE}.`,
      );
    }

    throw new Error(`no ${CONFIG_FILE} in ${dir}`);
  }
}

/**
 * Resolved `entry` and `out`, plus the config file the pipeline bundle imports.
 *
 * `entry` and `out` are whatever the module evaluates to, including a function
 * return. Connections and the clients they register still come from the
 * pipeline bundle: `importConfig` throws its own registry away.
 */
export async function buildPaths(
  dir: string,
): Promise<{ entry: string; out: string; config: string }> {
  await readConfigSource(dir);
  const config = resolve(dir, CONFIG_FILE);
  const defined = definedConfig(await importConfig(config));

  return {
    entry: resolve(dir, stringField(defined["entry"], "entry") ?? DEFAULTS.entry),
    out: resolve(dir, stringField(defined["out"], "out") ?? DEFAULTS.out),
    config,
  };
}

function definedConfig(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value["connections"])) {
    throw new Error(`${CONFIG_FILE} must default-export defineConfig({ ... })`);
  }

  return value;
}

function stringField(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== "string" || !value) {
    throw new Error(`${CONFIG_FILE}: ${name} must be a string`);
  }

  return value;
}

/**
 * Connections as `defineConfig` returned them. A `Client` still on the value
 * means the config module exported the raw module instead of `defineConfig()`,
 * so the bundle would not have registered it.
 */
export function declaredConnections(value: unknown): Record<string, DeclaredConnection> {
  if (value === undefined) return {};

  if (!isRecord(value)) throw new Error("connections must be a map of name to connection");

  const connections: Record<string, DeclaredConnection> = {};

  for (const [name, connection] of Object.entries(value)) {
    connections[name] = declaredConnection(name, connection);
  }

  return connections;
}

function declaredConnection(name: string, connection: unknown): DeclaredConnection {
  if (!isRecord(connection)) {
    throw new Error(
      `connection ${JSON.stringify(name)} must be { type } or a module whose default ` +
        `export is the connector definition, with Client`,
    );
  }

  if (typeof connection["Client"] === "function") {
    throw new Error(
      `connection ${JSON.stringify(name)} still carries a Client. ` +
        `Export defineConfig() from ${CONFIG_FILE} so the class is registered in the bundle.`,
    );
  }

  const type = connection["type"];

  if (typeof type !== "string" || !type) {
    throw new Error(`connection ${JSON.stringify(name)} must declare a type`);
  }

  return connectionFields(name, type, connection);
}

function connectionFields(
  name: string,
  type: string,
  connection: Record<string, unknown>,
): DeclaredConnection {
  const configSchema = schema(name, connection["config_schema"]);
  const secrets = secretFields(name, connection["secret_fields"]);

  return {
    type,
    ...(configSchema ? { config_schema: configSchema } : {}),
    ...(secrets ? { secret_fields: secrets } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A string is one storage for everything. A map is per-role. Anything
 * else — an unknown role, a non-name value — is a build error now, not
 * a silent warehouse landing for raw.
 */
export function parseDefaultStorage(value: unknown): DefaultStorage | undefined {
  if (isNil(value) || value === "") return undefined;

  if (typeof value === "string") return value;

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "defaultStorage must be a connection name or a map of role to connection " +
        `(source, raw, model, destination)`,
    );
  }

  const mapped: { [K in StorageDefaultRole]?: string } = {};

  for (const [role, connection] of Object.entries(value)) {
    if (!(STORAGE_DEFAULT_ROLES as readonly string[]).includes(role)) {
      throw new Error(
        `defaultStorage.${role} is not a role; roles are ${STORAGE_DEFAULT_ROLES.join(", ")}`,
      );
    }

    if (typeof connection !== "string" || !connection) {
      throw new Error(`defaultStorage.${role} must be a connection name`);
    }

    mapped[role as StorageDefaultRole] = connection;
  }

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

/** Hash of the nearest lockfile above `dir`, walking up to the filesystem root. Provenance only. */
export async function lockfileHash(dir: string): Promise<string> {
  for (let current = dir; ; current = dirname(current)) {
    for (const name of LOCKFILES) {
      const contents = await readFile(resolve(current, name), "utf8").catch(() => null);

      if (contents !== null) return `sha256:${shortSha256(contents)}`;
    }

    if (dirname(current) === current) return "none";
  }
}

function schema(name: string, value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`connection ${JSON.stringify(name)} config_schema must be an object`);
  }

  return value as Record<string, unknown>;
}

function secretFields(name: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;

  if (!Array.isArray(value) || value.some((field) => typeof field !== "string")) {
    throw new Error(`connection ${JSON.stringify(name)} secret_fields must be a list of names`);
  }

  return value as string[];
}
