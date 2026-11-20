/**
 * Where `puppi login` keeps the server URL and the API key.
 *
 * The file is `~/.config/puppi/config.json`, or `$XDG_CONFIG_HOME/puppi`,
 * or `PUPPI_CONFIG_DIR` when that is set. The mode is `0600`. The key is
 * never written to stdout or to a log.
 */

import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type Args, flag } from "./args.js";

export const DEFAULT_SERVER = "https://app.puppi.dev";

export class CredentialsError extends Error {}

export interface StoredCredentials {
  server: string;
  token: string;
}

function configDir(): string {
  const override = process.env["PUPPI_CONFIG_DIR"];

  if (override) return override;

  const xdg = process.env["XDG_CONFIG_HOME"];

  if (xdg) return join(xdg, "puppi");

  return join(homedir(), ".config", "puppi");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** `--engine-url` or `PUPPI_ENGINE_URL`, ahead of the saved server and the defaults. */
function explicitServer(args: Args): string | undefined {
  return flag(args, "engine-url") ?? process.env["PUPPI_ENGINE_URL"];
}

/**
 * Flag, then `PUPPI_ENGINE_URL`, then the saved server, then the hosted
 * default.
 */
export function resolveServer(args: Args): string {
  const explicit = explicitServer(args);

  if (explicit) return trimSlash(explicit);

  return trimSlash(readCredentialsSync()?.server ?? DEFAULT_SERVER);
}

/**
 * The key from `puppi login`, sent only when `server` has the same origin
 * as the server that issued it.
 */
export function resolveToken(server: string): string | undefined {
  const saved = readCredentialsSync();

  if (!saved || !sameOrigin(server, saved.server)) return undefined;

  return saved.token;
}

export function readCredentialsSync(): StoredCredentials | undefined {
  const path = configPath();

  if (!existsSync(path)) return undefined;

  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new CredentialsError(
      "could not read saved credentials; run `puppi logout` and `puppi login`",
    );
  }

  return parseCredentials(text);
}

export async function writeCredentials(credentials: StoredCredentials): Promise<void> {
  const dir = configDir();
  const path = configPath();
  const body = `${JSON.stringify({ server: trimSlash(credentials.server), token: credentials.token }, null, 2)}\n`;

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(path, body, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function deleteCredentials(): Promise<void> {
  await rm(configPath(), { force: true });
}

function parseCredentials(text: string): StoredCredentials {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CredentialsError(
      "saved credentials could not be read; run `puppi logout` and `puppi login`",
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new CredentialsError(
      "saved credentials could not be read; run `puppi logout` and `puppi login`",
    );
  }

  const record = parsed as Record<string, unknown>;

  if (typeof record["server"] !== "string" || record["server"] === "") {
    throw new CredentialsError(
      "saved credentials could not be read; run `puppi logout` and `puppi login`",
    );
  }

  if (typeof record["token"] !== "string" || record["token"] === "") {
    throw new CredentialsError(
      "saved credentials could not be read; run `puppi logout` and `puppi login`",
    );
  }

  return { server: record["server"], token: record["token"] };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Scheme, host, and port. Default ports compare equal. A bad URL does not. */
function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}
