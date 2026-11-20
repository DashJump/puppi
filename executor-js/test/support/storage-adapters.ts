/**
 * The storage connectors a test bundle has to carry. `postgres`, `filesystem`,
 * and `s3` arrive the way a project does: `defineConfig` registers their `Client`.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import * as filesystem from "@puppi/adapter-filesystem";
import * as postgres from "@puppi/adapter-postgres";
import * as s3 from "@puppi/adapter-s3";
import { collect, defineConfig, type RegisteredAdapter } from "@puppi/sdk";

defineConfig({ connections: { filesystem, postgres, s3 } });

export const storageAdapters: Record<string, RegisteredAdapter> = collect().adapters;

const require = createRequire(import.meta.url);

function specifier(name: string): string {
  return JSON.stringify(pathToFileURL(require.resolve(name)).href);
}

/** Imports the three clients into a bundle written as source text. */
export function storageAdapterPrelude(): string {
  return `import { collect, defineConfig } from ${specifier("@puppi/sdk")};
import * as filesystem from ${specifier("@puppi/adapter-filesystem")};
import * as postgres from ${specifier("@puppi/adapter-postgres")};
import * as s3 from ${specifier("@puppi/adapter-s3")};
defineConfig({ connections: { filesystem, postgres, s3 } });
const storageAdapters = collect().adapters;
`;
}

/** Puts the storage clients on a bundle, beside any adapter the test already declares. */
export function bundleCarryingStorage(source: string): string {
  if (source.includes("const storageAdapters") || !source.includes("adapters:")) return source;

  const next = /adapters:\s*\{\s*\}/.test(source)
    ? source.replace(/adapters:\s*\{\s*\}/g, "adapters: storageAdapters")
    : source.replace(/adapters:\s*\{/g, "adapters: { ...storageAdapters, ");

  return `${storageAdapterPrelude()}${next}`;
}
