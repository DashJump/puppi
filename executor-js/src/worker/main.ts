import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isTransient } from "@puppi/sdk";

import { AttemptFenced, errorEvent, execute, type SettleOutcome } from "../execute.js";
import { assertValidLease, speak, type ExecutorEvent, type Lease } from "../protocol.js";
import { deliverInOrder } from "./delivery.js";
import { createScratch, prepareRoot, removeScratch } from "./scratch.js";

const claimUrl = required("PUPPI_CLAIM_URL").replace(/\/$/, "");
const claimToken = required("PUPPI_CLAIM_TOKEN");
const workerId = machineId();
const headers = {
  authorization: `Bearer ${claimToken}`,
  "content-type": "application/json",
};

async function main(): Promise<void> {
  const root = prepareRoot("puppi-worker-", workerId);
  const lease = await request<Lease>(`${claimUrl}/lease`, {
    method: "POST",
    headers,
    body: JSON.stringify({ worker_id: workerId }),
  });
  assertValidLease(lease);
  const scratch = createScratch(root);

  try {
    await runLease(lease, scratch);
  } finally {
    removeScratch(scratch);
    removeScratch(root);
  }
}

async function runLease(lease: Lease, scratch: string): Promise<void> {
  // `os.tmpdir()` follows TMPDIR, so the download and the attempt's temp files
  // share this directory. A fence or a failed import still takes main's finally.
  process.env["TMPDIR"] = scratch;
  lease.input.bundle_ref = await materializeBundle(lease, scratch);
  const attempt = speak(lease.execution);

  let delivery = Promise.resolve();
  let fenced: Fenced | null = null;
  let posted = false;
  const heartbeat = setInterval(() => {
    delivery = delivery
      .then(() =>
        send(`${claimUrl}/heartbeat`, {
          attempt_id: lease.execution.attempt_id,
          fence: lease.execution.fence,
        }),
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        // The next checkpoint fails the seal. A write already in flight
        // finishes on this execution's own ref; the engine will not record it.
        if (error instanceof Fenced) {
          fenced = error;
          return;
        }

        throw error;
      });
  }, 20_000);

  const emit = (event: ExecutorEvent): Promise<void> => {
    if (fenced) return Promise.reject(fenced);

    const envelope = attempt.event(event);
    const sent = deliverInOrder(delivery, async () => {
      await send(`${claimUrl}/events`, envelope);
    });
    delivery = sent.chain.catch((error: unknown) => {
      if (error instanceof Fenced) fenced = error;
      throw error;
    });
    return sent.ack;
  };

  const complete = async (result: ExecutorEvent): Promise<SettleOutcome> => {
    posted = true;
    const response = await send(`${claimUrl}/complete`, attempt.complete(result));
    const body = (await response.json().catch(() => ({}))) as { outcome?: SettleOutcome };

    if (
      body.outcome === "recorded" ||
      body.outcome === "rejected" ||
      body.outcome === "fenced" ||
      body.outcome === "skipped"
    ) {
      return body.outcome;
    }

    throw new Error("attempt outcome unknown");
  };

  try {
    await execute(lease.input, emit, complete);
    await delivery;
  } catch (error) {
    try {
      await delivery;
    } catch (sendError) {
      if (sendError instanceof Fenced) fenced = sendError;
      else if (!fenced) throw sendError;
    }

    if (error instanceof Fenced || error instanceof AttemptFenced || fenced) {
      // A fence keeps the pages the checkpoint names. An end-of-attempt
      // `fenced` outcome already dropped the output table.
      if (!posted) {
        try {
          await complete(errorEvent(new Fenced()));
        } catch (sendError) {
          if (!(sendError instanceof Fenced)) throw sendError;
        }
      }

      process.exitCode = 0;
      return;
    }

    const result = errorEvent(error);

    if (!posted) {
      try {
        await complete(result);
      } catch (sendError) {
        if (!(sendError instanceof Fenced)) throw sendError;
        process.exitCode = 0;
        return;
      }
    }

    if (result.class === "retryable") process.exitCode = 75;
    else process.exitCode = 1;
  } finally {
    clearInterval(heartbeat);
  }
}

function machineId(): string {
  const fly = process.env["FLY_MACHINE_ID"]?.trim();
  if (fly) return fly;

  const host = process.env["HOSTNAME"]?.trim();
  if (host) return host;

  return "remote-node";
}

async function materializeBundle(lease: Lease, scratch: string): Promise<string> {
  if (!/^https?:\/\//.test(lease.input.bundle_ref)) return lease.input.bundle_ref;

  const bytes = await downloadBundle(lease.input.bundle_ref);
  verifyBundle(bytes, lease.execution.bundle_digest);
  const path = join(scratch, "bundle.mjs");
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

async function downloadBundle(url: string): Promise<Uint8Array> {
  const response = await fetchWithRetry(url, { headers });
  if (!response.ok)
    throw statusError(`bundle download failed with ${response.status}`, response.status);
  return new Uint8Array(await response.arrayBuffer());
}

function verifyBundle(bytes: Uint8Array, expected: string | null): void {
  const received = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (expected && received !== expected) {
    throw new Error(`bundle digest mismatch: expected ${expected}, received ${received}`);
  }
}

class Fenced extends Error {
  constructor() {
    super("attempt fence rejected");
    this.name = "Fenced";
  }
}

async function send(url: string, body: unknown): Promise<Response> {
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (response.status === 409) throw new Fenced();

  if (!response.ok) {
    throw statusError(`${url} rejected delivery with ${response.status}`, response.status);
  }

  return response;
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetchWithRetry(url, init);
  if (!response.ok) throw statusError(`${url} returned ${response.status}`, response.status);
  return (await response.json()) as T;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  return fetchAttempt(url, init, 0);
}

async function fetchAttempt(url: string, init: RequestInit, attempt: number): Promise<Response> {
  const outcome = await tryFetch(url, init);
  if (outcome.ok) return outcome.response;
  if (attempt === 4) throw outcome.error;

  await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  return fetchAttempt(url, init, attempt + 1);
}

async function tryFetch(
  url: string,
  init: RequestInit,
): Promise<{ ok: true; response: Response } | { ok: false; error: unknown }> {
  try {
    const response = await fetch(url, init);
    return retryableResponse(response)
      ? { ok: false, error: statusError(`${url} returned ${response.status}`, response.status) }
      : { ok: true, response };
  } catch (error) {
    return { ok: false, error };
  }
}

/** `429` or any status `>= 500`: the numeric status, not digits in a message. */
function retryableResponse(response: Response): boolean {
  return isTransient({ status: response.status });
}

function statusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
