/**
 * The local `schema_contract` verdict. A preview and a deploy use the same rules.
 *
 * Problems are reported in declared column order.
 */

import type { Column } from "../protocol.js";
import type { ContractVerdict } from "./protocol.js";

export function evaluateContract(declared: Column[] | null, observed: Column[]): ContractVerdict {
  if (!declared || declared.length === 0) {
    return { result: "undeclared", detail: "this asset declares no schema" };
  }

  const observedTypes = new Map(observed.map((column) => [column.name, column.type]));
  const problems = declared
    .map((column) => problem(column, observedTypes))
    .filter((found): found is string => found !== null);

  return problems.length === 0
    ? { result: "pass", detail: `${declared.length} declared columns present` }
    : { result: "fail", detail: problems.join("; ") };
}

function problem(column: Column, observed: Map<string, string>): string | null {
  const found = observed.get(column.name);

  if (found === undefined) return `missing column ${column.name}`;
  if (satisfies(normalize(column.type), normalize(found))) return null;

  return `${column.name}: declared ${column.type}, observed ${found}`;
}

interface Normalized {
  base: string;
  nullable: boolean;
}

function satisfies(declared: Normalized, observed: Normalized): boolean {
  // An all-null observation has base "null" and says nothing about the base
  // type, so only a nullable contract accepts it.
  if (observed.base === "null") return declared.nullable;

  // A float column whose values happen to be whole this run is observed as
  // `integer`, since the adapter observes types from values.
  const baseOk =
    declared.base === observed.base || (declared.base === "float" && observed.base === "integer");

  return baseOk && (declared.nullable || !observed.nullable);
}

/** `"String|Null"` -> `{ base: "string", nullable: true }`; `"null"` alone -> `{ "null", true }`. */
function normalize(type: string): Normalized {
  const parts = type
    .toLowerCase()
    .split("|")
    .map((part) => part.trim());
  const nullable = parts.includes("null");
  const bases = parts.filter((part) => part !== "null");

  return bases.length === 0 ? { base: "null", nullable: true } : { base: bases[0]!, nullable };
}
