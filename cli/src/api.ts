/**
 * The hosted `/api/v1`. Every success is `{ data }`; a refusal is
 * `{ error, detail }` with a 4xx. Nothing here decides anything: it is
 * fetch, a bearer token, and the shapes. `PLACEMENTS` is the list
 * `puppi place` and `puppi env create --executor` check. A command that
 * only reads a placement takes `Environment.executor` as the server sent it.
 */

/**
 * Placements this CLI sets. Hosted workers are the default. Remote is the
 * opt-in for a pool the customer runs. Setters check a value against this
 * list. Readers do not: a stored executor this list does not name, including
 * one set by an engine mix task, is printed as the server sent it.
 */
export const PLACEMENTS = ["hosted", "remote"] as const;

export function isPlacement(value: string | undefined): value is (typeof PLACEMENTS)[number] {
  return (PLACEMENTS as readonly string[]).includes(value ?? "");
}

export interface ApiOptions {
  url: string;
  token?: string | undefined;
}

export interface Issue {
  kind: string;
  message: string;
  detail?: unknown;
}

/** `GET /health`: the engine is there, and the SDK version a bundle must be built against. */
export interface Health {
  status: string;
  sdk_version: string;
}

export interface Environment {
  id: string;
  name: string;
  kind: string;
  storage_prefix: string;
  strict: boolean;
  schedules_paused: boolean;
  /** The placement the engine stored for this environment. */
  executor: string;
  /** The client's signature over the name and storage prefix, when one was sent. */
  signature?: string | null;
  signing_key?: string | null;
  active_deployment_id: string | null;
  inserted_at: string;
}

export interface Binding {
  name: string;
  config: Record<string, unknown>;
  secret_refs: Record<string, string>;
  mode: string;
  signature?: string | null;
  signing_key?: string | null;
  updated_at: string;
}

/** Write-only: the value goes in, never comes back. */
export interface Secret {
  name: string;
  backend: string;
  version: number | null;
  rotated_at: string | null;
}

export interface Deployment {
  id: string;
  status: "building" | "ready" | "failed";
  active: boolean;
  git: { branch: string; sha: string };
  created_by: string | null;
  validation: { errors: Issue[]; warnings: Issue[] };
  allow_contract_changes: string[];
  signature?: string | null;
  signing_key?: string | null;
  inserted_at: string;
}

/** A worker token. `token` is present only on the create response. */
export interface WorkerToken {
  id: string;
  name: string;
  last_used_at: string | null;
  inserted_at: string | null;
  token?: string;
}

/** One connected worker, as `GET /workers` reports it. */
export interface PoolWorker {
  id: string;
  version: string | null;
  residency: string;
  free_slots: number;
  attempts: string[];
  secrets: string[];
  trusted_keys: string[];
}

export interface PoolView {
  queue_depth: number;
  workers: PoolWorker[];
}

/** The five stamps on an attempt, as ISO strings. */
export interface Timings {
  gated_at?: string;
  inputs_resolved_at?: string;
  executor_started_at?: string;
  producer_done_at?: string;
  checks_done_at?: string;
}

export interface Attempt {
  id: string;
  asset_key: string;
  partition: string | null;
  number: number;
  status: AttemptStatus;
  error_class: string | null;
  error_message: string | null;
  observed_reads: string[];
  secret_versions: Record<string, number>;
  logs: {
    level: string;
    message?: string;
    time?: string;
    withheld?: string[];
    worker_id?: string | null;
  }[];
  timings: Timings;
  started_at: string | null;
  finished_at: string | null;
}

export type AttemptStatus =
  | "running"
  | "success"
  | "failed"
  | "failed_by_check"
  | "skipped"
  | "blocked"
  | "cancelled";

export interface Run {
  id: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  plan: string[];
  selection: string[];
  trigger: Record<string, unknown>;
  attempts: Attempt[];
  /** asset key -> the terminal status of its last attempt. */
  outcome: Record<string, AttemptStatus>;
  started_at: string | null;
  finished_at: string | null;
  inserted_at: string;
}

export interface Check {
  kind: string;
  name: string;
  severity: string;
  result: "pass" | "fail";
  detail: string | null;
}

export interface Materialization {
  id: string;
  partition: string | null;
  storage_ref: string;
  inputs: string[];
  stats: { row_count: number; bytes: number | null; content_hash?: string | null };
  /** Columns the storage adapter reported. Present on materialization JSON. */
  observed_schema?: { name: string; type?: string }[];
  checks: Check[];
  quarantined: boolean;
  verified_at: string | null;
  created_at: string;
  state?: { state: string; is_latest: boolean; is_quarantined: boolean };
  /** Whether the data is still there to roll back to. Only on an asset's `history`. */
  retained?: boolean;
  /** One hop up: what this was built from. Only on `GET /materializations/:id`. */
  inputs_of?: { materialization_id: string; asset_key: string }[];
}

