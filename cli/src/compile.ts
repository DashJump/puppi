import { directionOf, type Declaration, type Registry } from "@puppi/sdk";
import type { ConnectionDirection } from "@puppi/sdk/protocol";
import { parseSync } from "oxc-parser";

import { producerSource } from "./collect.js";

export interface CompileContext {
  /** Project connections, keyed by name. Direction lookup uses `type`. */
  connections: Record<string, { type: string }>;
  /** Adapters keyed by connection type. `Client` carries the method annotations. */
  adapters?: Record<string, { Client?: unknown }>;
}

export interface CompileResult {
  /** asset key -> the declared assets its producer reads through `ctx.input("…")`. */
  deps: Record<string, string[]>;
  /** Literals that name no declared asset. */
  unresolved: { asset: string; key: string }[];
  /**
   * asset key -> connection name -> direction. A bare `ctx.connection()`
   * with no method, or a method with no annotation, is `unknown`.
   */
  connections: Record<string, Record<string, ConnectionDirection>>;
  /** Mismatches and missing annotations. Nothing here fails the build. */
  warnings: string[];
  /** Assets whose producer calls `ctx.emitFile`. The value is always true. */
  files: Record<string, true>;
}

interface Seen {
  reads: string[];
  writes: string[];
  /** Method names with no annotation. An empty string is a bare `ctx.connection()`. */
  unknown: string[];
}

interface Reach {
  connection: string;
  method: string | null;
}

/** The compile pass: `ctx.input("…")` literals, and the direction of each `ctx.connection("…")`. */
export function compile(registry: Registry, context: CompileContext): CompileResult {
  const deps: Record<string, string[]> = {};
  const unresolved: CompileResult["unresolved"] = [];
  const connections: CompileResult["connections"] = {};
  const warnings: string[] = [];
  const files: Record<string, true> = {};

  for (const [key, declaration] of Object.entries(registry.assets)) {
    const reads = new Set<string>();

    for (const literal of inputLiterals(declaration)) {
      if (literal === key) continue;

      if (Object.hasOwn(registry.assets, literal)) reads.add(literal);
      else unresolved.push({ asset: key, key: literal });
    }

    deps[key] = [...reads];

    const seen = reaches(declaration, context);
    const declaredReads = declaration.reads ?? [];
    const declaredWrites = declaration.writes ?? [];

    connections[key] = directionsFor(key, seen, declaredReads, declaredWrites, context, warnings);
    if (callsEmitFile(declaration)) files[key] = true;
  }

  return { deps, unresolved, connections, warnings, files };
}

function directionsFor(
  asset: string,
  seen: Map<string, Seen>,
  declaredReads: string[],
  declaredWrites: string[],
  context: CompileContext,
  warnings: string[],
): Record<string, ConnectionDirection> {
  const reads = new Set(declaredReads);
  const writes = new Set(declaredWrites);
  const names = new Set<string>([...seen.keys(), ...reads, ...writes]);
  const directions: Record<string, ConnectionDirection> = {};

  for (const name of [...names].sort()) {
    const record = seen.get(name);
    const extracted = record ? extractedDirection(record) : undefined;
    let direction = extracted;

    if (reads.has(name)) direction = merge(direction, "read");
    if (writes.has(name)) direction = merge(direction, "write");

    directions[name] = direction ?? "unknown";

    const unannotated = new Set(record?.unknown ?? []);

    for (const method of unannotated) {
      if (method === "") continue;

      warnings.push(
        `${asset} calls ${method}() on connection "${name}" (${connectionType(context, name)}), ` +
          `which has no direction annotation`,
      );
    }
  }

  for (const name of declaredReads) {
    const record = seen.get(name);

    if (record && record.writes.length > 0 && !writes.has(name)) {
      const method = record.writes[0];

      warnings.push(
        `${asset} declares reads: [${JSON.stringify(name)}] but the build saw a write on ` +
          `"${name}" (${connectionType(context, name)}.${method}())`,
      );
    }
  }

  for (const name of declaredWrites) {
    const record = seen.get(name);

    if (record && onlyReads(record)) {
      warnings.push(
        `${asset} declares writes: [${JSON.stringify(name)}] but the build saw only reads on "${name}"`,
      );
    }
  }

  for (const name of declaredReads) {
    if (!Object.hasOwn(context.connections, name)) {
      warnings.push(`${asset} names "${name}" in reads, which is not a declared connection`);
    }
  }

  for (const name of declaredWrites) {
    if (!Object.hasOwn(context.connections, name)) {
      warnings.push(`${asset} names "${name}" in writes, which is not a declared connection`);
    }
  }

  return directions;
}

