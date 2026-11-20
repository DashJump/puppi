import { describe, expect, it, vi } from "vitest";

import { batchLogs, capLine, type LogBatch } from "../src/log-batch.js";
import type { ExecutorEvent } from "../src/protocol.js";

function recorded(): { sent: ExecutorEvent[]; batch: LogBatch } {
  const sent: ExecutorEvent[] = [];
  const batch = batchLogs(async (event) => {
    sent.push(event);
  });

  return { sent, batch };
}

describe("log batches", () => {
  it("cuts a line on a UTF-8 boundary and marks it truncated", () => {
    const cut = capLine(`${"a".repeat(4095)}éZ`);

    expect(cut.truncated).toBe(true);
    expect(cut.message).toBe("a".repeat(4095));
    expect(Buffer.byteLength(cut.message, "utf8")).toBe(4095);

    const fitted = capLine(`${"a".repeat(4094)}é`);
    expect(fitted).toEqual({ message: `${"a".repeat(4094)}é`, truncated: false });
  });

  it("flushes at 100 lines", async () => {
    const { sent, batch } = recorded();

    for (let index = 0; index < 99; index += 1) {
      await batch.emit({ event: "log", level: "info", message: `n${index}` });
    }

    expect(sent).toEqual([]);
    await batch.emit({ event: "log", level: "info", message: "n99" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: "logs" });

    if (sent[0]?.event === "logs") expect(sent[0].lines).toHaveLength(100);
  });

  it("flushes at 64 KB", async () => {
    const { sent, batch } = recorded();
    const chunk = "a".repeat(1024);

    for (let index = 0; index < 63; index += 1) {
      await batch.emit({ event: "log", level: "info", message: chunk });
    }

    expect(sent).toEqual([]);
    await batch.emit({ event: "log", level: "info", message: chunk });

    expect(sent).toHaveLength(1);

    if (sent[0]?.event === "logs") {
      const bytes = sent[0].lines.reduce(
        (total, line) => total + Buffer.byteLength(line.message, "utf8"),
        0,
      );
      expect(bytes).toBe(64 * 1024);
    }
  });

  it("flushes a partial batch on the interval", async () => {
    vi.useFakeTimers();

    try {
      const { sent, batch } = recorded();
      await batch.emit({ event: "log", level: "info", message: "waiting" });
      expect(sent).toEqual([]);

      await vi.advanceTimersByTimeAsync(999);
      expect(sent).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual([{ event: "logs", lines: [{ level: "info", message: "waiting" }] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a partial batch before complete", async () => {
    const { sent, batch } = recorded();

    await batch.emit({ event: "log", level: "info", message: "left" });
    expect(sent).toEqual([]);

    await batch.flush();
    await batch.emit({ event: "error", class: "terminal", message: "stop" });

    expect(sent.map((event) => event.event)).toEqual(["logs", "error"]);
  });

  it("flushes pending lines before another event", async () => {
    const { sent, batch } = recorded();

    await batch.emit({ event: "log", level: "info", message: "before" });
    await batch.emit({ event: "checkpoint", state: { page: 1 } });

    expect(sent.map((event) => event.event)).toEqual(["logs", "checkpoint"]);
  });
});
