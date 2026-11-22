import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  assertValidLease,
  type ExecutorEvent,
  type ExecutorInput,
  type Execution,
} from "../protocol.js";
import { DigestMismatch, openCache } from "./bundle-cache.js";
import { redact, type Residency } from "./residency.js";
import { createScratch, prepareRoot, removeScratch } from "./scratch.js";
import { listSecretNames, scrub } from "./secrets.js";
import {
  admit,
  parseTrustedKeys,
  STRICT_REQUIRES_TRUSTED_KEYS,
  type LeaseView,
  type TrustedKey,
} from "./trust.js";

const WORKER_VERSION = "0.4";
// The socket closes after 60s with no frame. This pulse is the keepalive.
const PULSE_MS = 20_000;
const SILENCE_MS = 60_000;
const CANCEL_KILL_MS = 30_000;
const BACKOFF_BASE_MS = 200;
const BACKOFF_CAP_MS = 30_000;

const runtimePath = fileURLToPath(new URL("../runtime.js", import.meta.url));

interface Config {
  socketUrl: string;
  bundleUrl: string;
  token: string;
  workerId: string;
  slots: number;
  residency: Residency;
  cacheDir: string | undefined;
  secretsDir: string | undefined;
  trustedKeys: TrustedKey[];
}

interface Attempt {
  attemptId: string;
  fence: number;
  runId: string;
  assetKey: string;
  child?: ChildProcess;
  seq: number;
  done: boolean;
  cancelled: boolean;
  lost: boolean;
  fenced: boolean;
  /** Event acks still owed, in the order the child wrote the events. */
  pendingAcks: number;
  /** The child has emitted a result or error and is waiting for `settled`. */
  awaiting: boolean;
  /** `{recorded}` was written. A later cancel must not interrupt `dropPages`. */
  releasing: boolean;
  stopping?: boolean;
  /** Attempt directory passed to the child as `TMPDIR`, removed when the attempt ends. */
  scratch?: string;
  silence?: ReturnType<typeof setTimeout>;
}

interface Lease {
  attemptId: string;
  fence: number;
  runId: string;
  assetKey: string;
  digest: string;
  claimToken: string;
  execution: Execution;
  input: ExecutorInput;
  workerSecrets: Record<string, Record<string, string>>;
  signatures: unknown;
}

interface State {
  config: Config;
  draining: boolean;
  attempts: Map<string, Attempt>;
  scratchRoot: string;
  socket?: WebSocket;
  pulse?: ReturnType<typeof setInterval>;
  failures: number;
  secretValues: string[];
}

function main(): void {
  let config: Config;

  try {
    config = readConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  const state: State = {
    config,
    draining: false,
    attempts: new Map(),
    scratchRoot: prepareRoot("puppi-pool-", config.workerId),
    socket: undefined,
    pulse: undefined,
    failures: 0,
    secretValues: [],
  };
  const bundle = openCache(config.cacheDir, config.bundleUrl);
  const abort = new AbortController();
  let stopping = false;

  const stop = (): void => {
    if (stopping) return;

    stopping = true;
    state.draining = true;
    offer(state);
    const socket = state.socket;
    abort.abort();

    let exited = false;
    const exit = (): void => {
      if (exited) return;

      exited = true;
      process.exit(0);
    };

    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING)
    ) {
      socket.addEventListener("close", exit, { once: true });
      if (socket.readyState === WebSocket.OPEN) socket.close();
      setTimeout(exit, 1_000);
      return;
    }

    setTimeout(exit, 20);
  };

  process.on("SIGTERM", () => {
    state.draining = true;
    offer(state);
    if (state.attempts.size === 0) stop();
  });

  const retired = (attempt: Attempt): void => {
    clearTimeout(attempt.silence);
    const scratch = attempt.scratch;

    if (scratch !== undefined) {
      attempt.scratch = undefined;
      removeScratch(scratch);
    }

    const key = keyOf(attempt.attemptId, attempt.fence);
    if (state.attempts.get(key) === attempt) state.attempts.delete(key);
    if (state.draining && state.attempts.size === 0) stop();
  };

  void run(state, bundle, retired, abort.signal).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function run(
  state: State,
  bundle: (digest: string, claimToken: string) => Promise<string>,
  retired: (attempt: Attempt) => void,
  signal: AbortSignal,
): Promise<void> {
  signal.addEventListener("abort", () => state.socket?.close());

  while (!signal.aborted && !state.draining) {
    let failed: unknown;

    try {
      await connect(state, bundle, retired);
    } catch (error) {
      failed = error;
    }

    if (signal.aborted || state.draining) return;

    if (failed) write(state, { refused: await refusal(state.config, failed) });

    const delay = backoff(state.failures);
    state.failures += 1;
    await sleep(delay, signal);
  }
}

