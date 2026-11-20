import type { StorageAdapter } from "@puppi/sdk";
import type { ConnectionDirection } from "@puppi/sdk/protocol";
import { describe, expect, it } from "vitest";

import type { Binding, ExecutorEvent } from "../src/protocol.js";
import { Shim } from "../src/shim/ctx.js";

const DIRECTION = Symbol.for("puppi.direction");

const dumpStore: Binding = {
  type: "s3",
  config: { bucket: "dumps" },
  secrets: {},
  mode: "read_only",
};

function store(): {
  prefix: string;
  head: () => string;
  get: () => string;
  put: () => string;
  drop: () => string;
  mystery: () => string;
} {
  const client = {
    prefix: "p",
    head() {
      return "head";
    },
    get() {
      return "get";
    },
    put(this: { prefix: string }) {
      return this.prefix;
    },
    drop() {
      return "drop";
    },
    mystery() {
      return "mystery";
    },
  };

  const methods = client as unknown as Record<string, unknown>;

  Object.defineProperty(methods["head"] as object, DIRECTION, { value: "read" });
  Object.defineProperty(methods["get"] as object, DIRECTION, { value: "read" });
  Object.defineProperty(methods["put"] as object, DIRECTION, { value: "write" });
  Object.defineProperty(methods["drop"] as object, DIRECTION, { value: "write" });

  return client;
}

function shim(recorded: Record<string, ConnectionDirection>, events: ExecutorEvent[]) {
  const client = store();
  const attempt = {
    asset_key: "core/x",
    partition: "",
    inputs: {},
    checkpoint: null,
    cursor_from: null,
    latest: null,
    bindings: { dump_store: dumpStore },
    storage_connection: null,
    connections: recorded,
  };
  const wrapped = new Shim(
    attempt,
    {} as StorageAdapter,
    "read_only",
    (event) => events.push(event),
    { get: () => client },
  );

  return { wrapped, client: wrapped.connection("dump_store") as ReturnType<typeof store> };
}

describe("ctx.connection direction warnings", () => {
  it("warns when a write runs on a connection recorded as read, and still returns", () => {
    const events: ExecutorEvent[] = [];
    const { client } = shim({ dump_store: "read" }, events);

    expect(client.put()).toBe("p");
    expect(client.put()).toBe("p");
    expect(client.drop()).toBe("drop");
    expect(events).toContainEqual({
      event: "log",
      level: "warn",
      message: "core/x called dump_store.put(), a write, but recorded dump_store as read",
    });
    expect(events).toContainEqual({
      event: "log",
      level: "warn",
      message: "core/x called dump_store.drop(), a write, but recorded dump_store as read",
    });
    expect(
      events.filter((event) => event.event === "log" && event.message.includes(".put()")),
    ).toHaveLength(1);
  });

  it("does not warn when a read runs, or when a write was recorded", () => {
    const readEvents: ExecutorEvent[] = [];
    const { client: reading } = shim({ dump_store: "read" }, readEvents);

    expect(reading.head()).toBe("head");
    expect(reading.get()).toBe("get");
    expect(readEvents).toEqual([]);

    const writeEvents: ExecutorEvent[] = [];
    const { client: writing } = shim({ dump_store: "write" }, writeEvents);

    expect(writing.put()).toBe("p");
    expect(writing.drop()).toBe("drop");
    expect(writeEvents).toEqual([]);
  });

  it("records a call to a method with no annotation and does not throw", () => {
    const events: ExecutorEvent[] = [];
    const { client } = shim({ dump_store: "read" }, events);

    expect(client.mystery()).toBe("mystery");
    expect(events).toContainEqual({
      event: "log",
      level: "warn",
      message: "core/x called dump_store.mystery(), which has no direction annotation",
    });
  });
});