/** Known read and write together are `read_write`. A known direction wins over `unknown`. */
function merge(
  current: ConnectionDirection | undefined,
  next: ConnectionDirection,
): ConnectionDirection {
  if (!current || current === next) return next;
  if (current === "unknown") return next;
  if (next === "unknown") return current;
  if (current === "read_write" || next === "read_write") return "read_write";
  if ((current === "read" && next === "write") || (current === "write" && next === "read")) {
    return "read_write";
  }

  return next;
}

function extractedDirection(record: Seen): ConnectionDirection {
  const hasRead = record.reads.length > 0;
  const hasWrite = record.writes.length > 0;

  if (hasRead && hasWrite) return "read_write";
  if (hasWrite) return "write";
  if (hasRead) return "read";

  return "unknown";
}

/** At least one annotated read, and no write or unannotated method. A bare call is not a read. */
function onlyReads(record: Seen): boolean {
  return (
    record.reads.length > 0 &&
    record.writes.length === 0 &&
    record.unknown.every((method) => method === "")
  );
}

function connectionType(context: CompileContext, name: string): string {
  return context.connections[name]?.type ?? "unknown";
}

function reaches(declaration: Declaration, context: CompileContext): Map<string, Seen> {
  const found = new Map<string, Seen>();
  const source = producerSource(declaration);

  if (!source) return found;

  const calls: Reach[] = [];

  walk(parseProducer(declaration.key, source), new Map(), calls);

  for (const call of calls) {
    const record = found.get(call.connection) ?? { reads: [], writes: [], unknown: [] };
    const direction =
      call.method === null ? "unknown" : methodDirection(context, call.connection, call.method);

    if (direction === "read" && call.method) record.reads.push(call.method);
    else if (direction === "write" && call.method) record.writes.push(call.method);
    else if (direction === "read_write" && call.method) {
      record.reads.push(call.method);
      record.writes.push(call.method);
    } else record.unknown.push(call.method ?? "");

    found.set(call.connection, record);
  }

  return found;
}

function methodDirection(
  context: CompileContext,
  name: string,
  method: string,
): "read" | "write" | "read_write" | "unknown" {
  const Client = context.adapters?.[connectionType(context, name)]?.Client;

  return directionOf(methodFunction(Client, method)) ?? "unknown";
}

function methodFunction(Client: unknown, method: string): unknown {
  if (typeof Client !== "function") return undefined;

  let proto: object | null = (Client as { prototype?: object }).prototype ?? null;

  while (proto && proto !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, method);

    if (descriptor && "value" in descriptor) return descriptor.value;

    proto = Object.getPrototypeOf(proto);
  }

  return undefined;
}

/** True when the producer's own source contains a `.emitFile(` call. */
function callsEmitFile(declaration: Declaration): boolean {
  const source = producerSource(declaration);

  if (!source) return false;

  return hasMemberCall(parseProducer(declaration.key, source), "emitFile");
}

/** Every string literal passed to a `.input(…)` call in this producer's own source. */
function inputLiterals(declaration: Declaration): string[] {
  return callLiterals(declaration, "input");
}

function callLiterals(declaration: Declaration, method: string): string[] {
  const source = producerSource(declaration);

  if (!source) return [];

  const found: string[] = [];
  walkLiterals(parseProducer(declaration.key, source), method, found);

  return found;
}

/**
 * `Function.prototype.toString()` yields an expression for an arrow or a
 * `function`, but a method shorthand (`async run(ctx) {}`) only parses as an
 * object member.
 */
function parseProducer(key: string, source: string): unknown {
  const attempts = [`const producer = ${source};`, `const producer = { ${source} };`];
  let errors: string[] = [];

  for (const text of attempts) {
    const parsed = parseSync("producer.js", text, { sourceType: "module", lang: "js" });

    if (parsed.errors.length === 0) return parsed.program;
    if (errors.length === 0) errors = parsed.errors.map((error) => error.message);
  }

  throw new Error(`could not parse the producer of ${key}: ${errors.join("; ")}`);
}

type Node = Record<string, unknown>;

const SPAN_KEYS = new Set(["type", "start", "end"]);

