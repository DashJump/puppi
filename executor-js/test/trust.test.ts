import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pageStorageRef } from "@puppi/adapter-storage";
import { signingPayload, type SigningSubject } from "@puppi/sdk";
import { describe, expect, it } from "vite-plus/test";

import type { ExecutorInput } from "../src/protocol.js";
import { admit, fingerprintOf, parseTrustedKeys, type TrustConfig } from "../src/worker/trust.js";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "protocol/fixtures/signing.json",
);

interface Signed {
  signature: string;
  signing_key: string;
}

interface Fixture {
  public_key: string;
  fingerprint: string;
  subjects: {
    deployment: { kind: "deployment"; bundle_digest: string };
    environment: { kind: "environment"; name: string; storage_prefix: string };
    binding: {
      kind: "binding";
      name: string;
      type: string;
      config: Record<string, unknown>;
      secret_refs: Record<string, string>;
      mode: string;
    };
  };
  payloads: Record<"deployment" | "environment" | "binding", string>;
  signatures: Record<"deployment" | "environment" | "binding", string>;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

describe("lease verification", () => {
  it("accepts the shared signing fixture", () => {
    const decision = admit(view(), {
      residency: "standard",
      trustedKeys: parseTrustedKeys(fixture.public_key),
      secretsDir: undefined,
    });

    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.signingKey).toBe(fixture.fingerprint);

    const raw = Buffer.from(fixture.public_key.slice("ed25519:".length), "base64");
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
      format: "der",
      type: "spki",
    });

    for (const kind of ["deployment", "environment", "binding"] as const) {
      const subject = fixture.subjects[kind];
      expect(signingPayload(subject)).toBe(fixture.payloads[kind]);
      expect(
        verify(
          null,
          Buffer.from(fixture.payloads[kind]),
          key,
          Buffer.from(fixture.signatures[kind], "base64"),
        ),
      ).toBe(true);
    }
  });

  it("refuses a strict lease whose secret value is not null", () => {
    const key = keyPair();
    const config = trust(key.id);
    const secretRefs = { password: "warehouse_password" };

    const held = admit(
      signedLease(key, { secrets: { password: ["s3cr3t-value"] }, secretRefs }),
      config,
    );

    expect(held).toMatchObject({
      ok: false,
      reason: "redeclare `warehouse.password` --on-worker",
    });

    const blank = admit(signedLease(key, { secrets: { password: "" }, secretRefs }), config);
    expect(blank).toMatchObject({
      ok: false,
      reason: "redeclare `warehouse.password` --on-worker",
    });

    const placeholder = admit(
      signedLease(key, { secrets: { password: null }, secretRefs }),
      config,
    );
    expect(placeholder.ok).toBe(true);
  });

  it("checks signatures when strict residency has a trusted key", () => {
    const key = keyPair();
    const config = trust(key.id);
    const lease = signedLease(key);
    const accepted = admit(lease, config);

    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.signingKey).toBe(fingerprintOf(key.id));

    expect(admit({ ...lease, signatures: {} }, config)).toMatchObject({
      ok: false,
      reason: "unsigned bundle",
    });

    const deployment = lease.signatures.deployment;
    expect(
      admit(
        {
          ...lease,
          signatures: {
            ...lease.signatures,
            deployment: { ...deployment, signature: Buffer.alloc(64).toString("base64") },
          },
        },
        config,
      ),
    ).toMatchObject({ ok: false, reason: "rejected bundle" });

    expect(admit(signedLease(keyPair()), config)).toMatchObject({
      ok: false,
      reason: "rejected bundle",
    });
  });

  it("admits an unsigned lease when residency is standard and no key is configured", () => {
    const key = keyPair();
    const unsigned = { ...signedLease(key), signatures: {} };

    expect(
      admit(unsigned, { residency: "standard", trustedKeys: [], secretsDir: undefined }).ok,
    ).toBe(true);

    expect(
      admit(unsigned, {
        residency: "standard",
        trustedKeys: parseTrustedKeys(key.id),
        secretsDir: undefined,
      }),
    ).toMatchObject({ ok: false, reason: "unsigned bundle" });
  });

  it("refuses a checkpoint page ref that is not the signed page, without throwing", () => {
    const key = keyPair();
    const config = trust(key.id);
    const pageKey = "ab".repeat(16);
    const output = "out.source_things";
    const expected = pageStorageRef(output, pageKey);

    const attack = admit(
      signedLease(key, {
        checkpoint: { __puppi_pages: [{ key: pageKey, ref: "public.users" }] },
      }),
      config,
    );
    expect(attack).toMatchObject({
      ok: false,
      reason: `checkpoint page ref public.users is not the signed page of ${output}`,
    });

    const badRef = () =>
      admit(
        signedLease(key, {
          checkpoint: { __puppi_pages: [{ key: pageKey, ref: ["public.users"] }] },
        }),
        config,
      );
    expect(badRef).not.toThrow();
    expect(badRef().ok).toBe(false);

    const badOutput = () => admit(signedLease(key, { output: ["public.users"] }), config);
    expect(badOutput).not.toThrow();
    expect(badOutput()).toMatchObject({ ok: false, reason: "output ref is not a storage ref" });

    expect(
      admit(
        signedLease(key, { checkpoint: { __puppi_pages: [{ key: pageKey, ref: expected }] } }),
        config,
      ).ok,
    ).toBe(true);
  });

  it("refuses a binding signature presented under another name", () => {
    const key = keyPair();
    const config = trust(key.id);

    const moved = admit(
      signedLease(key, { bindingKey: "warehouse", signedName: "staging" }),
      config,
    );
    expect(moved).toMatchObject({
      ok: false,
      reason: "binding warehouse does not match its signature",
    });

    expect(
      admit(signedLease(key, { bindingKey: "warehouse", signedName: "warehouse" }), config).ok,
    ).toBe(true);
  });
});

