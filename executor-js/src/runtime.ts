/** Stdio framing for the reusable one-Attempt executor. One V2 lease in, envelopes out. */

import { realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

import { isDropTables, runDropTables } from "./drop-tables.js";
import { AttemptCancelled, errorEvent, execute } from "./execute.js";
import { batchLogs } from "./log-batch.js";
import {
  assertValidLease,
  orphanComplete,
  peekExecution,
  speak,
  type CompleteEnvelope,
  type OutboundEnvelope,
} from "./protocol.js";
import { serve } from "./stdio.js";

/**
 * The engine sets this so each envelope waits for an ack. A fenced ack rejects
 * before the next storage write. `puppi try` and the protocol test
 * leave it unset and keep the one-way stream.
 */
const ackEvents = process.env["PUPPI_EVENT_ACK"] === "1";

function writeEnvelope(envelope: OutboundEnvelope): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

if (!ackEvents) {
  void serve<OutboundEnvelope>({
    emit: writeEnvelope,
    noInput: orphanComplete("executor received no input"),
    run: async (line) => runLine(line, writeEnvelope),
    onError: (error) => orphanComplete(error instanceof Error ? error.message : String(error)),
  });
} else {
  void runAcked();
}

async function runLine(
  line: string,
  emit: (envelope: OutboundEnvelope) => void,
): Promise<CompleteEnvelope> {
  let attempt = speak({ attempt_id: "unknown", fence: 1 });
  let logs: ReturnType<typeof batchLogs> | undefined;

  try {
    const parsed: unknown = JSON.parse(line);

    if (isDropTables(parsed)) return runDropTables(parsed) as unknown as CompleteEnvelope;

    const known = peekExecution(parsed);

    if (known) attempt = speak(known);

    assertValidLease(parsed);

    const batch = batchLogs((event) => {
      emit(attempt.event(event));
    });
    logs = batch;

    const result = await execute(parsed.input, (event) => batch.emit(event));
    await batch.flush();

    return attempt.complete(result);
  } catch (error) {
    await logs?.flush();
    return attempt.complete(errorEvent(error));
  }
}

interface Ack {
  ok?: boolean;
  fenced?: boolean;
  outcome?: "recorded" | "rejected" | "fenced" | "skipped";
}

function isAbort(line: string): boolean {
  try {
    const parsed: unknown = JSON.parse(line);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { abort?: unknown }).abort === true
    );
  } catch {
    return false;
  }
}

async function runAcked(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  const queued: string[] = [];
  // A checkpoint and the span emitted beside it both wait in one turn, and
  // so can `ctx.log`. The first ack belongs to the oldest waiter.
  const waiters: ((line: string | null) => void)[] = [];
  let closed = false;
  let finishing = false;
  let closeHandled = false;
  let aborted = false;
  // Read before user code runs. A bundle can retarget the variable; the
  // directory created at startup still has to be removed, and a path outside
  // this launcher's root must not be.
  const owned = captureScratch();

  const abortAttempt = (): void => {
    if (aborted) return;

    aborted = true;
    const pending = waiters.splice(0);

    if (pending.length === 0) {
      // The producer is not waiting on an ack, so this line would sit unread
      // until the parent's grace killed the process.
      finishing = true;
      process.exit(0);
    }

    for (const resolveWaiter of pending) resolveWaiter(null);
  };

  lines.on("line", (line) => {
    if (!line.trim()) return;

    if (isAbort(line)) {
      abortAttempt();
      return;
    }

    const resolveWaiter = waiters.shift();

    if (resolveWaiter) {
      resolveWaiter(line);
      return;
    }

    queued.push(line);
  });
  lines.on("close", () => {
    if (closeHandled) return;

    closeHandled = true;
    closed = true;

    for (const resolveWaiter of waiters.splice(0)) resolveWaiter(null);

    if (finishing) {
      process.stdout.write("", () => {
        process.exit(0);
      });
      return;
    }

    deleteOwned(owned);
    process.exit(1);
  });

  const nextLine = (): Promise<string | null> => {
    const found = queued.shift();

    if (found !== undefined) return Promise.resolve(found);
    if (closed) return Promise.resolve(null);

    return new Promise((resolveLine) => {
      waiters.push(resolveLine);
    });
  };

  const ackFor = async (envelope: OutboundEnvelope): Promise<Ack> => {
    writeEnvelope(envelope);
    const line = await nextLine();

    if (line === null) {
      if (aborted) throw new AttemptCancelled();

      throw new Error("attempt outcome unknown");
    }

    try {
      return JSON.parse(line) as Ack;
    } catch {
      throw new Error("attempt outcome unknown");
    }
  };

  const waitAck = async (envelope: OutboundEnvelope): Promise<void> => {
    const ack = await ackFor(envelope);

    if (ack.fenced) throw new Error("attempt fence rejected");
  };

  let attempt = speak({ attempt_id: "unknown", fence: 1 });
  let settled = false;
  let logs: ReturnType<typeof batchLogs> | undefined;

  try {
    const inputLine = await nextLine();

    if (inputLine === null) {
      if (aborted) return;

      await waitAck(orphanComplete("executor received no input"));
      return;
    }

    const parsed: unknown = JSON.parse(inputLine);

    if (isDropTables(parsed)) {
      writeEnvelope((await runDropTables(parsed)) as unknown as OutboundEnvelope);
      return;
    }

    const known = peekExecution(parsed);

    if (known) attempt = speak(known);

    assertValidLease(parsed);

    const batch = batchLogs(async (event) => {
      await waitAck(attempt.event(event));
    });
    logs = batch;

    await execute(
      parsed.input,
      (event) => batch.emit(event),
      async (result) => {
        await batch.flush();
        const ack = await ackFor(attempt.complete(result));
        settled = true;

        if (
          ack.outcome === "recorded" ||
          ack.outcome === "rejected" ||
          ack.outcome === "fenced" ||
          ack.outcome === "skipped"
        ) {
          return ack.outcome;
        }

        throw new Error("attempt outcome unknown");
      },
    );
    await batch.flush();
  } catch (error) {
    // A complete after abort waits for an ack the parent will not send.
    if (!(error instanceof AttemptCancelled) && !settled) {
      try {
        await logs?.flush();
        await waitAck(attempt.complete(errorEvent(error)));
      } catch {
        // The fence already stopped the attempt.
      }
    }
  } finally {
    finishing = true;
    lines.close();
  }
}

interface OwnedScratch {
  root: string;
  dir: string;
}

function captureScratch(): OwnedScratch | undefined {
  const dir = process.env["PUPPI_SCRATCH"];
  if (!dir) return undefined;

  const resolved = resolve(dir);
  return { root: dirname(resolved), dir: resolved };
}

function deleteOwned(owned: OwnedScratch | undefined): void {
  if (!owned) return;

  removeIfInside(owned.root, owned.dir);
  const current = process.env["PUPPI_SCRATCH"];

  if (current && resolve(current) !== owned.dir) removeIfInside(owned.root, current);
}

/** `relative` stays under the root. `..` and an absolute result are outside it. */
function removeIfInside(root: string, target: string): void {
  try {
    const rootReal = realpathSync(root);
    const targetReal = realpathSync(target);
    const rel = relative(rootReal, targetReal);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;

    rmSync(targetReal, { recursive: true, force: true });
  } catch {
    // The directory is already gone, or it is not a real path under the root.
  }
}
