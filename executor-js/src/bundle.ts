/**
 * Loading a collect-mode bundle. Both the engine's runtime and the local
 * harness (`local/`) import the same file the CLI wrote, so what counts as a
 * usable bundle is decided in one place.
 */

import { pathToFileURL } from "node:url";

import type { Declaration, Registry } from "@puppi/sdk";

import { TerminalError } from "./errors.js";

export async function loadRegistry(bundleRef: string): Promise<Registry> {
  const module = (await import(pathToFileURL(bundleRef).href)) as { default?: Registry };

  if (!module.default?.assets) {
    throw new TerminalError(
      `bundle ${bundleRef} does not default-export a collect-mode registry ` +
        `({ assets: { ... } })`,
    );
  }

  // `adapters` arrived after `assets`; a bundle from an older CLI has none.
  return { ...module.default, adapters: module.default.adapters ?? {} };
}

/** The asset the caller asked for, or the list it could have asked for instead. */
export function declarationOf(registry: Registry, key: string): Declaration {
  const declaration = registry.assets[key];

  if (declaration) return declaration;

  throw new TerminalError(
    `bundle does not declare ${key}; it has ` +
      (Object.keys(registry.assets).join(", ") || "no assets"),
  );
}
