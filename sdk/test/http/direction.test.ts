import { describe, expect, it } from "vitest";

import { read, write } from "../../src/index.js";

const DIRECTION = Symbol.for("puppi.direction");

function directionOf(fn: unknown): unknown {
  return typeof fn === "function"
    ? (fn as unknown as { [key: symbol]: unknown })[DIRECTION]
    : undefined;
}

function get(): void {}
function put(): void {}

describe("@read and @write", () => {
  it("stores the direction on the function under Symbol.for('puppi.direction')", () => {
    const context = {
      kind: "method",
      name: "get",
      static: false,
      private: false,
      addInitializer() {},
    } as unknown as ClassMethodDecoratorContext;

    expect(directionOf(read(get, context))).toBe("read");
    expect(directionOf(write(put, { ...context, name: "put" }))).toBe("write");
  });

  it("stores read_write when a method carries both decorators", () => {
    class Probe {
      @read
      @write
      query(): void {}
    }

    const query = (Probe.prototype as unknown as Record<string, unknown>)["query"];

    expect(directionOf(query)).toBe("read_write");
  });
});