function connect(
  state: State,
  bundle: (digest: string, claimToken: string) => Promise<string>,
  retired: (attempt: Attempt) => void,
): Promise<void> {
  const socket = new WebSocket(state.config.socketUrl, { headers: headers(state.config) });
  state.socket = socket;
  let opened = false;
  let stable = setTimeout(() => undefined, PULSE_MS);
  clearTimeout(stable);

  return new Promise((resolveConnect, reject) => {
    let settled = false;

    const finish = (ok: boolean): void => {
      if (settled) return;

      settled = true;
      clearTimeout(stable);
      clearInterval(state.pulse);
      state.pulse = undefined;
      if (state.socket === socket) state.socket = undefined;

      void dropChildren(state).then(() => {
        if (ok) resolveConnect();
        else reject(new Error("upgrade failed"));
      });
    };

    socket.addEventListener("open", () => {
      opened = true;
      offer(state);
      state.pulse = setInterval(() => {
        offer(state);
        for (const attempt of state.attempts.values()) beat(state, attempt);
      }, PULSE_MS);
      stable = setTimeout(() => {
        state.failures = 0;
      }, PULSE_MS);
    });

    socket.addEventListener("message", (event) => {
      void onFrame(state, bundle, textOf(event.data), retired).catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      });
    });

    socket.addEventListener("error", () => {
      if (!opened) finish(false);
    });

    socket.addEventListener("close", () => {
      finish(opened);
    });
  });
}

async function onFrame(
  state: State,
  bundle: (digest: string, claimToken: string) => Promise<string>,
  text: string,
  retired: (attempt: Attempt) => void,
): Promise<void> {
  const frame = parseFrame(text);
  if (!frame) return;

  if (frame["message"] === "settled") {
    const found = attemptOf(state, frame);
    if (found) applySettled(found, frame);
    return;
  }

  if (frame["message"] === "stop") {
    const attemptId = frame["attempt_id"];
    const fence = frame["fence"];
    if (typeof attemptId !== "string" || typeof fence !== "number") return;

    const attempt = state.attempts.get(keyOf(attemptId, fence));
    if (attempt) stopAttempt(state, attempt);
    return;
  }

  if (state.draining) return;

  if (frame["message"] === "drop-tables") {
    await acceptDrop(state, bundle, frame, retired);
    return;
  }

  if (frame["message"] === "lease") {
    const lease = leaseOf(frame);
    if (lease) await accept(state, bundle, lease, retired);
    return;
  }

  if (frame["message"] !== "cancel") return;

  const attemptId = frame["attempt_id"];
  const fence = frame["fence"];
  if (typeof attemptId !== "string" || typeof fence !== "number") return;

  const attempt = state.attempts.get(keyOf(attemptId, fence));
  if (attempt) cancel(attempt);
}

