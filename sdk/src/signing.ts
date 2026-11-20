/**
 * The bytes a client signs and a worker verifies.
 *
 * One encoding, so the CLI and the worker cannot serialise a deployment,
 * an environment, or a binding differently. Objects are sorted by key,
 * recursively, with no whitespace.
 */

export interface DeploymentSubject {
  kind: "deployment";
  bundle_digest: string;
}

export interface EnvironmentSubject {
  kind: "environment";
  name: string;
  storage_prefix: string;
}

export interface BindingSubject {
  kind: "binding";
  /** The connection name. Covered so a signature cannot be presented as another binding. */
  name: string;
  type: string;
  config: Record<string, unknown>;
  secret_refs: Record<string, string>;
  mode: string;
}

export type SigningSubject = DeploymentSubject | EnvironmentSubject | BindingSubject;

/** Canonical JSON for `subject`. The signature covers these bytes and nothing else. */
export function signingPayload(subject: SigningSubject): string {
  return canonicalJson(subject);
}

/** Canonical JSON. Object keys are sorted; `undefined` object entries are dropped. */
export function canonicalJson(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(value);
    case "object":
      return encodeObject(value);
    default:
      throw new Error("signing payload must be JSON");
  }
}

function encodeObject(value: object): string {
  if (Array.isArray(value)) return `[${value.map((item) => encode(item)).join(",")}]`;

  const entries = Object.entries(value)
    .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(",")}}`;
}
