import type {
  StorageAdapter,
  TableStorage,
  AssetInput,
  AssetKey,
  CheckCtx,
  ConnectionClient,
  ConnectionName,
  Ctx,
  FileRef,
  LogLevel,
  ProcessPagesOptions,
  ProcessPagesResult,
  Row,
  TableRef,
  Telemetry,
} from "@puppi/sdk";
import type { InputRef } from "@puppi/sdk/protocol";

import { TerminalError } from "../errors.js";
import type { Attempt, Binding, ExecutorEvent } from "../protocol.js";
import { TelemetryShim } from "../telemetry.js";
import { Directed } from "./direct.js";
import { Pages, type StagedPage } from "./pages.js";
import { assertCheckpoint } from "./positions.js";
import { ProcessPages } from "./process-pages.js";
import type { Spool } from "./spool.js";
import { Unchanged } from "./unchanged.js";

/**
 * Hands out the adapter for a bound connection, constructing each one at
 * most once per attempt. The runtime owns construction and closing; the
 * shim only asks.
 */
export interface Connections {
  get(name: string): unknown;
}

/** What the executor knows about the asset being run. Staging applies to `append` only. */
export interface ShimAsset {
  mode?: string;
  /** `config.cursor`. Recorded on a `processPages` checkpoint so `cursor_to` can be read back. */
  cursor?: string;
}

/**
 * The `ctx` user code receives. Executor-provided and trusted, unlike the
 * adapters it wraps. Every call below is reported as a shim span, so a user
 * writes no instrumentation to get a trace of their producer; what they do
 * report goes through `telemetry` and is tagged as theirs.
 */
export class Shim implements Ctx {
  readonly cursorFrom: string | null;
  readonly telemetry: Telemetry;
  /** A table's storage ref, a file ref, or null on the first run. */
  readonly latest: TableRef | FileRef | null;

  private readonly rows: Row[] = [];
  private readonly spans: TelemetryShim;
  private readonly pages: Pages;
  private readonly assetMode: string | undefined;
  private readonly clients: Directed;
  private readonly pageWalk: ProcessPages;
  private emitted = false;
  private signaledUnchanged = false;
  private fileBody: {
    body: ReadableStream<Uint8Array>;
    contentType: string | null;
    meta: Record<string, unknown>;
  } | null = null;

  constructor(
    private readonly attempt: Attempt & { output_storage_ref?: string },
    private readonly adapter: StorageAdapter,
    private readonly mode: Binding["mode"],
    private readonly emitEvent: (event: ExecutorEvent) => void,
    private readonly connections: Connections = { get: () => undefined },
    asset: ShimAsset = {},
    /** Where emitted rows go instead of the heap. Without one, `collect` holds them. */
    private readonly spool: Spool | null = null,
  ) {
    const outputRef = attempt.output_storage_ref || null;
    const latest = attempt.latest;

    this.cursorFrom = attempt.cursor_from;
    this.assetMode = asset.mode;
    this.latest =
      latest?.file === true
        ? fileRef(latest, () => this.readObject(this.adapter, latest.storage_ref))
        : (latest?.storage_ref ?? null);
    this.spans = new TelemetryShim(emitEvent, "shim");
    this.telemetry = new TelemetryShim(emitEvent, "user");
    this.pages = new Pages(
      attempt.checkpoint,
      outputRef,
      asset.cursor,
      asset.mode === "append" && mode === "live" && outputRef !== null,
      adapter as TableStorage,
      attempt.asset_key,
      emitEvent,
      this.spans,
    );
    this.clients = new Directed(attempt.asset_key, attempt.connections, (event) => {
      this.emitEvent(event);
    });
    this.pageWalk = new ProcessPages(
      this.pages,
      attempt,
      this.cursorFrom,
      this.spans,
      (state) => {
        this.checkpoint(state);
      },
      () => {
        this.emitted = true;
      },
    );
  }

  get checkpointState(): Record<string, unknown> | null {
    return this.pages.checkpointState;
  }

  /** The last cursor whose page write completed during this attempt. */
  get cursorTo(): string | null {
    return this.pageWalk.cursorTo;
  }

  /**
   * The physical table of the upstream materialization the engine chose for
   * this attempt. The generics are the SDK's, compile-time only: here every
   * key is a string the engine resolved from the manifest.
   */
  readonly input = <K extends AssetKey>(key: K): AssetInput<K> => {
    const ref = this.attempt.inputs[key as string];

    if (!ref) {
      throw new TerminalError(
        `ctx.input("${key}") is not a declared dependency of ${this.attempt.asset_key}. ` +
          `Add it to deps if the compiler cannot see the key.`,
      );
    }

    this.emitEvent({ event: "read", asset_key: key });
    // The read itself happens in the SQL that embeds the ref, timed by
    // `query`; this records which input was resolved and when.
    this.spans.event("input_read", { key, materialization_id: ref.materialization_id });

    if (ref.file === true) return this.inputFile(ref) as AssetInput<K>;

    return ref.storage_ref as AssetInput<K>;
  };