async function accept(
  state: State,
  bundle: (digest: string, claimToken: string) => Promise<string>,
  lease: Lease,
  retired: (attempt: Attempt) => void,
): Promise<void> {
  const decision = admit(viewOf(lease), {
    residency: state.config.residency,
    trustedKeys: state.config.trustedKeys,
    secretsDir: state.config.secretsDir,
  });

  if (!decision.ok) {
    refuseAttempt(state, lease, decision.reason, decision.signingKey, "terminal");
    return;
  }

  rememberSecrets(state, decision.values);
  const socket = state.socket;
  const attempt: Attempt = {
    attemptId: lease.attemptId,
    fence: lease.fence,
    runId: lease.runId,
    assetKey: lease.assetKey,
    child: undefined,
    seq: 0,
    done: false,
    cancelled: false,
    lost: false,
    fenced: false,
    pendingAcks: 0,
    awaiting: false,
    releasing: false,
    silence: undefined,
  };
  state.attempts.set(keyOf(lease.attemptId, lease.fence), attempt);

  let path: string;

  try {
    path = await bundle(lease.digest, lease.claimToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    audit(state, lease, "refused", message, decision.signingKey);

    if (!current(state, attempt, socket)) {
      retired(attempt);
      return;
    }

    complete(state, lease.attemptId, lease.fence, 0, {
      event: "error",
      class: error instanceof DigestMismatch ? "terminal" : "retryable",
      message,
    });
    retired(attempt);
    return;
  }

  if (!current(state, attempt, socket)) {
    retired(attempt);
    return;
  }

  audit(state, lease, "accepted", undefined, decision.signingKey);

  if (
    !startChild(state, attempt, socket, retired, {
      message: "lease",
      execution: lease.execution,
      input: { ...decision.input, bundle_ref: path },
    })
  ) {
    return;
  }
}

async function acceptDrop(
  state: State,
  bundle: (digest: string, claimToken: string) => Promise<string>,
  frame: Record<string, unknown>,
  retired: (attempt: Attempt) => void,
): Promise<void> {
  const attemptId = frame["attempt_id"];
  const fence = frame["fence"];
  if (typeof attemptId !== "string" || typeof fence !== "number") return;

  const fail = (message: string, errorClass: "terminal" | "retryable" = "retryable"): void => {
    complete(state, attemptId, fence, 0, { event: "error", class: errorClass, message });
  };

  const claimToken = frame["claim_token"];
  const connection = frame["connection"];
  const binding = frame["binding"];
  const refs = frame["storage_refs"];
  const digest = frame["bundle_digest"];

  if (typeof claimToken !== "string" || typeof connection !== "string" || !isRecord(binding)) {
    fail("drop-tables frame is missing a binding");
    return;
  }

  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) {
    fail("drop-tables frame is missing storage refs");
    return;
  }

  if (typeof digest !== "string" || !digest.startsWith("sha256:")) {
    fail("drop-tables frame is missing a bundle digest");
    return;
  }

  let decision: ReturnType<typeof admit>;

  try {
    decision = admit(
      {
        digest,
        input: {
          bindings: { [connection]: binding },
          output_storage_ref: typeof refs[0] === "string" ? refs[0] : "",
          inputs: {},
          checkpoint: null,
        } as unknown as ExecutorInput,
        workerSecrets: stringMap(frame["worker_secrets"]),
        signatures: frame["signatures"] ?? {},
      },
      {
        residency: state.config.residency,
        trustedKeys: state.config.trustedKeys,
        secretsDir: state.config.secretsDir,
      },
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), "terminal");
    return;
  }

  if (!decision.ok) {
    fail(decision.reason, "terminal");
    return;
  }

  rememberSecrets(state, decision.values);
  const filled = decision.input.bindings[connection];
  if (!filled) {
    fail(`worker secret binding ${connection} was not filled`, "terminal");
    return;
  }

  const socket = state.socket;
  const attempt: Attempt = {
    attemptId,
    fence,
    runId: "",
    assetKey: "",
    child: undefined,
    seq: 0,
    done: false,
    cancelled: false,
    lost: false,
    fenced: false,
    pendingAcks: 0,
    awaiting: false,
    releasing: false,
    silence: undefined,
  };
  state.attempts.set(keyOf(attemptId, fence), attempt);

  let path: string;

  try {
    path = await bundle(digest, claimToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!current(state, attempt, socket)) {
      retired(attempt);
      return;
    }

    fail(message, error instanceof DigestMismatch ? "terminal" : "retryable");
    retired(attempt);
    return;
  }

  if (!current(state, attempt, socket)) {
    retired(attempt);
    return;
  }

  if (
    !startChild(state, attempt, socket, retired, {
      message: "drop-tables",
      bundle_ref: path,
      connection,
      binding: filled,
      storage_refs: refs,
    })
  ) {
    return;
  }
}

