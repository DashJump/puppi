/**
 * The client's Ed25519 signing key.
 *
 * `puppi keys create` writes the private seed, or reads `PUPPI_SIGNING_KEY`
 * when CI already has it, and prints the public key a worker trusts. Deploy,
 * env create and env bind sign with that key when one is configured. The
 * bytes are `signingPayload` from `@puppi/sdk`, the same function the worker
 * verifies, so the two sides cannot serialise a subject differently.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { signingPayload, type SigningSubject } from "@puppi/sdk";

import { type Args, flag, has, UsageError } from "./args.js";
import { type Command, type Outcome, done, helpBlock } from "./command.js";
import { err, out } from "./print.js";

/**
 * Printed when this command leaves a row with no signature. A row that
 * keeps the signature it already has does not get this line. Exit stays 0.
 * A re-bind that would change a signed config exits 2 without this line.
 */
const UNSIGNED_WARNING =
  "NOT SIGNED. A worker with trusted keys will refuse this. " +
  "Set PUPPI_SIGNING_KEY, --signing-key, PUPPI_SIGNING_KEY_FILE, or puppi-signing-key.";

/**
 * A remote worker with trusted keys refuses an unsigned row. A local
 * executor does not check signatures, and neither does `hosted`. Any other
 * value keeps `NOT SIGNED`, because hiding that line without knowing the
 * executor is the wrong default.
 */
export function skipsSignatureCheck(executor: string | undefined): executor is "local" | "hosted" {
  return executor === "local" || executor === "hosted";
}

export function warnUnsigned(executor?: string): void {
  // stderr, same as NOT SIGNED. `env create --json` and `env bind --json`
  // print the object on stdout, and a line in front of it is not JSON.
  err(
    skipsSignatureCheck(executor)
      ? `unsigned. A ${executor} executor does not check signatures.`
      : UNSIGNED_WARNING,
  );
}

/** Where `puppi keys create` writes the seed when `--out` is not given. */
export const SIGNING_KEY_FILE = "puppi-signing-key";

/** PKCS#8 prefix for a 32-byte Ed25519 seed. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** SPKI prefix for a raw Ed25519 public key. The worker strips the same bytes. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface SigningKey {
  /** `ed25519:<base64>` of the raw public key. This is what a worker trusts. */
  id: string;
  /** SHA-256 hex of the raw public key. The same digest a worker reports. */
  fingerprint: string;
  /** `ed25519:<base64>` of the 32-byte seed. This is the file and the env var. */
  material: string;
  privateKey: KeyObject;
}

export interface Signature {
  signature: string;
  signing_key: string;
}

/** A new key. The seed never leaves `material`. */
function createSigningKey(): SigningKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });

  return keyFromSeed(Buffer.from(pkcs8).subarray(pkcs8.length - 32));
}

/** Sign `subject`. The engine stores the result and does not check it. */
export function signSubject(subject: SigningSubject, key: SigningKey): Signature {
  return {
    signature: sign(null, Buffer.from(signingPayload(subject)), key.privateKey).toString("base64"),
    signing_key: key.id,
  };
}

/**
 * The key to sign with, or undefined when the user has not configured one.
 *
 * `PUPPI_SIGNING_KEY` wins, so CI does not pick up a file on the runner.
 * Then `--signing-key`, then `PUPPI_SIGNING_KEY_FILE`, then
 * `<dir>/puppi-signing-key` when that file exists. A path that was asked for
 * and is missing is an error. A default file that is absent means "do not sign".
 */
export async function loadSigningKey(
  dir: string,
  explicitPath?: string,
): Promise<SigningKey | undefined> {
  const inline = process.env["PUPPI_SIGNING_KEY"]?.trim();

  if (inline) return parseSigningKey(inline, "PUPPI_SIGNING_KEY");

  const fromEnv = process.env["PUPPI_SIGNING_KEY_FILE"]?.trim() || undefined;
  const path = explicitPath ?? fromEnv ?? resolve(dir, SIGNING_KEY_FILE);
  const optional = explicitPath === undefined && !fromEnv;

  try {
    return parseSigningKey(await readFile(path, "utf8"), path);
  } catch (error: unknown) {
    if (optional && isMissing(error)) return undefined;

    if (isMissing(error)) throw new UsageError(`no signing key at ${path}`);

    throw error;
  }
}

interface KeysResult {
  public_key: string;
  fingerprint: string;
  path: string | null;
  inline: boolean;
}

async function keysCommand(args: Args, dir: string): Promise<Outcome<KeysResult>> {
  const [subcommand] = args.positional;

  if (subcommand !== "create" || args.positional.length > 1) {
    throw new UsageError(
      "puppi keys create writes a signing key. `puppi keys create [--out <file>]`",
    );
  }

  const inline = process.env["PUPPI_SIGNING_KEY"]?.trim();
  const key = inline ? parseSigningKey(inline, "PUPPI_SIGNING_KEY") : createSigningKey();
  const destination = flag(args, "out") ?? (inline ? undefined : resolve(dir, SIGNING_KEY_FILE));

  if (destination) await writeSigningKey(destination, key, args);

  return done({
    public_key: key.id,
    fingerprint: key.fingerprint,
    path: destination ?? null,
    inline: Boolean(inline && !destination),
  });
}

function renderKeys(row: KeysResult): void {
  out(row.public_key);

  if (row.path) err(`wrote ${row.path}`);
  if (row.inline) err("read PUPPI_SIGNING_KEY");

  err(`fingerprint ${row.fingerprint}`);
}

async function writeSigningKey(path: string, key: SigningKey, args: Args): Promise<void> {
  const exists = await readFile(path, "utf8").then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false;

      throw error;
    },
  );

  if (exists && !has(args, "force")) {
    throw new UsageError(`${path} already exists. Pass --force to overwrite it.`);
  }

  await writeFile(path, `${key.material}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function parseSigningKey(text: string, source: string): SigningKey {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  const material = lines[0];

  if (lines.length !== 1 || !material?.startsWith("ed25519:")) {
    throw new Error(`${source} must be one line, ed25519:<base64 of the 32-byte seed>`);
  }

  let seed: Buffer;

  try {
    seed = Buffer.from(material.slice("ed25519:".length), "base64");
  } catch {
    throw new Error(`${source} is not base64`);
  }

  if (seed.length !== 32) {
    throw new Error(`${source} must be a 32-byte Ed25519 seed`);
  }

  return keyFromSeed(seed);
}

function keyFromSeed(seed: Buffer): SigningKey {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = Buffer.from(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
  const rawPublic = spki.subarray(spki.length - 32);

  if (rawPublic.length !== 32 || !spki.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) {
    throw new Error("ed25519 public key was not the expected length");
  }

  return {
    id: `ed25519:${rawPublic.toString("base64")}`,
    fingerprint: createHash("sha256").update(rawPublic).digest("hex"),
    material: `ed25519:${seed.toString("base64")}`,
    privateKey,
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export const keys: Command<KeysResult> = {
  name: "keys",
  help: [
    helpBlock(230, [
      "  puppi keys create                    an Ed25519 key. Prints the public key.",
      "                                       [--out <file>] [--force]. Or reads PUPPI_SIGNING_KEY.",
    ]),
    helpBlock(240, [""]),
  ],
  flags: [{ name: "out", valued: true }, { name: "force" }],
  run: (ctx) => keysCommand(ctx.args, ctx.dir),
  render: renderKeys,
};
