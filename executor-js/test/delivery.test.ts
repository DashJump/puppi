import { describe, expect, it } from "vitest";

import { deliverInOrder } from "../src/worker/delivery.js";

describe("broker delivery", () => {
  it("resolves the ack only after that event is sent", async () => {
    let release: (() => void) | undefined;
    const previous = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = false;
    const { ack } = deliverInOrder(previous, async () => {
      sent = true;
    });
    let acked = false;
    const pending = ack.then(() => {
      acked = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toBe(false);
    expect(acked).toBe(false);
    release?.();
    await pending;
    expect(sent).toBe(true);
    expect(acked).toBe(true);
  });
});