function walkLiterals(node: unknown, method: string, found: string[]): void {
  if (!node || typeof node !== "object") return;

  if (!Array.isArray(node)) {
    const literal = callLiteral(node as Node, method);
    if (literal !== null) found.push(literal);
  }

  for (const [key, child] of Object.entries(node)) {
    if (!SPAN_KEYS.has(key)) walkLiterals(child, method, found);
  }
}

/**
 * The literal argument of a `.<method>("…")` call, or null. Matched on the
 * method name, whatever the receiver is called.
 */
function callLiteral(node: Node, method: string): string | null {
  if (node["type"] !== "CallExpression" || !isCallee(node["callee"], method)) return null;

  const [first] = node["arguments"] as Node[];

  return first ? stringLiteral(first) : null;
}

function hasMemberCall(node: unknown, method: string): boolean {
  if (!node || typeof node !== "object") return false;

  if (!Array.isArray(node)) {
    const call = node as Node;

    if (call["type"] === "CallExpression" && isCallee(call["callee"], method)) return true;
  }

  for (const [key, child] of Object.entries(node)) {
    if (!SPAN_KEYS.has(key) && hasMemberCall(child, method)) return true;
  }

  return false;
}

function isCallee(callee: unknown, method: string): boolean {
  const node = callee as { type?: string; property?: { name?: unknown } } | undefined;

  return node?.type === "MemberExpression" && node.property?.name === method;
}

function stringLiteral(node: Node): string | null {
  if (node["type"] === "Literal") {
    return typeof node["value"] === "string" ? node["value"] : null;
  }

  if (node["type"] === "TemplateLiteral") {
    const { expressions, quasis } = node as {
      expressions: unknown[];
      quasis: { value: { cooked: string | null } }[];
    };

    return expressions.length === 0 ? (quasis[0]?.value.cooked ?? null) : null;
  }

  return null;
}

function walk(node: unknown, aliases: Map<string, string>, found: Reach[]): void {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const child of node) walk(child, aliases, found);
    return;
  }

  const current = node as Node;
  const type = current["type"];

  if (type === "BlockStatement" || type === "Program" || type === "StaticBlock") {
    walk(current["body"], new Map(aliases), found);
    return;
  }

  if (type === "VariableDeclarator") {
    const id = current["id"] as Node | undefined;
    const connection = connectionName(current["init"]);

    if (connection && id?.["type"] === "Identifier" && typeof id["name"] === "string") {
      aliases.set(id["name"], connection);
      found.push({ connection, method: null });
      walk((unwrap(current["init"]) ?? {})["arguments"], aliases, found);
      return;
    }

    walk(current["init"], aliases, found);
    return;
  }

  if (type === "CallExpression") {
    const called = methodOnConnection(current, aliases);

    if (called) {
      found.push(called);
      walk(current["arguments"], aliases, found);
      return;
    }

    const connection = connectionName(current);

    if (connection) {
      found.push({ connection, method: null });
      walk(current["arguments"], aliases, found);
      return;
    }
  }

  for (const [key, child] of Object.entries(current)) {
    if (!SPAN_KEYS.has(key)) walk(child, aliases, found);
  }
}

function methodOnConnection(call: Node, aliases: Map<string, string>): Reach | null {
  const callee = call["callee"] as Node | undefined;

  if (!callee || callee["type"] !== "MemberExpression" || callee["computed"] === true) return null;

  const property = callee["property"] as Node | undefined;
  const method = property?.["name"];

  if (typeof method !== "string") return null;

  const direct = connectionName(callee["object"]);

  if (direct) return { connection: direct, method };

  const object = unwrap(callee["object"]);

  if (object?.["type"] === "Identifier" && typeof object["name"] === "string") {
    const aliased = aliases.get(object["name"]);

    if (aliased) return { connection: aliased, method };
  }

  return null;
}

function connectionName(node: unknown): string | null {
  const call = unwrap(node);

  if (!call || call["type"] !== "CallExpression" || !isCallee(call["callee"], "connection")) {
    return null;
  }

  const [first] = (call["arguments"] as Node[] | undefined) ?? [];

  return first ? stringLiteral(unwrap(first) ?? first) : null;
}

function unwrap(node: unknown): Node | null {
  let current = node as Node | null;

  while (
    current &&
    (current["type"] === "ParenthesizedExpression" ||
      current["type"] === "TSAsExpression" ||
      current["type"] === "TSSatisfiesExpression" ||
      current["type"] === "ChainExpression")
  ) {
    current = (current["expression"] as Node | undefined) ?? null;
  }

  return current;
}