function view() {
  const deployment = fixture.subjects.deployment;
  const environment = fixture.subjects.environment;
  const binding = fixture.subjects.binding;
  const input: ExecutorInput = {
    bundle_ref: "/tmp/bundle.js",
    sdk_version: "0.2.0",
    asset_key: "source/things",
    partition: "",
    inputs: {},
    checkpoint: null,
    cursor_from: null,
    bindings: {
      warehouse: {
        type: binding.type,
        config: binding.config,
        secrets: {},
        mode: "live",
      },
    },
    storage_connection: "warehouse",
    output_storage_ref: `${environment.storage_prefix}.source_things`,
    connections: {},
  };

  return {
    digest: deployment.bundle_digest,
    input,
    workerSecrets: {},
    signatures: {
      deployment: signed(deployment, fixture.signatures.deployment),
      environment: signed(environment, fixture.signatures.environment),
      bindings: {
        warehouse: signed(binding, fixture.signatures.binding),
      },
    },
  };
}

function signed(
  subject: Fixture["subjects"][keyof Fixture["subjects"]],
  signature: string,
): Signed & Record<string, unknown> {
  const { kind: _kind, ...body } = subject;
  return { ...body, signature, signing_key: fixture.public_key };
}

function trust(id: string): TrustConfig {
  return { residency: "strict", trustedKeys: parseTrustedKeys(id), secretsDir: undefined };
}

function keyPair(): { id: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const raw = Buffer.from(der).subarray(der.length - 32);

  return { id: `ed25519:${raw.toString("base64")}`, privateKey };
}

function signedLease(
  key: { id: string; privateKey: KeyObject },
  options: {
    bindingKey?: string;
    signedName?: string;
    output?: unknown;
    checkpoint?: unknown;
    secrets?: Record<string, unknown>;
    secretRefs?: Record<string, string>;
  } = {},
) {
  const bindingKey = options.bindingKey ?? "warehouse";
  const signedName = options.signedName ?? bindingKey;
  const digest = fixture.subjects.deployment.bundle_digest;
  const output = options.output ?? "out.source_things";
  const deployment = { kind: "deployment" as const, bundle_digest: digest };
  const environment = { kind: "environment" as const, name: "prod", storage_prefix: "out" };
  const binding = {
    kind: "binding" as const,
    name: signedName,
    type: "filesystem",
    config: { root: "/data" },
    secret_refs: options.secretRefs ?? {},
    mode: "live",
  };
  const input = {
    bundle_ref: "/tmp/bundle.js",
    sdk_version: "0.2.0",
    asset_key: "source/things",
    partition: "",
    inputs: {},
    checkpoint: (options.checkpoint ?? null) as ExecutorInput["checkpoint"],
    cursor_from: null,
    bindings: {
      [bindingKey]: {
        type: "filesystem",
        config: { root: "/data" },
        secrets: (options.secrets ?? {}) as ExecutorInput["bindings"][string]["secrets"],
        mode: "live" as const,
      },
    },
    storage_connection: bindingKey,
    output_storage_ref: output as string,
    connections: {},
  } satisfies ExecutorInput;

  return {
    digest,
    input,
    workerSecrets: {},
    signatures: {
      deployment: signSubject(deployment, key),
      environment: signSubject(environment, key),
      bindings: { [bindingKey]: signSubject(binding, key) },
    },
  };
}

function signSubject(
  subject: SigningSubject,
  key: { id: string; privateKey: KeyObject },
): Record<string, unknown> {
  const signature = sign(null, Buffer.from(signingPayload(subject)), key.privateKey).toString(
    "base64",
  );
  const { kind: _kind, ...body } = subject;

  return { ...body, signature, signing_key: key.id };
}
