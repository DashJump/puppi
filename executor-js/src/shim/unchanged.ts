/**
 * `ctx.unchanged()` leaving the producer. Not a failure: `execute` turns it
 * into a result the engine records as `skipped`.
 *
 * A class rather than a flag alone, so code after the call does not run.
 * `instanceof` is enough: the shim and `execute` are the same package, and
 * user code does not construct this.
 */
export class Unchanged extends Error {
  override readonly name = "Unchanged";

  constructor() {
    super("ctx.unchanged()");
  }
}

export function isUnchanged(error: unknown): error is Unchanged {
  return error instanceof Unchanged;
}
