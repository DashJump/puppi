/**
 * `evaluateContract` answers whether a declared column type still holds for
 * an observed type. A local preview and a deploy have to agree, so these
 * cases pin that verdict. A rule that moved on one side and not the other
 * would make a local run's verdict a lie about what a deploy will do.
 */

import { describe, expect, it } from "vitest";

import { evaluateContract } from "../src/local/contract.js";

function verdict(declaredType: string, observedType: string): [string, string] {
  const result = evaluateContract(
    [{ name: "c", type: declaredType }],
    [{ name: "c", type: observedType }],
  );

  return [result.result, result.detail];
}

describe("the contract's type rule", () => {
  it("passes an exact match, case and null order aside", () => {
    expect(verdict("string", "String")[0]).toBe("pass");
    expect(verdict("string|null", "null|string")[0]).toBe("pass");
  });

  it("lets a whole-number column satisfy a float contract, but not the reverse", () => {
    // The adapter observes types from values, so a float column whose values
    // happen to be whole this run is observed as `integer`.
    expect(verdict("float", "integer")[0]).toBe("pass");
    expect(verdict("float|null", "integer")[0]).toBe("pass");

    const [result, detail] = verdict("integer", "float");

    expect(result).toBe("fail");
    expect(detail).toContain("declared integer, observed float");
  });

  it("satisfies a nullable contract without nulls, and needs nulls declared", () => {
    expect(verdict("string|null", "string")[0]).toBe("pass");
    expect(verdict("string", "string|null")[0]).toBe("fail");
  });

  it("lets an all-null column satisfy only a nullable contract", () => {
    expect(verdict("string|null", "null")[0]).toBe("pass");
    expect(verdict("string", "null")[0]).toBe("fail");
  });

  it("fails a missing column and a different base type", () => {
    expect(evaluateContract([{ name: "c", type: "string" }], [])).toEqual({
      result: "fail",
      detail: "missing column c",
    });

    expect(verdict("string", "json")[0]).toBe("fail");
  });
});

describe("an undeclared schema and an extra column", () => {
  it("has no verdict when the asset declares no schema", () => {
    expect(evaluateContract(null, [{ name: "c", type: "string" }]).result).toBe("undeclared");
    expect(evaluateContract([], []).result).toBe("undeclared");
  });

  it("passes an observed column the contract does not mention", () => {
    const result = evaluateContract(
      [{ name: "c", type: "string" }],
      [
        { name: "c", type: "string" },
        { name: "extra", type: "boolean" },
      ],
    );

    expect(result).toEqual({ result: "pass", detail: "1 declared columns present" });
  });

  it("reports every problem, in the order the columns were declared", () => {
    const result = evaluateContract(
      [
        { name: "a", type: "string" },
        { name: "b", type: "integer" },
        { name: "c", type: "string" },
      ],
      [
        { name: "c", type: "json" },
        { name: "a", type: "string" },
      ],
    );

    expect(result).toEqual({
      result: "fail",
      detail: "missing column b; c: declared string, observed json",
    });
  });
});
