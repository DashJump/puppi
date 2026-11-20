import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const ENV_PREFIX = "PUPPI_SECRET_";

/**
 * A secret name is a single path segment. Anything else is not a name this
 * machine will resolve, so a lease cannot point a read outside the directory.
 */
export function safeSecretName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);
}

/**
 * Names this machine can resolve: files in `dir`, then `PUPPI_SECRET_<NAME>`.
 *
 * `readSecret` looks up the uppercased name (`PUPPI_SECRET_WAREHOUSE_PASSWORD`).
 * Only a variable whose suffix is already that uppercase form is advertised,
 * and it is advertised as the lowercased secret name. A lowercase variable
 * is a different key on a case-sensitive host, so listing it would show the
 * secret as present while the attempt still refuses it.
 */
export function listSecretNames(dir: string | undefined): string[] {
  const names = new Set<string>();

  if (dir) {
    let entries: { isFile(): boolean; name: string }[] = [];

    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (entry.isFile() && safeSecretName(entry.name)) names.add(entry.name);
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(ENV_PREFIX) || value === undefined || value === "") continue;

    const suffix = key.slice(ENV_PREFIX.length);
    if (suffix !== suffix.toUpperCase()) continue;

    const name = suffix.toLowerCase();
    if (safeSecretName(name)) names.add(name);
  }

  return [...names].sort();
}

/**
 * The value for `name`, from `dir/<name>` first and `PUPPI_SECRET_` plus
 * the name in upper case otherwise. A missing name is `undefined`. The
 * value is never logged.
 */
export function readSecret(name: string, dir: string | undefined): string | undefined {
  if (!safeSecretName(name)) return undefined;

  const fromFile = dir ? readFile(dir, name) : undefined;
  if (fromFile !== undefined) return fromFile;

  const fromEnv = process.env[`${ENV_PREFIX}${name.toUpperCase()}`];
  if (fromEnv === undefined || fromEnv === "") return undefined;

  return fromEnv;
}

/** Replaces each secret value in every string. Longer values are masked first. */
export function scrub(value: unknown, secrets: readonly string[]): unknown {
  const sorted = secrets.filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
  if (sorted.length === 0) return value;

  return walk(value, sorted);
}

function readFile(dir: string, name: string): string | undefined {
  const path = join(dir, name);
  if (basename(path) !== name) return undefined;

  try {
    const text = readFileSync(path, "utf8");
    return text.endsWith("\n") ? text.slice(0, -1) : text;
  } catch {
    return undefined;
  }
}

function walk(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return mask(value, secrets);
  if (Array.isArray(value)) return value.map((item) => walk(item, secrets));

  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) out[key] = walk(item, secrets);

    return out;
  }

  return value;
}

function mask(text: string, secrets: readonly string[]): string {
  let out = text;

  for (const secret of secrets) out = out.split(secret).join("[redacted]");

  return out;
}