function startChild(
  state: State,
  attempt: Attempt,
  socket: WebSocket | undefined,
  retired: (attempt: Attempt) => void,
  command: Record<string, unknown>,
): boolean {
  let scratch: string;

  try {
    scratch = createScratch(state.scratchRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!current(state, attempt, socket)) {
      retired(attempt);
      return false;
    }

    complete(state, attempt.attemptId, attempt.fence, 0, {
      event: "error",
      class: "retryable",
      message,
    });
    retired(attempt);
    return false;
  }

  attempt.scratch = scratch;
  const child = spawn(process.execPath, [runtimePath], {
    env: childEnv(scratch),
    stdio: ["pipe", "pipe", "pipe"],
  });
  attempt.child = child;
  watch(state, attempt, retired);
  const stdin = child.stdin;
  stdin?.on("error", () => undefined);
  child.stderr?.on("data", (chunk: Buffer) => {
    noteStderr(state, attempt, chunk);
  });
  stdin?.write(`${JSON.stringify(command)}\n`);
  return true;
}

function current(state: State, attempt: Attempt, socket?: WebSocket): boolean {
  return (
    state.socket === socket &&
    !state.draining &&
    !attempt.cancelled &&
    !attempt.lost &&
    state.attempts.get(keyOf(attempt.attemptId, attempt.fence)) === attempt
  );
}

function viewOf(lease: Lease): LeaseView {
  return {
    digest: lease.digest,
    input: lease.input,
    workerSecrets: lease.workerSecrets,
    signatures: lease.signatures,
  };
}

function refuseAttempt(
  state: State,
  lease: Lease,
  reason: string,
  signingKey: string | null,
  errorClass: "terminal" | "retryable",
): void {
  audit(state, lease, "refused", reason, signingKey);
  complete(state, lease.attemptId, lease.fence, 0, {
    event: "error",
    class: errorClass,
    message: reason,
  });
}

function audit(
  state: State,
  lease: Lease,
  decision: "accepted" | "refused",
  reason: string | undefined,
  signingKey: string | null,
): void {
  write(state, {
    lease: decision,
    attempt_id: lease.attemptId,
    asset_key: lease.assetKey,
    bundle_digest: lease.digest,
    signing_key: signingKey,
    ...(reason === undefined ? {} : { reason }),
  });
}

function rememberSecrets(state: State, values: readonly string[]): void {
  const known = new Set(state.secretValues);

  for (const value of values) {
    if (value !== "") known.add(value);
  }

  state.secretValues = [...known];
}

function noteStderr(state: State, attempt: Attempt, chunk: Buffer): void {
  if (state.config.residency !== "strict") {
    process.stderr.write(String(scrub(chunk.toString("utf8"), state.secretValues)));
    return;
  }

  const text = chunk.toString("utf8");
  if (text === "") return;

  write(state, {
    run_id: attempt.runId,
    attempt_id: attempt.attemptId,
    asset_key: attempt.assetKey,
    withheld: { stderr: scrub(text, state.secretValues) },
  });
  process.stderr.write(`kept on worker ${state.config.workerId}\n`);
}

