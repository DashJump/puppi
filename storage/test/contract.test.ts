import { describe, expect, it } from "vitest";

import { contentHash, deriveSchema } from "../src/index.js";

/**
 * The content digest backs "did this full_refresh source actually change?".
 * Two properties pull in opposite directions, so both are pinned here:
 * order must not matter, duplicates must. Postgres and the object stores
 * call this function; they do not keep a second copy of it.
 */
describe("contentHash", () => {
  it("ignores row order — a reordered result is not a change", () => {
    const a = contentHash([
      { id: "1", name: "ada" },
      { id: "2", name: "grace" },
    ]);
    const b = contentHash([
      { id: "2", name: "grace" },
      { id: "1", name: "ada" },
    ]);

    expect(a).toBe(b);
  });

  it("ignores key order within a row", () => {
    expect(contentHash([{ id: "1", name: "ada" }])).toBe(contentHash([{ name: "ada", id: "1" }]));
  });

  it("counts duplicates — two identical rows are not one", () => {
    // The trap: combining per-row hashes with XOR would make these equal,
    // because identical rows cancel out.
    expect(contentHash([{ id: "1" }])).not.toBe(contentHash([{ id: "1" }, { id: "1" }]));
  });

  it("changes when a value changes, or a column is added", () => {
    expect(contentHash([{ id: "1", plan: "pro" }])).not.toBe(
      contentHash([{ id: "1", plan: "free" }]),
    );
    expect(contentHash([{ id: "1" }])).not.toBe(contentHash([{ id: "1", plan: "pro" }]));
  });
});

describe("deriveSchema", () => {
  it("observes the one JS type a column's values share", () => {
    expect(deriveSchema([{ n: 1, f: 0.5, s: "x", b: true, j: { k: 1 } }])).toEqual([
      { name: "n", type: "integer" },
      { name: "f", type: "float" },
      { name: "s", type: "string" },
      { name: "b", type: "boolean" },
      { name: "j", type: "json" },
    ]);
  });

  it("widens integer and float to float, anything else to json, and marks missing values nullable", () => {
    expect(
      deriveSchema([
        { a: 1, b: 1, c: null },
        { a: 1.5, b: "x", d: 2 },
      ]),
    ).toEqual([
      { name: "a", type: "float" },
      { name: "b", type: "json" },
      { name: "c", type: "null" },
      { name: "d", type: "integer|null" },
    ]);
  });

  it("is empty for no rows and for rows with no columns", () => {
    expect(deriveSchema([])).toEqual([]);
    expect(deriveSchema([{}, {}])).toEqual([]);
  });
});