  /**
   * `T` is the caller's assertion about the select list, and nothing here
   * compares the two. `emit` then checks the declared schema against that
   * assertion rather than against the rows, so the first verdict on the data
   * is `schema_contract`'s, after the write.
   */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the row type
  readonly query = async <T extends Row = Row>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> => {
    const attributes = { connection: this.attempt.storage_connection, rows: 0 };
    const rows = await this.spans.span(
      "query",
      async () => {
        const result = (await (this.adapter as TableStorage).query(sql, params)) as T[];
        attributes.rows = result.length;
        return result;
      },
      attributes,
    );

    return { rows };
  };

  /**
   * The adapter for a connection the engine bound and resolved for this
   * attempt. The engine resolves exactly the connections the manifest says
   * this asset reaches, so a name outside that set is a declaration gap,
   * not something to retry.
   */
  readonly connection = <K extends ConnectionName>(name: K): ConnectionClient<K> => {
    if (!this.attempt.bindings[name]) {
      throw new TerminalError(
        `ctx.connection("${name}") is not a connection ${this.attempt.asset_key} declares. ` +
          `The compile pass only sees a string literal; a computed name goes in \`reads\` or \`writes\`. ` +
          `Bound for this attempt: ${Object.keys(this.attempt.bindings).join(", ") || "none"}.`,
      );
    }

    return this.clients.direct(name, this.connections.get(name)) as ConnectionClient<K>;
  };

  /** No validation here: a throw would hide the contract failure. */
  readonly emit = async (rows: Row[]): Promise<void> => {
    if (this.mode === "read_only") {
      throw new TerminalError(
        `${this.attempt.asset_key} cannot emit: its storage binding is read_only`,
      );
    }

    if (this.fileBody) {
      throw new TerminalError(`${this.attempt.asset_key} called both ctx.emit and ctx.emitFile`);
    }

    // One span per batch. An append page that already has a checkpoint is
    // stored before this resolves, which is what makes `checkpoint` then
    // `await emit` the durability barrier.
    if (rows.length > 0) this.emitted = true;

    await this.spans.span(
      "emit",
      async () => {
        const kept = await this.pages.accept(rows);

        if (this.spool) await this.spool.add(kept);
        else for (const row of kept) this.rows.push(row);
      },
      { rows: rows.length },
    );
  };

  /**
   * One object for this materialization. The stream is stored as given;
   * nothing here reads it or writes it to the spool.
   */
  readonly emitFile = async (
    body: ReadableStream<Uint8Array>,
    options: { contentType?: string | null; meta?: Record<string, unknown> } = {},
  ): Promise<void> => {
    if (this.mode === "read_only") {
      throw new TerminalError(
        `${this.attempt.asset_key} cannot emit a file: its storage binding is read_only`,
      );
    }

    if (this.fileBody) {
      throw new TerminalError(
        `${this.attempt.asset_key} called ctx.emitFile twice. One attempt stores one object.`,
      );
    }

    if (this.emitted) {
      throw new TerminalError(`${this.attempt.asset_key} called both ctx.emit and ctx.emitFile`);
    }

    if (this.assetMode === "append") {
      throw new TerminalError(
        `${this.attempt.asset_key} is append and cannot store a file. A file asset is full_refresh.`,
      );
    }

    this.emitted = true;
    this.fileBody = {
      body,
      contentType: options.contentType ?? null,
      meta: options.meta ?? {},
    };
  };

  /** The object this attempt stored, when the producer called `ctx.emitFile`. */
  get file(): {
    body: ReadableStream<Uint8Array>;
    contentType: string | null;
    meta: Record<string, unknown>;
  } | null {
    return this.fileBody;
  }

  /**
   * Ends the producer without a write. A first run is allowed here: the
   * engine fails that attempt, so "never ran" stays distinct from a skip.
   */
  readonly unchanged = (): never => {
    if (this.emitted) {
      throw new TerminalError(`${this.attempt.asset_key} called ctx.unchanged() after emitting`);
    }

    this.signaledUnchanged = true;
    throw new Unchanged();
  };

  /** The producer called `ctx.unchanged()`, including when user code caught it. */
  get unchangedSignaled(): boolean {
    return this.signaledUnchanged;
  }

  /** Rows were emitted or staged in this attempt. `unchanged()` cannot follow that. */
  get emittedRows(): boolean {
    return this.emitted;
  }