function watch(state: State, attempt: Attempt, retired: (attempt: Attempt) => void): void {
  const child = attempt.child;
  const stdout = child?.stdout;
  if (!child || !stdout) return;

  const lines = createInterface({ input: stdout });
  let pending = Promise.resolve();
  let status: number | null = null;
  let outputEnded = false;
  let settled = false;
  armSilence(state, attempt);

  lines.on("line", (line) => {
    armSilence(state, attempt);
    pending = pending.then(() => onLine(state, attempt, line)).catch(() => undefined);
  });

  const settle = (): void => {
    if (settled || status === null || !outputEnded) return;

    settled = true;
    const code = status;
    void pending.then(() => {
      if (!attempt.done && !attempt.cancelled && !attempt.lost && !attempt.fenced) {
        attempt.done = true;
        // The child has exited, so its scratch directory is removed before
        // `complete`. The engine can retry as soon as that frame arrives.
        const scratch = attempt.scratch;

        if (scratch !== undefined) {
          attempt.scratch = undefined;
          removeScratch(scratch);
        }

        const message =
          code === 0 ? "executor exited 0 without a result event" : `executor exited ${code}`;
        complete(state, attempt.attemptId, attempt.fence, attempt.seq, {
          event: "error",
          class: "retryable",
          message,
        });
      }

      retired(attempt);
    });
  };

  // `close` follows the last line. Settling on the stream's `end` drops that line.
  lines.on("close", () => {
    outputEnded = true;
    settle();
  });

  child.on("exit", (code) => {
    status = code ?? 1;
    const late = setTimeout(() => {
      outputEnded = true;
      settle();
    }, 1_000);
    if (outputEnded) {
      clearTimeout(late);
      settle();
    } else {
      lines.once("close", () => clearTimeout(late));
    }
  });
}

async function onLine(state: State, attempt: Attempt, line: string): Promise<void> {
  if (attempt.done || attempt.cancelled || attempt.lost || attempt.fenced) return;

  const frame = parseChildLine(line);

  if (frame.kind === "empty") return;

  if (frame.kind === "bad") {
    process.stderr.write(`${frame.message}\n`);
    ack(attempt, { ok: true });
    return;
  }

  if (frame.kind === "dropped") {
    attempt.done = true;
    attempt.releasing = true;

    if (!Array.isArray(frame.dropped) || !Array.isArray(frame.failed)) {
      complete(state, attempt.attemptId, attempt.fence, 0, {
        event: "error",
        class: "retryable",
        message: "drop-tables returned a bad report",
      });
      return;
    }

    send(state, {
      message: "complete",
      attempt_id: attempt.attemptId,
      fence: attempt.fence,
      last_seq: 0,
      result: { message: "dropped", dropped: frame.dropped, failed: frame.failed },
    });
    return;
  }

  const body = frame.body;
  const seq = frame.seq;

  if (!isEvent(body) || typeof seq !== "number") {
    process.stderr.write("executor sent a non-event JSON value\n");
    ack(attempt, { ok: true });
    return;
  }

  if (frame.terminal) attempt.done = true;
  attempt.seq = seq;

  const redaction = redact(body, state.config.residency);

  if (Object.keys(redaction.text).length > 0) {
    write(state, {
      run_id: attempt.runId,
      attempt_id: attempt.attemptId,
      asset_key: attempt.assetKey,
      withheld: redaction.text,
    });
  }

  const withheld = redaction.fields.length > 0 ? { withheld: redaction.fields } : {};

  if (frame.terminal) {
    attempt.awaiting = true;
    complete(state, attempt.attemptId, attempt.fence, attempt.seq, redaction.event, withheld);
    return;
  }

  const sent = send(state, {
    message: "event",
    attempt_id: attempt.attemptId,
    fence: attempt.fence,
    seq: attempt.seq,
    event: redaction.event,
    ...withheld,
  });

  if (!sent) {
    stopFenced(attempt);
    return;
  }

  // The runtime acks in write order. A span beside a checkpoint is written
  // before that checkpoint's ack is read, so this count — not the send —
  // is what holds the next page write.
  attempt.pendingAcks += 1;
}

function complete(
  state: State,
  attemptId: string,
  fence: number,
  lastSeq: number,
  result: ExecutorEvent,
  withheld: { withheld?: string[] } = {},
): void {
  send(state, {
    message: "complete",
    attempt_id: attemptId,
    fence,
    last_seq: lastSeq,
    result,
    ...withheld,
  });
}

function beat(state: State, attempt: Attempt): void {
  if (attempt.done || attempt.cancelled || attempt.lost || attempt.fenced) return;

  const sent = send(state, {
    message: "heartbeat",
    attempt_id: attempt.attemptId,
    fence: attempt.fence,
  });

  // Same rule as the local port: a heartbeat means the attempt is still
  // alive, so a quiet child is not killed out from under a long fetch.
  if (sent) armSilence(state, attempt);
}

