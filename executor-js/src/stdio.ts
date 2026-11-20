/**
 * The framing both entry points use: one JSON object on stdin,
 * newline-delimited events on stdout, one terminal event, exit 0.
 *
 * The engine's runtime and the local harness answer to different callers, but
 * the *shape* of the conversation is the same, and it has two traps in it
 * that are easy to get wrong once each: a parse failure has to become an
 * event rather than a crash, and stdout to a pipe is asynchronous, so the last
 * event is lost unless it is drained before exiting.
 */

import { createInterface } from "node:readline";

export interface Served<Event> {
  emit: (event: Event) => void;
  /** What to say when stdin closed without a line. */
  noInput: Event;
  /** Parse and run one input line. Anything it throws goes to `onError`. */
  run: (line: string) => Promise<Event>;
  onError: (error: unknown) => Event;
}

export async function serve<Event>(options: Served<Event>): Promise<void> {
  const line = await firstLine();

  if (line === null) options.emit(options.noInput);
  else {
    try {
      options.emit(await options.run(line));
    } catch (error) {
      options.emit(options.onError(error));
    }
  }

  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(0);
}

async function firstLine(): Promise<string | null> {
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim()) return line;
  }

  return null;
}
