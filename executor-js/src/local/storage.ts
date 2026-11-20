/**
 * Storage a local run may touch: `read` and `query` work, `write` refuses.
 *
 * The wrapper covers user code and a destination's `deliver`, not only `main.ts`.
 */

import type { Row, StorageAdapter, TableStorage, WriteResult } from "@puppi/sdk";

import { TerminalError } from "../errors.js";

/**
 * The table name a custom check sees as `ctx.output`. Nothing was written, so
 * a check that queries it gets `relation "local_run_wrote_nothing" does not
 * exist` from the storage it asked — which says what happened.
 */
export const NO_OUTPUT_TABLE = "local_run_wrote_nothing";

/**
 * The bound storage, minus the ability to write. `read` and `query` are the
 * real thing, and `adapter` is resolved on first use rather than up front:
 * a source that only reaches an API must not need its storage to exist, or
 * this command has put a database back in front of the question it answers.
 */
export function readOnly(adapter: () => StorageAdapter): TableStorage {
  return {
    // `async`, so a caller holding the promise sees a rejection rather than a
    // synchronous throw out of something typed as returning one.
    write: async (storageRef: string): Promise<WriteResult> => {
      throw new TerminalError(
        `a local run writes nothing, so ${storageRef} was not created. ` +
          `\`puppi deploy && puppi run\` is what records a materialization.`,
      );
    },
    read: (storageRef: string) => (adapter() as TableStorage).read(storageRef),
    query: (sql: string, params?: unknown[]) => (adapter() as TableStorage).query(sql, params),
    drop: async (storageRef: string): Promise<void> => {
      throw new TerminalError(
        `a local run writes nothing, so ${storageRef} was not dropped. ` +
          `\`puppi deploy && puppi run\` is what records a materialization.`,
      );
    },
    // The pool constructed it and the pool closes it; closing here would
    // shut a connection the producer may still be using.
    close: () => Promise.resolve(),
  };
}

/**
 * No storage connection is bound, which is fine for a source that only
 * reaches an API and fatal for anything that reads. The refusal names the
 * file to fix, because the engine is not involved and so cannot be asked.
 */
export function noStorage(assetKey: string, reason: string): TableStorage {
  const refuse = async (what: string): Promise<never> => {
    throw new TerminalError(
      `${assetKey} ${what}, and this local run has no storage connection: ${reason}. ` +
        `Bind one in bindings.local.json, or run this asset after a deploy.`,
    );
  };

  return {
    write: (): Promise<WriteResult> => refuse("writes"),
    read: (): Promise<Row[]> => refuse("reads a materialization"),
    query: (): Promise<Row[]> => refuse("calls ctx.query()"),
    drop: (): Promise<void> => refuse("drops a materialization"),
    close: (): Promise<void> => Promise.resolve(),
  };
}