function armSilence(state: State, attempt: Attempt): void {
  clearTimeout(attempt.silence);
  attempt.silence = setTimeout(() => {
    if (attempt.done || attempt.cancelled || attempt.lost || attempt.fenced) return;

    attempt.done = true;
    complete(state, attempt.attemptId, attempt.fence, attempt.seq, {
      event: "error",
      class: "retryable",
      message: `executor timed out after ${SILENCE_MS}ms`,
    });
    attempt.child?.kill("SIGKILL");
  }, SILENCE_MS);
}

function send(state: State, frame: unknown): boolean {
  const socket = state.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;

  try {
    socket.send(JSON.stringify(scrub(frame, state.secretValues)));
    return true;
  } catch {
    return false;
  }
}

function offer(state: State): void {
  send(state, {
    message: "ready",
    slots: state.draining ? 0 : state.config.slots,
    secrets: listSecretNames(state.config.secretsDir),
  });
}

function stopAttempt(state: State, attempt: Attempt): void {
  if (attempt.stopping) return;

  attempt.stopping = true;
  attempt.cancelled = true;
  armStop(attempt.child, () => {
    send(state, stoppedFrame(attempt.attemptId, attempt.fence, state.config.workerId));
  });
}

function armStop(child: ChildProcess | undefined, reply: () => void, killAfterMs = 5_000): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    reply();
    return;
  }

  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, killAfterMs);
  child.once("exit", () => {
    clearTimeout(timer);
    reply();
  });
}

function stoppedFrame(attemptId: string, fence: number, workerId: string) {
  return {
    message: "stopped" as const,
    attempt_id: attemptId,
    fence,
    worker_id: workerId,
    reason: "cancelled" as const,
  };
}

function cancel(attempt: Attempt): void {
  if (attempt.cancelled || attempt.lost || attempt.fenced) return;

  // The result is already at the engine, or its pages are dropping. Cancel
  // is not a reason to skip `{recorded}` or to interrupt that drop.
  if (attempt.awaiting || attempt.releasing) return;

  attempt.cancelled = true;
  clearTimeout(attempt.silence);
  const child = attempt.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const stdin = child.stdin;
  if (stdin && !stdin.destroyed) stdin.write(`${JSON.stringify({ abort: true })}\n`);

  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, CANCEL_KILL_MS);
  child.once("exit", () => clearTimeout(timer));
}

async function dropChildren(state: State): Promise<void> {
  const pending = [...state.attempts.values()];

  await Promise.all(
    pending.map(async (attempt) => {
      attempt.lost = true;
      clearTimeout(attempt.silence);

      const child = attempt.child;

      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolveExit) => {
          child.once("exit", () => resolveExit());
        });
      }

      if (attempt.scratch !== undefined) {
        const scratch = attempt.scratch;
        attempt.scratch = undefined;
        removeScratch(scratch);
      }

      const key = keyOf(attempt.attemptId, attempt.fence);
      if (state.attempts.get(key) === attempt) state.attempts.delete(key);
    }),
  );
}

async function refusal(config: Config, error: unknown): Promise<string> {
  try {
    const response = await fetch(config.socketUrl.replace(/^ws/, "http"), {
      headers: headers(config),
    });

    if (response.status === 403) {
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (body && typeof body.error === "string") return body.error;
    }

    if (response.status === 401) return "worker token rejected";
  } catch {
    // The engine is unreachable. Backoff is the whole response.
  }

  return error instanceof Error ? error.message : "connect failed";
}

function headers(config: Config): Record<string, string> {
  return {
    authorization: `Bearer ${config.token}`,
    "x-puppi-worker-version": WORKER_VERSION,
    "x-puppi-residency": config.residency,
    "x-puppi-worker-id": config.workerId,
    ...trustedHeader(config),
  };
}

function trustedHeader(config: Config): Record<string, string> {
  if (config.trustedKeys.length === 0) return {};

  return { "x-puppi-trusted-keys": config.trustedKeys.map((key) => key.fingerprint).join(",") };
}

