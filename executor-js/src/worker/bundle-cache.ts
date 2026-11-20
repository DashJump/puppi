import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export class DigestMismatch extends Error {
  constructor(expected: string, received: string) {
    super(`bundle digest mismatch: expected ${expected}, received ${received}`);
    this.name = "DigestMismatch";
  }
}

/**
 * One file per digest. A hit still hashes the file before it is used. A
 * miss downloads with the lease's claim token. Two slots sharing a digest
 * share one download. A 401 or 403 rejects only that token; another slot
 * downloads with its own.
 */
export function openCache(directory: string | undefined, bundleUrl: string) {
  const root = directory && directory !== "" ? directory : join(tmpdir(), "puppi-bundles");
  const inflight = new Map<string, Promise<string>>();

  return async (digest: string, claimToken: string): Promise<string> => {
    for (;;) {
      const existing = inflight.get(digest);

      if (existing) {
        try {
          return await existing;
        } catch (error) {
          if (!authRejected(error)) throw error;
          if (inflight.get(digest) === existing) inflight.delete(digest);
          continue;
        }
      }

      const pending = materialize(root, bundleUrl, digest, claimToken).finally(() => {
        if (inflight.get(digest) === pending) inflight.delete(digest);
      });
      inflight.set(digest, pending);
      return pending;
    }
  };
}

function authRejected(error: unknown): boolean {
  return error instanceof Error && /^bundle download failed with 40[13]$/.test(error.message);
}

async function materialize(
  root: string,
  bundleUrl: string,
  digest: string,
  claimToken: string,
): Promise<string> {
  if (!DIGEST.test(digest)) throw new DigestMismatch(digest, "missing");

  const path = join(root, `${digest.slice("sha256:".length)}.mjs`);
  const cached = await readIfPresent(path);

  if (cached && sha256(cached) === digest) return path;

  const bytes = await download(bundleUrl, claimToken);
  const received = sha256(bytes);

  if (received !== digest) throw new DigestMismatch(digest, received);

  await mkdir(root, { recursive: true });
  const temporary = `${path}.partial`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
  return path;
}

async function download(url: string, claimToken: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${claimToken}` } });

  if (!response.ok) throw new Error(`bundle download failed with ${response.status}`);

  return new Uint8Array(await response.arrayBuffer());
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
