import { createHash, createPublicKey, verify } from "node:crypto";

import { pageStorageRef } from "@puppi/adapter-storage";
import { canonicalJson, signingPayload, type SigningSubject } from "@puppi/sdk";

import type { ExecutorInput } from "../protocol.js";
import { PAGE_LIST } from "../shim/pages.js";
import type { Residency } from "./residency.js";
import { readSecret } from "./secrets.js";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface TrustedKey {
  /** `ed25519:<base64>` as configured. */
  id: string;
  raw: Buffer;
  fingerprint: string;
}

export interface LeaseView {
  digest: string;
  input: ExecutorInput;
  workerSecrets: Record<string, Record<string, string>>;
  signatures: unknown;
}

export interface Admitted {
  ok: true;
  input: ExecutorInput;
  values: string[];
  signingKey: string | null;
}

export interface Refused {
  ok: false;
  reason: string;
  signingKey: string | null;
}

export type Decision = Admitted | Refused;

export interface TrustConfig {
  residency: Residency;
  trustedKeys: readonly TrustedKey[];
  secretsDir: string | undefined;
}

/** `PUPPI_TRUSTED_KEYS`, a comma-separated list of `ed25519:<base64>` public keys. */
export function parseTrustedKeys(raw: string | undefined): TrustedKey[] {
  if (!raw) return [];

  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map(parseTrustedKey);
}

export function fingerprintOf(signingKey: string): string | null {
  const raw = rawKey(signingKey);
  if (!raw) return null;

  return createHash("sha256").update(raw).digest("hex");
}

export const STRICT_REQUIRES_TRUSTED_KEYS = "PUPPI_RESIDENCY=strict requires PUPPI_TRUSTED_KEYS";

/**
 * Whether this worker will run `lease`.
 *
 * A `strict` worker refuses a secret value that is not null. Trusted keys
 * require a signature on the bundle, the environment, and every binding.
 * Storage refs must sit under the signed prefix. A missing worker secret
 * refuses before a child starts.
 */
export function admit(lease: LeaseView, config: TrustConfig): Decision {
  const signingKey = deploymentFingerprint(lease.signatures);
  const held = engineHeld(lease.input);

  if (config.residency === "strict" && held.length > 0) {
    return refuse(`redeclare \`${held.join("`, `")}\` --on-worker`, signingKey);
  }

  if (config.trustedKeys.length > 0) {
    const signed = verifyLease(lease, config.trustedKeys, signingKey);
    if (!signed.ok) return signed;
  }

  return fill(lease, config.secretsDir, signingKey);
}

function parseTrustedKey(value: string): TrustedKey {
  const raw = rawKey(value);

  if (!raw) throw new Error("PUPPI_TRUSTED_KEYS entries must be ed25519:<base64>");

  return { id: value, raw, fingerprint: createHash("sha256").update(raw).digest("hex") };
}

function rawKey(value: string) {
  if (!value.startsWith("ed25519:")) return null;

  try {
    const raw = Buffer.from(value.slice("ed25519:".length), "base64");
    return raw.length === 32 ? raw : null;
  } catch {
    return null;
  }
}

/** A present value other than null was supplied by the engine. */
function engineHeld(input: ExecutorInput): string[] {
  const names: string[] = [];

  for (const [binding, body] of Object.entries(input.bindings)) {
    const secrets = body.secrets as Record<string, unknown>;

    for (const [field, value] of Object.entries(secrets)) {
      if (value !== null) names.push(`${binding}.${field}`);
    }
  }

  return names;
}

function verifyLease(
  lease: LeaseView,
  keys: readonly TrustedKey[],
  signingKey: string | null,
): Decision {
  const signatures = isRecord(lease.signatures) ? lease.signatures : {};
  const deployment = verifySubject(
    signatures["deployment"],
    keys,
    (body) =>
      typeof body["bundle_digest"] === "string"
        ? { kind: "deployment", bundle_digest: body["bundle_digest"] }
        : null,
    "unsigned bundle",
  );

  if (!deployment.ok) return refuse(deployment.reason, signingKey);

  if (deployment.subject.bundle_digest !== lease.digest) {
    return refuse("bundle digest does not match its signature", signingKey);
  }

  const environment = verifySubject(
    signatures["environment"],
    keys,
    (body) =>
      typeof body["name"] === "string" && typeof body["storage_prefix"] === "string"
        ? { kind: "environment", name: body["name"], storage_prefix: body["storage_prefix"] }
        : null,
    "unsigned environment",
  );

  if (!environment.ok) return refuse(environment.reason, signingKey);

  const bindings = isRecord(signatures["bindings"]) ? signatures["bindings"] : {};
  const prefix = environment.subject.storage_prefix;

  for (const [name, binding] of Object.entries(lease.input.bindings)) {
    const signed = verifySubject(
      bindings[name],
      keys,
      (body) => bindingSubject(body),
      `unsigned binding ${name}`,
    );

    if (!signed.ok) return refuse(signed.reason, signingKey);

    if (!bindingMatches(name, binding, signed.subject, lease.workerSecrets[name])) {
      return refuse(`binding ${name} does not match its signature`, signingKey);
    }
  }

  const outside = refOutside(lease.input, prefix);
  if (outside) return refuse(outside, signingKey);

  return { ok: true, input: lease.input, values: [], signingKey };
}