function readConfigFields(): Config {
  const engineUrl = required("PUPPI_ENGINE_URL").replace(/\/$/, "");
  const url = new URL(engineUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/workers/socket";
  url.search = "";
  url.hash = "";

  return {
    socketUrl: url.toString(),
    bundleUrl: `${engineUrl}/api/v1/executor/claims/bundle`,
    token: readToken(),
    workerId: optional("PUPPI_WORKER_ID") ?? hostname(),
    slots: readSlots(),
    residency: readResidency(),
    cacheDir: optional("PUPPI_BUNDLE_CACHE"),
    secretsDir: optional("PUPPI_SECRETS_DIR"),
    trustedKeys: parseTrustedKeys(optional("PUPPI_TRUSTED_KEYS")),
  };
}

function readConfig(): Config {
  const config = readConfigFields();

  if (config.residency === "strict" && config.trustedKeys.length === 0) {
    throw new Error(STRICT_REQUIRES_TRUSTED_KEYS);
  }

  return config;
}

function readToken(): string {
  const inline = optional("PUPPI_WORKER_TOKEN");
  if (inline) return inline;

  const file = optional("PUPPI_WORKER_TOKEN_FILE");
  if (!file) throw new Error("PUPPI_WORKER_TOKEN or PUPPI_WORKER_TOKEN_FILE is required");

  return readFileSync(file, "utf8").trim();
}

function readSlots(): number {
  const raw = optional("PUPPI_WORKER_SLOTS");
  if (!raw) return 1;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("PUPPI_WORKER_SLOTS must be a positive integer");

  return Number(raw);
}

function readResidency(): Residency {
  const raw = optional("PUPPI_RESIDENCY") ?? "standard";
  if (raw === "standard" || raw === "strict") return raw;

  throw new Error("PUPPI_RESIDENCY must be standard or strict");
}

function childEnv(scratch: string): NodeJS.ProcessEnv {
  const copied: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("PUPPI_")) copied[key] = value;
  }

  // The runtime waits for an ack per event. `settle` is the `settled` frame.
  copied["PUPPI_EVENT_ACK"] = "1";
  // Stdin EOF means this worker died. The runtime removes the directory
  // named here, which a SIGKILL of this process would otherwise leak.
  copied["PUPPI_SCRATCH"] = scratch;
  copied["TMPDIR"] = scratch;
  return copied;
}

function attemptOf(state: State, frame: Record<string, unknown>): Attempt | undefined {
  const attemptId = frame["attempt_id"];
  const fence = frame["fence"];
  if (typeof attemptId !== "string" || typeof fence !== "number") return undefined;

  return state.attempts.get(keyOf(attemptId, fence));
}

function applySettled(attempt: Attempt, frame: Record<string, unknown>): void {
  if (attempt.lost || attempt.fenced || attempt.releasing) return;

  if (frame["reason"] === "cancelled") {
    attempt.awaiting = false;
    cancel(attempt);
    return;
  }

  if (frame["unknown"] === true) {
    if (attempt.awaiting && !attempt.releasing) {
      attempt.awaiting = false;
      attempt.releasing = true;
      const stdin = attempt.child?.stdin;
      if (stdin && !stdin.destroyed) stdin.end();
    }

    return;
  }

  const outcome = frame["outcome"];

  if (
    outcome === "recorded" ||
    outcome === "rejected" ||
    outcome === "fenced" ||
    outcome === "skipped"
  ) {
    if (!attempt.awaiting || attempt.releasing) return;

    attempt.awaiting = false;
    attempt.releasing = true;
    writeAck(attempt, { outcome });
    return;
  }

  if (frame["fenced"] === true) {
    stopFenced(attempt);
    return;
  }

  if (frame["fenced"] === false && attempt.pendingAcks > 0 && !attempt.cancelled) {
    attempt.pendingAcks -= 1;
    ack(attempt, { fenced: false });
  }
}

function ack(attempt: Attempt, payload: Record<string, unknown>): void {
  if (attempt.cancelled || attempt.lost || attempt.fenced) return;

  writeAck(attempt, payload);
}