  private inputFile(ref: InputRef): FileRef {
    return fileRef(ref, () => {
      const name = ref.storage_connection;

      if (!name) {
        throw new TerminalError(
          `ctx.input of ${ref.storage_ref} is a file and names no storage_connection`,
        );
      }

      return this.readObject(this.connections.get(name), ref.storage_ref);
    });
  }

  private readObject(client: unknown, ref: string): Promise<ReadableStream<Uint8Array>> {
    const get = (client as { get?: (storageRef: string) => Promise<ReadableStream<Uint8Array>> })
      .get;

    if (typeof get !== "function") {
      throw new TerminalError(`${ref} cannot be read: its storage does not implement get`);
    }

    return get.call(client, ref);
  }

  readonly processPages = <Fetched extends Row, Written extends Row = Fetched>(
    options: ProcessPagesOptions<Fetched, Written>,
  ): Promise<ProcessPagesResult> => this.pageWalk.run(options);

  readonly checkpoint = (state: Record<string, unknown>): void => {
    assertCheckpoint(state);
    this.pages.checkpoint(state);
  };

  beginWalk(): void {
    this.pages.beginWalk();
  }

  /**
   * Rows still in memory when `run` returns. Sealed append pages stay in
   * storage; `tail` is only the suffix emitted after the last checkpoint.
   */
  async finish(): Promise<{ buffer: Row[]; tail: Row[] }> {
    const tail = await this.pages.finish();

    if (this.pages.staging) return { buffer: [], tail };

    return { buffer: [...this.rows], tail: [] };
  }

  /**
   * Rows of the siblings stored before their checkpoints. Empty when this
   * attempt did not stage. The caller writes them with the uncheckpointed tail.
   */
  async stagedRows(): Promise<Row[]> {
    return this.pages.stagedRows();
  }

  /** Pages stored for this attempt, in checkpoint order. Does not read the rows. */
  stagedPages(): StagedPage[] {
    return this.pages.stagedPages();
  }

  /** Page keys stored for this output, in checkpoint order. Does not read the rows. */
  async stagedPageKeys(): Promise<string[]> {
    return this.pages.stagedPageKeys();
  }

  async settle(): Promise<void> {
    await this.pages.settle();
  }

  watermark(field: string, tail: readonly Row[] = []): string | null {
    return this.pages.watermark(field, tail);
  }

  async dropExpiredPageToken(error: unknown): Promise<boolean> {
    return this.pages.dropExpiredPageToken(error);
  }

  readonly log = (message: string, level: LogLevel = "info"): void => {
    this.emitEvent({ event: "log", level, message });
  };

  /** Everything emitted and not staged, for a runtime that writes once `run` returns. */
  collect(): Row[] {
    return this.rows;
  }
}

/**
 * The `ctx` a custom check receives, after the write. The rows are the ones
 * the producer emitted and `output` is the table they were written to, so a
 * check can judge either in memory or in SQL.
 */
export class CheckShim implements CheckCtx {
  constructor(
    readonly rows: readonly Row[],
    readonly output: TableRef,
    private readonly adapter: StorageAdapter,
    private readonly emitEvent: (event: ExecutorEvent) => void,
  ) {}

  /**
   * Bound properties rather than methods, on both shims: user code is
   * written as `({ rows, output, query }) => …` and `const { emit } = ctx`,
   * and a destructured method loses `this`. The one place a shim is handed
   * to user code is the one place that has to survive being taken apart.
   */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the row type
  readonly query = async <T extends Row = Row>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> => {
    return { rows: (await (this.adapter as TableStorage).query(sql, params)) as T[] };
  };

  readonly log = (message: string, level: LogLevel = "info"): void => {
    this.emitEvent({ event: "log", level, message });
  };
}

function fileRef(
  ref: {
    storage_ref: string;
    meta?: Record<string, unknown>;
    sha256?: string | null;
    bytes?: number | null;
    content_type?: string | null;
  },
  stream: () => Promise<ReadableStream<Uint8Array>>,
): FileRef {
  const storageRef = ref.storage_ref;

  return {
    meta: ref.meta ?? {},
    sha256: ref.sha256 ?? null,
    bytes: typeof ref.bytes === "number" ? ref.bytes : null,
    contentType: ref.content_type ?? null,
    toString: () => storageRef,
    stream,
  };
}

/** The attempt's storage binding: the one the engine named in `storage_connection`. */
export function storageBinding(input: Attempt): { name: string; binding: Binding } {
  const name = input.storage_connection;
  const binding = name === null ? undefined : input.bindings[name];

  if (name !== null && binding) return { name, binding };

  throw new TerminalError(
    name === null
      ? `${input.asset_key} has no storage connection; nothing can hold its materialization`
      : `the storage connection of ${input.asset_key} is ${name}, but the engine resolved no ` +
          `binding for it (bound: ${Object.keys(input.bindings).join(", ") || "none"})`,
  );
}
