import { adapter } from "./adapter.js";
import { registeredAdapter } from "./registry.js";
import type { AdapterConstructor } from "./types.js";

/**
 * Where an asset writes when it does not name a storage connection. A string
 * is one storage for every role; a map is per-role. The CLI checks the role
 * names — this type is only the shape a project writes.
 */
export type DefaultStorageConfig =
  | string
  | {
      source?: string;
      raw?: string;
      model?: string;
      destination?: string;
    };

/**
 * One connection in `defineConfig`.
 *
 * A connector module (`import * as postgres from "@puppi/adapter-postgres"`)
 * default-exports the `defineConnector` definition and exports `Client`.
 * A project-local client is `{ type, Client, clientModule }`. Anything else
 * is refused. `config_schema` and `secret_fields` still win when a binding
 * is narrower than the adapter allows. A catalog module gets
 * `@puppi/adapter-<type>` as its `clientModule`.
 */
export interface ConnectionInput {
  /** Set on a project-local client. A connector module carries it on `default`. */
  type?: string;
  /**
   * A connector module's default export: the `defineConnector` definition.
   * `type`, `configSchema`, and `secretFields` are read from here.
   */
  default?: {
    type: string;
    configSchema?: Readonly<Record<string, string>>;
    secretFields?: readonly string[];
  };
  /** Manifest override. Wins over the adapter's `configSchema`. */
  config_schema?: Record<string, unknown>;
  /** Manifest override. Wins over the adapter's `secretFields`. */
  secret_fields?: readonly string[];
  configSchema?: Readonly<Record<string, string>>;
  secretFields?: readonly string[];
  /**
   * Where `Client` is imported from, for `puppi-env.d.ts`. Catalog modules
   * leave this unset and get `@puppi/adapter-<type>`. A client that lives in
   * the project sets it (`"./src/clearbit.js"`).
   */
  clientModule?: string;
  Client?: AdapterConstructor;
}

/** What `defineConfig` takes. */
export interface PuppiConfig {
  entry?: string;
  out?: string;
  defaultStorage?: DefaultStorageConfig;
  connections?: Record<string, ConnectionInput>;
}

/** A connection after `defineConfig`: the name and the type, plus any override. */
export interface DefinedConnection {
  type: string;
  config_schema?: Record<string, unknown>;
  secret_fields?: string[];
}

/** What `defineConfig` returns, and what the bundle re-exports for the CLI. */
export interface DefinedConfig {
  entry?: string;
  out?: string;
  defaultStorage?: DefaultStorageConfig;
  connections: Record<string, DefinedConnection>;
}

/**
 * Declares where the pipeline and the build output live, and every connection.
 *
 * Passing a catalog module registers its `Client` in the pipeline bundle.
 * Two names may share one module. A second client for the same type is refused.
 */
export function defineConfig(config: PuppiConfig): DefinedConfig {
  const registered = new Map<string, AdapterConstructor>();
  const connections: Record<string, DefinedConnection> = {};

  for (const [name, value] of Object.entries(config.connections ?? {})) {
    connections[name] = declareConnection(name, value, registered);
  }

  return {
    ...(config.entry !== undefined ? { entry: config.entry } : {}),
    ...(config.out !== undefined ? { out: config.out } : {}),
    ...(config.defaultStorage !== undefined ? { defaultStorage: config.defaultStorage } : {}),
    connections,
  };
}

function declareConnection(
  name: string,
  value: ConnectionInput,
  registered: Map<string, AdapterConstructor>,
): DefinedConnection {
  if (value === null || typeof value !== "object") rejectConnection(name);

  const defined = definitionOf(value);
  const client = typeof value.Client === "function" ? value.Client : undefined;

  if (defined && client) {
    registerClient(
      name,
      {
        ...value,
        type: defined.type,
        configSchema: defined.configSchema ?? value.configSchema,
        secretFields: defined.secretFields ?? value.secretFields,
      },
      client,
      registered,
    );

    return connectionFields(defined.type, value);
  }

  if (
    typeof value.type === "string" &&
    value.type &&
    client &&
    typeof value.clientModule === "string" &&
    value.clientModule
  ) {
    registerClient(
      name,
      {
        ...value,
        type: value.type,
        configSchema: value.configSchema,
        secretFields: value.secretFields,
      },
      client,
      registered,
    );

    return connectionFields(value.type, value);
  }

  if (client && (typeof value.clientModule !== "string" || !value.clientModule)) {
    throw new Error(
      `connection ${JSON.stringify(name)} passes a Client but no clientModule. ` +
        `Set clientModule to the file that exports it, such as "./src/api.js".`,
    );
  }

  rejectConnection(name, defined?.type ?? value.type);
}

function connectionFields(type: string, value: ConnectionInput): DefinedConnection {
  return {
    type,
    ...(value.config_schema ? { config_schema: { ...value.config_schema } } : {}),
    ...(value.secret_fields ? { secret_fields: [...value.secret_fields] } : {}),
  };
}

function rejectConnection(name: string, type?: string): never {
  if (typeof type === "string" && type) {
    const binding = type.replaceAll("-", "_");

    throw new Error(
      `connection ${JSON.stringify(name)} is type ${JSON.stringify(type)}, which this bundle does not register. ` +
        `Add \`import * as ${binding} from "@puppi/adapter-${type}"\` to puppi.config.ts and pass it to defineConfig.`,
    );
  }

  throw new Error(
    `connection ${JSON.stringify(name)} must be a connector module ` +
      `(\`import * as postgres from "@puppi/adapter-postgres"\`) or a project-local client { type, Client, clientModule }`,
  );
}

/** A connector module's default export. A project-local client has none. */
function definitionOf(value: ConnectionInput): ConnectionInput["default"] | undefined {
  const exported = value.default;

  if (typeof exported !== "object" || exported === null) return undefined;
  if (typeof exported.type !== "string" || !exported.type) return undefined;

  return exported;
}

function registerClient(
  name: string,
  value: ConnectionInput & { type: string },
  Client: AdapterConstructor,
  registered: Map<string, AdapterConstructor>,
): void {
  const previous = registered.get(value.type) ?? registeredAdapter(value.type)?.Client;

  if (previous) {
    if (previous !== Client) {
      throw new Error(
        `connection ${JSON.stringify(name)} registers type "${value.type}" with a ` +
          `different Client than the one already registered for that type`,
      );
    }

    return;
  }

  registered.set(value.type, Client);
  adapter({
    type: value.type,
    ...(value.configSchema ? { configSchema: schemaOf(name, value.configSchema) } : {}),
    ...(value.secretFields ? { secretFields: [...value.secretFields] } : {}),
    clientModule: value.clientModule ?? `@puppi/adapter-${value.type}`,
    Client,
  });
}

function schemaOf(name: string, value: Readonly<Record<string, string>>): Record<string, string> {
  const schema: Record<string, string> = {};

  for (const [key, field] of Object.entries(value)) {
    if (typeof field !== "string") {
      throw new Error(
        `connection ${JSON.stringify(name)} has configSchema.${key} that is not a string`,
      );
    }

    schema[key] = field;
  }

  return schema;
}
