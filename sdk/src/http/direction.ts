/**
 * Direction of a client method. `directionOf` reads
 * `Symbol.for("puppi.direction")` off the function. A method with neither
 * decorator is unknown. Applying both marks the method `read_write`.
 * The HTTP verb is not a direction.
 *
 * The symbol is global on purpose: the CLI, the executor, and a bundled
 * connector can each load their own copy of this module.
 */
const DIRECTION = Symbol.for("puppi.direction");

export type MethodDirection = "read" | "write";

/** The direction `@read` or `@write` stored on this function, or `undefined` when it has none. */
export function directionOf(method: unknown): MethodDirection | "read_write" | undefined {
  if (typeof method !== "function") return undefined;

  const value = (method as { [DIRECTION]?: unknown })[DIRECTION];

  return value === "read" || value === "write" || value === "read_write" ? value : undefined;
}

type AnyMethod = (...args: never[]) => unknown;

function annotate<T extends AnyMethod>(direction: MethodDirection, method: T): T {
  const current = directionOf(method);
  const value =
    current === "read_write" ||
    (current === "read" && direction === "write") ||
    (current === "write" && direction === "read")
      ? "read_write"
      : direction;

  // Configurable so the other decorator can replace this with `read_write`.
  Object.defineProperty(method, DIRECTION, { value, configurable: true });

  return method;
}

/** Marks a client method as a read. The return is the same function. */
export function read<T extends AnyMethod>(method: T, _context: ClassMethodDecoratorContext): T {
  return annotate("read", method);
}

/** Marks a client method as a write. The return is the same function. */
export function write<T extends AnyMethod>(method: T, _context: ClassMethodDecoratorContext): T {
  return annotate("write", method);
}
