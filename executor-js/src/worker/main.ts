import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { isTransient } from "@puppi/sdk";

import {
  AttemptCancelled,
  AttemptFenced,
  errorEvent,
  execute,
  type SettleOutcome,
} from "../execute.js";
import {
  assertValidLease,
  CANCEL_KILL_MS,
  speak,
  type ExecutorEvent,
  type Lease,
} from "../protocol.js";
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
  let scratch: string | undefined;

  try {
    const lease = await request<Lease>(`${claimUrl}/lease`, {
      method: "POST",
      headers,
      body: JSON.stringify({ worker_id: workerId }),
    });
    assertValidLease(lease);
    scratch = createScratch(root);
    await runLease(lease, scratch);
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (scratch !== undefined) removeScratch(scratch);
    removeScratch(root);
  }

  process.exit(process.exitCode ?? 0);
}

async function runLease(lease: Lease, scratch: string): Promise<Stop | null> {
  // `os.tmpdir()` follows TMPDIR, so the download and the attempt's temp files
  // share this directory. A fence or a failed import still takes main's finally.
  process.env["TMPDIR"] = scratch;
  lease.input.bundle_ref = await materializeBundle(lease, scratch);
  const attempt = speak(lease.execution);

  let delivery = Promise.resolve();
  let stop: Stop | null = null;
  let posted = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let graceOver!: () => void;
  const grace = new Promise<void>((resolve) => {
    graceOver = resolve;
  });

  const armCancel = (): void => {
    if (killTimer) return;

    killTimer = setTimeout(graceOver, CANCEL_KILL_MS);
  };

  const noteStop = (error: unknown): boolean => {
    const found = stopOf(error);
    if (!found) return false;

    stop ??= found;
    if (stop === "cancelled") armCancel();
    return true;
  };

  const swallowStop = (error: unknown): void => {
    if (!noteStop(error)) throw error;
  };

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
        if (!noteStop(error)) throw error;
      });
  }, 20_000);

  const emit = (event: ExecutorEvent): Promise<void> => {
    if (stop) return Promise.reject(stop === "fenced" ? new Fenced() : new AttemptCancelled());

    const envelope = attempt.event(event);
    const sent = deliverInOrder(delivery, async () => {
      await send(`${claimUrl}/events`, envelope);
    });
    delivery = sent.chain.catch((error: unknown) => {
      noteStop(error);
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

  const finished = (async (): Promise<void> => {
    try {
      await execute(lease.input, emit, complete);
      await delivery;
    } catch (error) {
      noteStop(error);

      try {
        await delivery;
      } catch (sendError) {
        if (!noteStop(sendError) && !stop) throw sendError;
      }

      if (stop === "cancelled") return;

      if (stop === "fenced") {
        // A fence keeps the pages the checkpoint names. An end-of-attempt
        // `fenced` outcome already dropped the output table.
        if (!posted) await complete(errorEvent(new Fenced())).catch(swallowStop);
        return;
      }

      const result = errorEvent(error);

      if (!posted) {
        try {
          await complete(result);
        } catch (sendError) {
          if (!noteStop(sendError)) throw sendError;
          return;
        }
      }

      process.exitCode = result.class === "retryable" ? 75 : 1;
    }
  })();

  let graceWon = false;

  try {
    await Promise.race([
      finished,
      grace.then(() => {
        graceWon = true;
      }),
    ]);
  } finally {
    clearInterval(heartbeat);
    clearTimeout(killTimer);
    if (graceWon) void finished.catch(() => undefined);
  }

  return stop;
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

type Stop = "fenced" | "cancelled";

class Fenced extends Error {
  constructor() {
    super("attempt fence rejected");
    this.name = "Fenced";
  }
}

function stopOf(error: unknown): Stop | null {
  if (error instanceof Fenced || error instanceof AttemptFenced) return "fenced";
  if (error instanceof AttemptCancelled) return "cancelled";
  return null;
}

async function send(url: string, body: unknown): Promise<Response> {
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (response.status === 409) throw await conflict(url, response);

  if (!response.ok) {
    throw statusError(`${url} rejected delivery with ${response.status}`, response.status);
  }

  return response;
}

async function conflict(url: string, response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    reason?: unknown;
  } | null;

  if (body?.reason === "cancelled" || body?.error === "cancelled") return new AttemptCancelled();
  if (body?.error === "stale_fence") return new Fenced();

  return statusError(`${url} rejected delivery with ${response.status}`, response.status);
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

void main();