function fill(lease: LeaseView, dir: string | undefined, signingKey: string | null): Decision {
  const input: ExecutorInput = {
    ...lease.input,
    bindings: { ...lease.input.bindings },
  };
  const values: string[] = [];

  for (const [name, fields] of Object.entries(lease.workerSecrets)) {
    const binding = input.bindings[name];
    if (!binding) return refuse(`unsigned binding ${name}`, signingKey);

    const secrets = { ...binding.secrets };

    for (const [field, secret] of Object.entries(fields)) {
      const value = readSecret(secret, dir);
      if (value === undefined) {
        return refuse(`worker secret ${secret} is not on this machine`, signingKey);
      }

      secrets[field] = value;
      values.push(value);
    }

    input.bindings[name] = { ...binding, secrets };
  }

  return { ok: true, input, values, signingKey };
}

function bindingSubject(
  body: Record<string, unknown>,
): Extract<SigningSubject, { kind: "binding" }> | null {
  if (
    typeof body["name"] !== "string" ||
    typeof body["type"] !== "string" ||
    typeof body["mode"] !== "string" ||
    !isRecord(body["config"]) ||
    !stringMap(body["secret_refs"])
  ) {
    return null;
  }

  return {
    kind: "binding",
    name: body["name"],
    type: body["type"],
    config: body["config"],
    secret_refs: body["secret_refs"],
    mode: body["mode"],
  };
}

function bindingMatches(
  name: string,
  binding: ExecutorInput["bindings"][string],
  signed: Extract<SigningSubject, { kind: "binding" }>,
  workerFields: Record<string, string> | undefined,
): boolean {
  if (signed.name !== name) return false;
  if (binding.type !== signed.type || binding.mode !== signed.mode) return false;
  if (canonicalJson(binding.config) !== canonicalJson(signed.config)) return false;

  const worker = workerFields ?? {};
  const fields = new Set([...Object.keys(binding.secrets), ...Object.keys(worker)]);
  const signedFields = Object.keys(signed.secret_refs);
  if (signedFields.length !== fields.size) return false;

  return signedFields.every((field) => {
    if (!fields.has(field)) return false;

    const workerName = worker[field];
    return workerName === undefined || workerName === signed.secret_refs[field];
  });
}

function refOutside(input: ExecutorInput, prefix: string): string | null {
  const output = storageRef(input.output_storage_ref);
  if (output === null) return "output ref is not a storage ref";

  if (!underPrefix(output, prefix)) {
    return `output ref ${output} is outside storage prefix ${prefix}`;
  }

  if (!isRecord(input.inputs)) return "input ref is not a storage ref";

  for (const ref of Object.values(input.inputs)) {
    const storage = isRecord(ref) ? storageRef(ref["storage_ref"]) : null;
    if (storage === null) return "input ref is not a storage ref";

    if (!underPrefix(storage, prefix)) {
      return `input ref ${storage} is outside storage prefix ${prefix}`;
    }
  }

  return pageRefs(input, output);
}

function pageRefs(input: ExecutorInput, output: string): string | null {
  const checkpoint = input.checkpoint;
  if (checkpoint === null || !isRecord(checkpoint) || !(PAGE_LIST in checkpoint)) return null;

  const pages = checkpoint[PAGE_LIST];
  if (!Array.isArray(pages)) return "checkpoint page ref is not a storage ref";

  for (const page of pages) {
    if (!isRecord(page) || typeof page["key"] !== "string" || typeof page["ref"] !== "string") {
      return "checkpoint page ref is not a storage ref";
    }

    const ref = page["ref"];
    let expected: string;

    try {
      expected = pageStorageRef(output, page["key"]);
    } catch {
      return `checkpoint page ref ${ref} is not the signed page of ${output}`;
    }

    if (ref !== expected) {
      return `checkpoint page ref ${ref} is not the signed page of ${output}`;
    }
  }

  return null;
}

function storageRef(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function underPrefix(ref: string, prefix: string): boolean {
  if (prefix === "") return false;

  return ref === prefix || ref.startsWith(`${prefix}.`) || ref.startsWith(`${prefix}/`);
}

interface Verified<T extends SigningSubject> {
  ok: true;
  subject: T;
}

interface Invalid {
  ok: false;
  reason: string;
}

function verifySubject<T extends SigningSubject>(
  value: unknown,
  keys: readonly TrustedKey[],
  subjectOf: (body: Record<string, unknown>) => T | null,
  unsigned: string,
): Verified<T> | Invalid {
  if (!isRecord(value)) return { ok: false, reason: unsigned };

  const signature = value["signature"];
  const signingKey = value["signing_key"];
  if (typeof signature !== "string" || typeof signingKey !== "string") {
    return { ok: false, reason: unsigned };
  }

  const subject = subjectOf(value);
  if (!subject) return { ok: false, reason: unsigned };

  const key = keys.find((item) => item.fingerprint === fingerprintOf(signingKey));
  if (!key || !verifySignature(key.raw, signingPayload(subject), signature)) {
    return { ok: false, reason: unsigned.replace(/^unsigned /, "rejected ") };
  }

  return { ok: true, subject };
}

function verifySignature(rawPublic: Buffer, payload: string, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, rawPublic]),
      format: "der",
      type: "spki",
    });

    return verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

function deploymentFingerprint(signatures: unknown): string | null {
  if (!isRecord(signatures) || !isRecord(signatures["deployment"])) return null;

  const key = signatures["deployment"]["signing_key"];
  return typeof key === "string" ? fingerprintOf(key) : null;
}

function refuse(reason: string, signingKey: string | null): Refused {
  return { ok: false, reason, signingKey };
}

function stringMap(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;

  return Object.values(value).every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