/** `blocked` is a run-time verdict, not a staleness one: the engine reports `current` or `stale`. */
export interface Staleness {
  partition: string;
  state: "current" | "stale";
  reasons: { reason: string; dep?: string | null; input?: string | null }[];
}

export interface Asset {
  key: string;
  definition: {
    role: string;
    group: string;
    visibility: "group" | "project" | "public";
    deps: string[];
    connections: Record<string, "read" | "write" | "read_write" | "unknown">;
    code_version: string;
    schedule: unknown;
    schema: { columns: { name: string; type: string }[] } | null;
    config: Record<string, unknown>;
    checks: Record<string, unknown>;
  };
  latest: Materialization | null;
  next_run_at: string | null;
  staleness: Staleness[];
  /** Only on `GET …/assets/*key`, newest first. */
  history?: Materialization[];
}

/**
 * What `puppi rollback` goes back to without `--to`: the newest
 * materialization behind latest that is not quarantined and still has its data.
 */
export function rollbackTarget(asset: Asset): string | undefined {
  const history = asset.history ?? [];
  // History is newest first, and latest is usually its head — but not after a
  // rollback, which points latest further back.
  const at = history.findIndex((m) => m.id === asset.latest?.id);

  return history.slice(at === -1 ? 1 : at + 1).find((m) => !m.quarantined && m.retained !== false)
    ?.id;
}

export interface RollbackOutcome {
  rolled_back: { asset_key: string; materialization_id: string };
  repointed: { asset_key: string; materialization_id: string }[];
  rebuilding: string[];
  unchanged: string[];
  run_id: string | null;
}

/** The engine answered with a refusal, or did not answer at all. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Api {
  /** The engine origin, without `/api/v1`. `env show` prints this. */
  readonly origin: string;
  readonly base: string;
  private readonly token: string | undefined;

  constructor(options: ApiOptions) {
    this.origin = options.url.replace(/\/+$/, "");
    this.base = `${this.origin}/api/v1`;
    this.token = options.token;
  }

  get<T>(path: string): Promise<T> {
    return this.data<T>("GET", path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.data<T>("POST", path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.data<T>("PUT", path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.data<T>("DELETE", path);
  }

  /** `PUT /bundles/:hash` takes raw bytes; everything else is JSON. */
  async putBytes(path: string, bytes: Uint8Array): Promise<number> {
    const response = await this.request("PUT", path, bytes, "application/octet-stream");

    if (response.status !== 201 && response.status !== 200) throw await this.failure(response);

    return response.status;
  }

  /** The status alone: 200 or 404, with anything else a refusal. */
  async head(path: string): Promise<number> {
    const response = await this.request("HEAD", path);

    if (response.status !== 200 && response.status !== 404) throw await this.failure(response);

    return response.status;
  }

  private async data<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      "application/json",
    );
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as { data?: T; error?: string; detail?: unknown }) : {};

    // A rejected deployment is a 422 that still carries its row; the caller
    // reports its validation errors rather than seeing an exception.
    if (!response.ok && parsed.data === undefined) throw this.refusal(response.status, parsed);

    return parsed.data as T;
  }

  private async failure(response: Response): Promise<ApiError> {
    const body = (await response.json().catch(() => ({}))) as { error?: string; detail?: unknown };

    return this.refusal(response.status, body);
  }

  private refusal(status: number, body: { error?: string; detail?: unknown }): ApiError {
    if (status === 401) {
      return new ApiError(status, "engine rejected the token; run `puppi login`");
    }

    const detail =
      typeof body.detail === "string"
        ? body.detail
        : Array.isArray(body.detail)
          ? body.detail.join(", ")
          : "";

    return new ApiError(
      status,
      `engine answered ${status} ${body.error ?? ""}${detail ? `: ${detail}` : ""}`.trim(),
    );
  }

  private async request(
    method: string,
    path: string,
    body?: string | Uint8Array,
    contentType?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };

    if (this.token) headers["authorization"] = `Bearer ${this.token}`;
    if (body !== undefined && contentType) headers["content-type"] = contentType;

    try {
      return await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body as RequestInit["body"],
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      throw new ApiError(0, `engine unreachable at ${this.base}: ${message}`);
    }
  }
}

/** An asset key is a path segment with slashes in it: `core/customer`. */
export function assetPath(environment: string, key: string): string {
  return `/environments/${encodeURIComponent(environment)}/assets/${key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
}

export function envPath(environment: string, suffix = ""): string {
  return `/environments/${encodeURIComponent(environment)}${suffix}`;
}
