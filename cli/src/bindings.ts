/**
 * `bindings.local.json`: which environment a project develops against, and
 * the value of every binding and secret in it.
 *
 * It is deliberately not `puppi.config.ts`. The config declares what a
 * connection *is* — its type and its schema — and is committed; this
 * one says where that connection is reached today, and is not. The values
 * are resolved from wherever the **engine** runs, which is why they are
 * `{ env, default }` rather than literals: the same file serves an engine on
 * this machine and one in a container.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Binding } from "@puppi/sdk/protocol";

export const BINDINGS_FILE = "bindings.local.json";

/** A literal, or `{ env, default }` read from the environment at setup time. */
export type ValueSource = unknown;

export interface DeclaredBinding {
  config?: Record<string, ValueSource>;
  secret_refs?: Record<string, string>;
  mode?: Binding["mode"];
}

export interface BindingsFile {
  /** The environment these values belong to, when the project names one. */
  environment?: string;
  bindings: Record<string, DeclaredBinding>;
  secrets?: Record<string, ValueSource>;
}

/** One `PUT …/bindings/:name`, with every `{ env }` already resolved. */
export interface ResolvedBinding {
  name: string;
  config: Record<string, unknown>;
  secret_refs: Record<string, string>;
  mode: Binding["mode"];
}

export interface ResolvedSecret {
  name: string;
  value: string;
}

export interface Resolved {
  secrets: ResolvedSecret[];
  bindings: ResolvedBinding[];
}

export async function readBindings(dir: string): Promise<BindingsFile> {
  const path = resolve(dir, BINDINGS_FILE);

  try {
    return JSON.parse(await readFile(path, "utf8")) as BindingsFile;
  } catch {
    throw new Error(
      `no ${BINDINGS_FILE} in ${dir}; it names the environment and the values for each binding`,
    );
  }
}

/**
 * The file as the writes it stands for. `env` is the environment the
 * `{ env }` values are read from — the process's own, layered over whatever
 * the caller knows about where the engine runs.
 */
export function resolveBindings(file: BindingsFile, env: NodeJS.ProcessEnv): Resolved {
  return {
    secrets: Object.entries(file.secrets ?? {}).map(([name, value]) => ({
      name,
      value: String(resolveValue(value, env)),
    })),
    bindings: Object.entries(file.bindings).map(([name, binding]) => ({
      name,
      config: Object.fromEntries(
        Object.entries(binding.config ?? {}).map(([field, value]) => [
          field,
          resolveValue(value, env),
        ]),
      ),
      secret_refs: binding.secret_refs ?? {},
      mode: binding.mode ?? "live",
    })),
  };
}

/** The declared default's type decides the variable's: `{ env: "PGPORT", default: 5432 }` is a number. */
function resolveValue(value: ValueSource, env: NodeJS.ProcessEnv): unknown {
  if (typeof value !== "object" || value === null || !("env" in value)) return value;

  const spec = value as { env: string; default?: unknown };
  const fromEnv = env[spec.env];

  if (fromEnv === undefined) return spec.default;

  return typeof spec.default === "number" ? Number(fromEnv) : fromEnv;
}