function writeAck(attempt: Attempt, payload: Record<string, unknown>): void {
  const stdin = attempt.child?.stdin;
  if (!stdin || stdin.destroyed) return;

  stdin.write(`${JSON.stringify(payload)}\n`);
}

function stopFenced(attempt: Attempt): void {
  if (attempt.fenced || attempt.lost || attempt.releasing) return;

  attempt.fenced = true;
  attempt.pendingAcks = 0;
  attempt.awaiting = false;
  writeAck(attempt, { fenced: true });

  const child = attempt.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGKILL");
}

function leaseOf(frame: Record<string, unknown>): Lease | null {
  const claimToken = frame["claim_token"];
  const execution = frame["execution"];
  const secrets = frame["worker_secrets"];
  const signatures = frame["signatures"];

  if (typeof claimToken !== "string") return null;
  if (!isRecord(execution) || typeof execution["run_id"] !== "string") return null;

  try {
    assertValidLease(frame);
  } catch {
    return null;
  }

  const digest = frame.execution.bundle_digest;

  return {
    attemptId: frame.execution.attempt_id,
    fence: frame.execution.fence,
    runId: frame.execution.run_id,
    assetKey: frame.input.asset_key,
    digest: typeof digest === "string" ? digest : "",
    claimToken,
    execution: frame.execution,
    input: frame.input,
    workerSecrets: stringMap(secrets),
    signatures,
  };
}

function stringMap(value: unknown): Record<string, Record<string, string>> {
  if (!isRecord(value)) return {};

  const out: Record<string, Record<string, string>> = {};

  for (const [binding, fields] of Object.entries(value)) {
    if (!isRecord(fields)) continue;

    const inner: Record<string, string> = {};

    for (const [field, name] of Object.entries(fields)) {
      if (typeof name === "string") inner[field] = name;
    }

    out[binding] = inner;
  }

  return out;
}

function isEvent(value: unknown): value is ExecutorEvent {
  return isRecord(value) && typeof value["event"] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrame(text: string): Record<string, unknown> | null {
  return parseJsonRecord(text).record;
}

function parseJsonRecord(
  text: string,
): { record: Record<string, unknown> } | { record: null; bad: "line" | "value" } {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return { record: value };

    return { record: null, bad: "value" };
  } catch {
    return { record: null, bad: "line" };
  }
}

type ChildLine =
  | { kind: "empty" }
  | { kind: "bad"; message: string }
  | { kind: "dropped"; dropped: unknown; failed: unknown }
  | { kind: "event"; terminal: boolean; body: unknown; seq: unknown };

function parseChildLine(line: string): ChildLine {
  if (line === "") return { kind: "empty" };

  const parsed = parseJsonRecord(line);

  if (!parsed.record) {
    return {
      kind: "bad",
      message:
        parsed.bad === "line"
          ? "executor sent a non-event line"
          : "executor sent a non-event JSON value",
    };
  }

  const value = parsed.record;

  if (value["message"] === "dropped") {
    return { kind: "dropped", dropped: value["dropped"], failed: value["failed"] };
  }

  if (value["message"] !== "event" && value["message"] !== "complete") {
    return { kind: "bad", message: "executor sent a non-event JSON value" };
  }

  const terminal = value["message"] === "complete";

  return {
    kind: "event",
    terminal,
    body: terminal ? value["result"] : value["event"],
    seq: terminal ? value["last_seq"] : value["seq"],
  };
}

function textOf(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  return String(data);
}

function keyOf(attemptId: string, fence: number): string {
  return `${attemptId}:${fence}`;
}

function write(state: State, record: Record<string, unknown>): void {
  const masked = scrub(record, state.secretValues);
  process.stdout.write(`${JSON.stringify(masked)}\n`);
}

function backoff(failure: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(failure, 20));
  const floor = ceiling / 2;
  return Math.floor(floor + Math.random() * (ceiling - floor));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep();
      return;
    }

    const timer = setTimeout(resolveSleep, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolveSleep();
      },
      { once: true },
    );
  });
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;

  return value;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`${name} is required`);

  return value;
}

const invoked =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
