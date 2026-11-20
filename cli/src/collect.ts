import { pathToFileURL } from "node:url";

import type { Declaration, Registry } from "@puppi/sdk";

/**
 * The normalized config the bundle re-exports. Connections are `{ type }`
 * plus any override — the `Client` stayed in the registry, not here.
 */
export interface BundleConfig {
  entry?: string;
  out?: string;
  defaultStorage?: unknown;
  connections?: unknown;
}

export interface CollectedBundle {
  registry: Registry;
  config: BundleConfig;
}

/**
 * Collect mode: load the bundle, which runs the config and the pipeline,
 * and read the registry and the normalized config it exports.
 */
export async function collect(bundlePath: string): Promise<CollectedBundle> {
  // Cache-busted so a rebuild in the same process sees the new bundle.
  const url = `${pathToFileURL(bundlePath).href}?t=${Date.now()}`;
  const module = (await import(url)) as { default?: Registry; config?: BundleConfig };

  if (!module.default?.assets || !module.config?.connections) {
    throw new Error(
      `${bundlePath} does not export a collect-mode registry. ` +
        `The CLI generates that entry, so this usually means the bundle was ` +
        `not produced by \`puppi build\`.`,
    );
  }

  return { registry: module.default, config: module.config };
}

/** The producer's source, for the compile pass and `code_version`. */
export function producerSource(declaration: Declaration): string | null {
  const producer = declaration.run ?? declaration.sql;

  return typeof producer === "function" ? producer.toString() : null;
}

/**
 * The custom check bodies by name, for `code_version` only: a stricter check
 * changes what this asset's materializations are judged by, which is a
 * behaviour change. The compile pass does not read them — a check has no
 * `ctx.input()`.
 */
export function checkSources(declaration: Declaration): Record<string, string> {
  return Object.fromEntries(
    Object.entries(declaration.customChecks ?? {}).map(([name, check]) => [name, check.toString()]),
  );
}
