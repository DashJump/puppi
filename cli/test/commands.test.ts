/**
 * The commands over a fake engine: what they ask for, what they print, and
 * the exit code they carry. The verdict half matters most — a failed run, a
 * blocked dependent or a quarantined materialization has to be non-zero, or
 * these are not usable in CI without a JSON parser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Asset, Attempt, Materialization, Run } from "../src/api.js";
import { main } from "../src/index.js";
import { type EngineCall, stubEngine } from "./support/engine.js";

type Call = EngineCall;

let calls: Call[];
let stdout: string;
let stderr: string;

/** Every route the fake engine answers, keyed `METHOD /path`, plus what it returns. */
function engine(routes: Record<string, unknown>): void {
  stubEngine(routes, calls);
}

function run(...argv: string[]): Promise<number> {
  return main([...argv, "--engine-url", "http://engine:4000", "--env", "prod"]);
}

const materialization = (over: Partial<Materialization> = {}): Materialization => ({
  id: "11111111-1111-1111-1111-111111111111",
  partition: null,
  storage_ref: "s3://bucket/prod/core/customer",
  inputs: [],
  stats: { row_count: 42, bytes: 1024 },
  checks: [],
  quarantined: false,
  verified_at: null,
  created_at: "2026-09-18T10:00:00Z",
  ...over,
});

const asset = (over: Partial<Asset> = {}): Asset => ({
  key: "core/customer",
  definition: {
    role: "model",
    group: "default",
    visibility: "project",
    deps: ["stripe/customers"],
    connections: {},
    code_version: "abcdef0123456789",
    schedule: null,
    schema: null,
    config: {},
    checks: {},
  },
  latest: materialization(),
  next_run_at: null,
  staleness: [{ partition: "__all__", state: "current", reasons: [] }],
  ...over,
});

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: "a1",
  asset_key: "core/customer",
  partition: null,
  number: 1,
  status: "success",
  error_class: null,
  error_message: null,
  observed_reads: [],
  secret_versions: {},
  logs: [],
  timings: {},
  started_at: "2026-09-18T10:00:00Z",
  finished_at: "2026-09-18T10:00:02Z",
  ...over,
});

const settledRun = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  status: "success",
  plan: ["core/customer"],
  selection: [],
  trigger: { kind: "manual" },
  attempts: [attempt()],
  outcome: { "core/customer": "success" },
  started_at: "2026-09-18T10:00:00Z",
  finished_at: "2026-09-18T10:00:03Z",
  inserted_at: "2026-09-18T10:00:00Z",
  ...over,
});

beforeEach(() => {
  calls = [];
  stdout = "";
  stderr = "";
  delete process.env["PUPPI_SIGNING_KEY"];
  delete process.env["PUPPI_SIGNING_KEY_FILE"];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function line(message: string) {
  return { level: "info", message };
}

describe("puppi run", () => {
  it("triggers the run, prints how to follow it, and returns without polling", async () => {
    engine({
      "GET /environments/prod/assets": [asset()],
      "POST /environments/prod/runs": settledRun({ status: "queued", attempts: [] }),
      "GET /runs/r1": settledRun(),
    });

    expect(await run("run")).toBe(0);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /environments/prod/runs",
    ]);
    expect(stdout).toContain("run r1 queued");
    expect(stdout).toContain("puppi status --env prod --run r1");
  });

  it("returns the queued run under --json and does not poll", async () => {
    engine({
      "GET /environments/prod/assets": [asset()],
      "POST /environments/prod/runs": settledRun({ status: "queued", attempts: [] }),
      "GET /runs/r1": settledRun(),
    });

    expect(await run("run", "--json")).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["POST"]);

    const parsed = JSON.parse(stdout) as { waited: boolean; run: { id: string; status: string } };

    expect(parsed.waited).toBe(false);
    expect(parsed.run).toMatchObject({ id: "r1", status: "queued" });
  });

  it("does not report a run that is still going past the wait limit as a failure", async () => {
    vi.useFakeTimers();
    engine({
      "GET /environments/prod/assets": [asset()],
      "POST /environments/prod/runs": settledRun({ status: "running", attempts: [] }),
      "GET /runs/r1": settledRun({
        status: "running",
        finished_at: null,
        attempts: [attempt({ status: "running", finished_at: null })],
      }),
    });

    const pending = run("run");

    await vi.advanceTimersByTimeAsync(16 * 60_000);

    expect(stderr).not.toContain("still running after");
    expect(await pending).toBe(0);
    expect(stdout).toContain("puppi status --env prod --run r1");
  });

  it("says the run is still going when --wait is given a deadline that passes", async () => {
    vi.useFakeTimers();
    engine({
      "GET /environments/prod/assets": [asset()],
      "POST /environments/prod/runs": settledRun({ status: "running", attempts: [] }),
      "GET /runs/r1": settledRun({
        status: "running",
        finished_at: null,
        attempts: [attempt({ status: "running", finished_at: null })],
      }),
    });

    const pending = run("run", "--wait", "--timeout", "1");

    await vi.advanceTimersByTimeAsync(16 * 60_000);

    // 1 is the run-failed code. A live run that outlasted the deadline is not that.
    expect(stderr).not.toContain("still running after");
    expect(await pending).toBe(3);
    expect(stdout).toContain("still running");
    expect(stdout).toContain("puppi status --env prod --run r1");
  });

  it("prints attempt transitions while --wait polls", async () => {
    vi.useFakeTimers();

    const queued = settledRun({
      status: "queued",
      started_at: null,
      finished_at: null,
      attempts: [],
    });
    const running = settledRun({
      status: "running",
      finished_at: null,
      attempts: [attempt({ status: "running", finished_at: null })],
    });
    const retrying = settledRun({
      status: "running",
      finished_at: null,
      attempts: [
        attempt({
          status: "failed",
          error_class: "retryable",
          error_message: "executor exited 134",
          finished_at: "2026-09-18T10:00:01Z",
        }),
        attempt({
          id: "a2",
          number: 2,
          status: "running",
          started_at: "2026-09-18T10:00:01Z",
          finished_at: null,
        }),
      ],
    });
    const settled = settledRun({
      attempts: [
        attempt({
          status: "failed",
          error_class: "retryable",
          error_message: "executor exited 134",
          finished_at: "2026-09-18T10:00:01Z",
        }),
        attempt({
          id: "a2",
          number: 2,
          status: "success",
          started_at: "2026-09-18T10:00:01Z",
          finished_at: "2026-09-18T10:00:03Z",
        }),
      ],
    });
    const polls = [running, retrying, settled];
    let index = 0;

    engine({
      "GET /environments/prod/assets": [asset()],
      "POST /environments/prod/runs": queued,
      get "GET /runs/r1"() {
        const next = Math.min(index, polls.length - 1);

        index += 1;

        return polls[next];
      },
    });

    const pending = run("run", "--wait");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toBe(0);
    expect(stdout).toContain("run r1 queued -> running");
    expect(stdout).toContain("starting core/customer #1");
    expect(stdout).toContain("retrying core/customer #2");
    expect(stdout).toContain("executor exited 134");
    expect(stdout).toContain("core/customer #2 success in 2.0s");
    expect(stdout).toContain("42");
  });

  it("prints each new ctx.log line once while --wait polls", async () => {
    vi.useFakeTimers();

    const running = (logs: { level: string; message: string }[]) =>
      settledRun({
        status: "running",
        finished_at: null,
        attempts: [attempt({ status: "running", finished_at: null, logs })],
      });
    const polls = [
      running([line("downloading")]),
      running([line("downloading")]),
      running([line("downloading"), line("300 MB")]),
      settledRun({ attempts: [attempt({ logs: [line("downloading"), line("300 MB")] })] }),
    ];
    let index = 0;

    engine({
      "GET /environments/prod/assets": [asset()],
      "POST /environments/prod/runs": settledRun({ status: "queued", attempts: [] }),
      get "GET /runs/r1"() {
        return polls[Math.min(index++, polls.length - 1)];
      },
    });

    const pending = run("run", "--wait");

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toBe(0);
    expect(stdout.match(/core\/customer #1 info  downloading/g)).toHaveLength(1);
    expect(stdout.match(/core\/customer #1 info  300 MB/g)).toHaveLength(1);
  });

  it("strips ANSI and OSC from a ctx.log line while --wait polls", async () => {
    vi.useFakeTimers();

    const nasty = "\u001b[31mdownloading\u001b[0m\u001b]0;owned\u0007";
    const polls = [
      settledRun({
        status: "running",
        finished_at: null,
        attempts: [attempt({ status: "running", finished_at: null, logs: [line(nasty)] })],
      }),
      settledRun({ attempts: [attempt({ logs: [line(nasty)] })] }),
    ];
    let index = 0;

    engine({
      "GET /environments/prod/assets": [asset()],
      "POST /environments/prod/runs": settledRun({ status: "queued", attempts: [] }),
      get "GET /runs/r1"() {
        return polls[Math.min(index++, polls.length - 1)];
      },
    });

    const pending = run("run", "--wait");

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toBe(0);
    expect(stdout).toContain("downloading");
    expect(stdout).not.toContain("\u001b");
    expect(stdout).not.toContain("owned");
  });

  it("strips other control characters from a ctx.log line while --wait polls", async () => {
    vi.useFakeTimers();

    const nasty = "down\tload\ring\bing\u001bc\u001b]0;owned\u000b\u009c";
    const polls = [
      settledRun({
        status: "running",
        finished_at: null,
        attempts: [attempt({ status: "running", finished_at: null, logs: [line(nasty)] })],
      }),
      settledRun({ attempts: [attempt({ logs: [line(nasty)] })] }),
    ];
    let index = 0;

    engine({
      "GET /environments/prod/assets": [asset()],
      "POST /environments/prod/runs": settledRun({ status: "queued", attempts: [] }),
      get "GET /runs/r1"() {
        return polls[Math.min(index++, polls.length - 1)];
      },
    });

    const pending = run("run", "--wait");

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await pending).toBe(0);
    expect(stdout).toContain("down\tloading");
    expect(stdout).not.toContain("\r");
    expect(stdout).not.toContain("\b");
    expect(stdout).not.toContain("\u001b");
    expect(stdout).not.toContain("\u000b");
    expect(stdout).not.toContain("\u009c");
  });

  it("prints the still-running run as JSON when --wait --timeout expires", async () => {
    vi.useFakeTimers();
    engine({
      "GET /environments/prod/assets": [asset()],
      "POST /environments/prod/runs": settledRun({ status: "running", attempts: [] }),
      "GET /runs/r1": settledRun({
        status: "running",
        finished_at: null,
        attempts: [attempt({ status: "running", finished_at: null })],
      }),
    });

    const pending = run("run", "--wait", "--timeout", "1", "--json");

    await vi.advanceTimersByTimeAsync(16 * 60_000);

    expect(await pending).toBe(3);

    const parsed = JSON.parse(stdout) as {
      timedOut: boolean;
      follow: string;
      run: { status: string };
      message: string;
    };

    expect(parsed.timedOut).toBe(true);
    expect(parsed.run.status).toBe("running");
    expect(parsed.follow).toBe("puppi status --env prod --run r1");
    expect(parsed.message).toContain("still running");
    expect(stderr).not.toContain("still running after");
  });

  it("triggers, waits for the run to settle, and shows one row per asset", async () => {
    engine({
      "GET /environments/prod/assets": [asset({ latest: null })],
      "POST /environments/prod/runs": settledRun({ status: "running" }),
      "GET /runs/r1": settledRun(),
    });

    expect(await run("run", "--wait")).toBe(0);

    const triggered = calls.find((call) => call.method === "POST");
    expect(triggered?.body).toEqual({});

    expect(stdout).toContain("core/customer");
    expect(stdout).toContain("success");
    expect(stdout).toContain("run r1 success in 3.0s");
  });

  it("says `new` when latest moved and `kept` when it did not", async () => {
    const before = asset({ latest: materialization({ id: "old" }) });

    let served = 0;
    engine({
      get "GET /environments/prod/assets"() {
        // The first read is the one taken before the trigger.
        return [served++ === 0 ? before : asset()];
      },
      "POST /environments/prod/runs": settledRun({ status: "running" }),
      "GET /runs/r1": settledRun(),
    });

    await run("run", "--wait");

    expect(stdout).toContain("new ");
  });

  it("rejects --no-wait and names --wait", async () => {
    engine({});

    expect(await run("run", "--no-wait")).toBe(2);
    expect(stderr).toContain("--wait");
    expect(calls).toEqual([]);
  });

  it("rejects --local and names puppi try", async () => {
    engine({});

    expect(await run("run", "--local")).toBe(2);
    expect(stderr).toContain("puppi try");
    expect(calls).toEqual([]);
  });

  it("posts the run to the default environment when --env and PUPPI_ENV are omitted", async () => {
    delete process.env["PUPPI_ENV"];
    engine({
      "POST /environments/default/runs": settledRun({ status: "running" }),
    });

    expect(await main(["run", "--engine-url", "http://engine:4000"])).toBe(0);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /environments/default/runs",
    ]);
  });

  it("pluralizes a plan of more than one asset", async () => {
    engine({
      "POST /environments/prod/runs": settledRun({
        status: "running",
        plan: ["core/customer", "raw/alpha"],
      }),
    });

    expect(await run("run")).toBe(0);
    expect(stdout).toContain("2 assets in plan");
    expect(stdout).not.toContain("1 assets");
  });

  it("rejects user-facing asset and graph selectors", async () => {
    engine({});

    expect(await run("run", "core/customer", "--upstream")).toBe(2);
    expect(stderr).toContain("whole active graph");
    expect(stderr).toContain("Engine runs cannot target one asset yet.");
    expect(calls).toEqual([]);
  });

  it("suggests the command when the extra word is one", async () => {
    engine({});

    expect(await run("run", "build")).toBe(2);
    expect(stderr).toContain("did you mean `puppi build`?");
    expect(stderr).toContain("Engine runs cannot target one asset yet.");
    expect(calls).toEqual([]);
  });

  it("exits 1 on a failed run, a blocked dependent, and a quarantined latest", async () => {
    const failed = settledRun({
      status: "failed",
      plan: ["core/customer", "warehouse/customer"],
      attempts: [
        attempt({ status: "failed_by_check", error_message: "schema_contract: missing column" }),
        attempt({ id: "a2", asset_key: "warehouse/customer", status: "blocked" }),
      ],
      outcome: { "core/customer": "failed_by_check", "warehouse/customer": "blocked" },
    });

    engine({
      "GET /environments/prod/assets": [asset({ latest: materialization({ quarantined: true }) })],
      "POST /environments/prod/runs": failed,
      "GET /runs/r1": failed,
    });

    expect(await run("run", "--wait")).toBe(1);
    expect(stdout).toContain("blocked by an upstream: warehouse/customer");
    expect(stdout).toContain("quarantined, so `latest` did not move: core/customer");
    expect(stdout).toContain("schema_contract: missing column");
  });

  it("prints the result under --json", async () => {
    engine({
      "GET /environments/prod/assets": [asset()],
      "POST /environments/prod/runs": settledRun({ status: "running" }),
      "GET /runs/r1": settledRun(),
    });

    await run("run", "--wait", "--json");

    expect(JSON.parse(stdout)).toEqual({
      run: settledRun(),
      before: [asset()],
      after: [asset()],
      waited: true,
    });
  });
});

describe("puppi status", () => {
  it("reads the newest run back in full", async () => {
    engine({
      "GET /environments/prod/runs": [settledRun()],
      "GET /runs/r1": settledRun(),
      "GET /environments/prod/assets": [asset()],
    });

    expect(await run("status")).toBe(0);
    expect(stdout).toContain("run r1 success");
  });

  it("prints the trigger time with its zone, and --json keeps the full value", async () => {
    const insertedAt = "2026-10-19T18:30:00.654321+02:00";

    engine({
      "GET /environments/prod/runs": [settledRun({ inserted_at: insertedAt })],
      "GET /runs/r1": settledRun({ inserted_at: insertedAt }),
      "GET /environments/prod/assets": [asset()],
    });

    expect(await run("status")).toBe(0);
    expect(stdout).toContain("triggered 2026-10-19T18:30:00+02:00 ");
    expect(stdout).not.toContain(insertedAt);

    stdout = "";
    expect(await run("status", "--json")).toBe(0);
    expect((JSON.parse(stdout) as { run: { inserted_at: string } }).run.inserted_at).toBe(
      insertedAt,
    );
  });

  it("says so, and exits 0, when the environment has never run", async () => {
    engine({ "GET /environments/prod/runs": [] });

    expect(await run("status")).toBe(0);
    expect(stdout).toContain("has no runs yet");
  });

  it("reads the default environment when --env and PUPPI_ENV are omitted", async () => {
    delete process.env["PUPPI_ENV"];
    engine({ "GET /environments/default/runs": [] });

    expect(await main(["status", "--engine-url", "http://engine:4000"])).toBe(0);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /environments/default/runs",
    ]);
    expect(stdout).toContain("default has no runs yet");
  });
});

describe("puppi deployments", () => {
  const deployment = {
    id: "d1",
    status: "ready",
    active: true,
    git: { branch: "main", sha: "abcdef0123456789" },
    inserted_at: "2026-10-16T00:00:00Z",
  };

  it("lists this environment's deployments and marks the active one", async () => {
    engine({
      "GET /environments/prod/deployments": [
        deployment,
        {
          ...deployment,
          id: "d0",
          active: false,
          git: { branch: "main", sha: "1111111111111111" },
        },
      ],
    });

    expect(await run("deployments")).toBe(0);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /environments/prod/deployments",
    ]);
    expect(stdout).toContain("d1");
    expect(stdout).toContain("d0");
    expect(stdout).toContain("active");
  });

  it("says when the environment has no deployments", async () => {
    engine({ "GET /environments/prod/deployments": [] });

    expect(await run("deployments")).toBe(0);
    expect(stdout).toContain("no deployments");
  });
});

describe("puppi activate", () => {
  it("makes the named deployment active", async () => {
    engine({
      "POST /deployments/d0/activate": {
        id: "d0",
        status: "ready",
        active: true,
        git: { branch: "main", sha: "abcdef0123456789" },
        inserted_at: "2026-10-16T00:00:00Z",
      },
    });

    expect(await run("activate", "d0")).toBe(0);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /deployments/d0/activate",
    ]);
    expect(stdout).toContain("activated d0");
  });
});

describe("puppi assets", () => {
  it("shows staleness reasons beside each asset", async () => {
    engine({
      "GET /environments/prod/assets": [
        asset({
          staleness: [
            {
              partition: "__all__",
              state: "stale",
              reasons: [{ reason: "upstream_changed", dep: "stripe/customers" }],
            },
          ],
        }),
      ],
    });

    expect(await run("assets")).toBe(0);
    expect(stdout).toContain("stale");
    expect(stdout).toContain("upstream_changed");
  });

  it("takes an asset key, whose slashes stay path segments, and shows its history", async () => {
    engine({
      "GET /environments/prod/assets/core/customer": asset({
        history: [materialization(), materialization({ id: "22222222", quarantined: true })],
      }),
    });

    expect(await run("assets", "core/customer")).toBe(0);
    expect(calls[0]?.path).toBe("/environments/prod/assets/core/customer");
    expect(stdout).toContain("quarantined");
  });

  it("prints the next run in UTC, with the zone", async () => {
    engine({
      "GET /environments/prod/assets": [asset({ next_run_at: "2026-10-19T23:00:00.000000Z" })],
    });

    expect(await run("assets")).toBe(0);
    expect(stdout).toContain("2026-10-19T23:00:00Z");
    expect(stdout).not.toMatch(/2026-10-19T23:00:00(?!Z)/);
  });

  it("keeps the zone on one asset", async () => {
    engine({
      "GET /environments/prod/assets/core/customer": asset({
        next_run_at: "2026-10-19T23:00:00Z",
      }),
    });

    expect(await run("assets", "core/customer")).toBe(0);
    expect(stdout).toContain("next run     2026-10-19T23:00:00Z");
  });

  it("prints a materialization's created time with its zone, and --json keeps the full value", async () => {
    const createdAt = "2026-10-19T18:30:00.654321+02:00";

    engine({
      "GET /environments/prod/assets/core/customer": asset({
        history: [
          materialization({ created_at: createdAt }),
          materialization({ id: "22222222", created_at: "2026-09-18T10:00:00" }),
        ],
      }),
    });

    expect(await run("assets", "core/customer")).toBe(0);
    expect(stdout).toContain("2026-10-19T18:30:00+02:00");
    expect(stdout).toContain("2026-09-18T10:00:00Z");
    expect(stdout).not.toMatch(/2026-09-18T10:00:00(?!Z)/);
    expect(stdout).not.toContain(createdAt);

    stdout = "";
    expect(await run("assets", "core/customer", "--json")).toBe(0);

    const printed = JSON.parse(stdout) as { history: { created_at: string }[] };

    expect(printed.history.map((row) => row.created_at)).toEqual([
      createdAt,
      "2026-09-18T10:00:00",
    ]);
  });

  it("says when nothing is deployed", async () => {
    engine({
      "GET /environments/prod/assets": [],
      "GET /environments/prod": {
        id: "e1",
        name: "prod",
        kind: "persistent",
        storage_prefix: "prod",
        strict: false,
        schedules_paused: false,
        executor: "local",
        active_deployment_id: null,
        inserted_at: "2026-09-18T09:00:00Z",
      },
    });

    expect(await run("assets")).toBe(0);
    expect(stdout).toContain("No active deployment in prod. Run `puppi deploy`.");
  });

  it("does not invent a missing deployment when the active one has no assets", async () => {
    engine({
      "GET /environments/prod/assets": [],
      "GET /environments/prod": {
        id: "e1",
        name: "prod",
        kind: "persistent",
        storage_prefix: "prod",
        strict: false,
        schedules_paused: false,
        executor: "local",
        active_deployment_id: "d1",
        inserted_at: "2026-09-18T09:00:00Z",
      },
    });

    expect(await run("assets")).toBe(0);
    expect(stdout).not.toContain("No active deployment");
  });
});

describe("puppi logs", () => {
  it("turns the attempt's timings into a per-step timeline", async () => {
    engine({
      "GET /runs/r1": settledRun({
        attempts: [
          attempt({
            timings: {
              gated_at: "2026-09-18T10:00:00.500Z",
              inputs_resolved_at: "2026-09-18T10:00:01Z",
              executor_started_at: "2026-09-18T10:00:01.200Z",
              producer_done_at: "2026-09-18T10:00:01.900Z",
              checks_done_at: "2026-09-18T10:00:02Z",
            },
            logs: [{ level: "info", message: "polled at 10:00, 42 rows" }],
          }),
        ],
      }),
    });

    expect(await run("logs", "r1")).toBe(0);
    expect(stdout).toContain("produce");
    expect(stdout).toContain("0.7s");
    expect(stdout).toContain("polled at 10:00, 42 rows");
  });

  it("prints a withheld line as kept on the worker", async () => {
    engine({
      "GET /runs/r1": settledRun({
        attempts: [
          attempt({
            logs: [
              {
                level: "info",
                time: "2026-10-16T12:00:00Z",
                withheld: ["message"],
                worker_id: "droplet-1",
              },
            ],
          }),
        ],
      }),
    });

    expect(await run("logs", "r1")).toBe(0);
    expect(stdout).toContain("info  kept on worker droplet-1");
  });

  it("is a usage error without a run id", async () => {
    engine({});

    expect(await run("logs")).toBe(2);
    expect(stderr).toContain("needs a run id");
  });
});

describe("puppi lineage", () => {
  it("walks materialization ids upward, not asset names", async () => {
    engine({
      "GET /environments/prod/assets/core/customer": asset(),
      "GET /materializations/11111111-1111-1111-1111-111111111111": materialization({
        inputs_of: [{ materialization_id: "upstream-1", asset_key: "stripe/customers" }],
      }),
      "GET /materializations/upstream-1": materialization({ id: "upstream-1" }),
    });

    expect(await run("lineage", "core/customer")).toBe(0);
    expect(stdout).toContain("core/customer");
    expect(stdout).toContain("stripe/customers");
    expect(stdout).toContain("└");
  });

  it("prints each created time with its zone, and --json keeps the full value", async () => {
    const createdAt = "2026-10-19T18:30:00.654321+02:00";

    engine({
      "GET /environments/prod/assets/core/customer": asset(),
      "GET /materializations/11111111-1111-1111-1111-111111111111": materialization({
        created_at: createdAt,
        inputs_of: [{ materialization_id: "upstream-1", asset_key: "stripe/customers" }],
      }),
      "GET /materializations/upstream-1": materialization({
        id: "upstream-1",
        created_at: "2026-09-18T10:00:00",
      }),
    });

    expect(await run("lineage", "core/customer")).toBe(0);
    expect(stdout).toContain("2026-10-19T18:30:00+02:00");
    expect(stdout).toContain("2026-09-18T10:00:00Z");
    expect(stdout).not.toMatch(/2026-09-18T10:00:00(?!Z)/);
    expect(stdout).not.toContain(createdAt);

    stdout = "";
    expect(await run("lineage", "core/customer", "--json")).toBe(0);

    const printed = JSON.parse(stdout) as { created_at: string; inputs: { created_at: string }[] };

    expect(printed.created_at).toBe(createdAt);
    expect(printed.inputs[0]?.created_at).toBe("2026-09-18T10:00:00");
  });
});

describe("puppi rollback", () => {
  it("falls back to the previous usable materialization when --to is not given", async () => {
    engine({
      "GET /environments/prod/assets/core/customer": asset({
        history: [
          materialization({ id: "newest" }),
          materialization({ id: "quarantined-one", quarantined: true }),
          materialization({ id: "previous" }),
        ],
      }),
      "POST /environments/prod/rollbacks": {
        rolled_back: { asset_key: "core/customer", materialization_id: "previous" },
        repointed: [],
        rebuilding: [],
        unchanged: [],
        run_id: null,
      },
    });

    expect(await run("rollback", "core/customer")).toBe(0);
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      asset_key: "core/customer",
      materialization_id: "previous",
    });
  });

  it("refuses, non-zero, when nothing behind the current one still has its data", async () => {
    engine({
      "GET /environments/prod/assets/core/customer": asset({
        history: [
          materialization({ id: "newest", retained: true }),
          materialization({ id: "quarantined-one", quarantined: true, retained: true }),
          materialization({ id: "dropped", retained: false }),
        ],
      }),
    });

    expect(await run("rollback", "core/customer")).toBe(1);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("refuses, non-zero, when there is nothing behind the current materialization", async () => {
    engine({
      "GET /environments/prod/assets/core/customer": asset({ history: [materialization()] }),
    });

    expect(await run("rollback", "core/customer")).toBe(1);
    expect(stdout).toContain("nothing to roll back to");
  });

  it("waits for the re-delivery run under --json and does not print the human note", async () => {
    engine({
      "GET /environments/prod/assets/core/customer": asset({
        history: [materialization(), materialization({ id: "previous" })],
      }),
      "POST /environments/prod/rollbacks": {
        rolled_back: { asset_key: "core/customer", materialization_id: "previous" },
        repointed: [],
        rebuilding: [],
        unchanged: [],
        run_id: "r1",
      },
      "GET /runs/r1": settledRun({ status: "failed" }),
      "GET /environments/prod/assets": [asset()],
    });

    expect(await run("rollback", "core/customer", "--json")).toBe(1);

    const printed = JSON.parse(stdout) as { run: { id: string }; run_id: string };

    expect(printed.run_id).toBe("r1");
    expect(printed.run.id).toBe("r1");
    expect(stdout).not.toContain("latest is");
    expect(stderr).not.toContain("latest is");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain("GET /runs/r1");
  });
});

describe("puppi env", () => {
  it("creates an environment as hosted when --executor is omitted", async () => {
    engine({
      "GET /environments": [],
      "POST /environments": {
        id: "e1",
        name: "prod",
        kind: "persistent",
        storage_prefix: "prod",
        strict: false,
        schedules_paused: false,
        executor: "hosted",
        active_deployment_id: null,
        inserted_at: "2026-09-18T09:00:00Z",
      },
    });

    expect(await run("env", "create", "prod")).toBe(0);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /environments",
      "POST /environments",
    ]);
    expect(calls[1]?.body).toMatchObject({ name: "prod", executor: "hosted" });
    expect(stdout).toContain("environment prod created");
    expect(stderr).not.toContain("unsigned");
    expect(stderr).not.toContain("NOT SIGNED");
    expect(stderr).not.toContain("signing");
  });

  it("reports a missing name without asking for an executor", async () => {
    engine({});

    expect(await main(["env", "create", "--engine-url", "http://engine:4000"])).toBe(2);
    expect(stderr).toContain("needs a name");
    expect(stderr).toContain("puppi env create prod");
    expect(stderr).not.toContain("--executor");
    expect(calls).toEqual([]);
  });

  it("refuses an executor that is not hosted or remote, including local", async () => {
    engine({ "GET /environments": [] });

    expect(await run("env", "create", "prod", "--executor", "banana")).toBe(2);
    expect(stderr).toContain("--executor hosted|remote");
    expect(stderr).toContain("puppi env create prod");
    expect(stderr).not.toContain("puppi env create prod --executor");
    expect(calls).toEqual([]);

    stderr = "";
    expect(await run("env", "create", "prod", "--executor", "local")).toBe(2);
    expect(stderr).toContain("--executor hosted|remote");
    expect(calls).toEqual([]);

    stdout = "";
    expect(await main(["env", "--help"])).toBe(0);
    expect(stdout).toContain("[--executor hosted|remote]");
    expect(stdout).toContain("hosted when omitted");
    expect(stdout).not.toContain("local|remote|hosted");
  });

  it("places the tenant and lists the environments it restamped", async () => {
    engine({
      "POST /placement": { executor: "remote", environments: [{ name: "prod" }, { name: "dev" }] },
    });

    expect(await main(["place", "remote", "--engine-url", "http://engine:4000"])).toBe(0);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/placement",
      body: { executor: "remote" },
    });
    expect(stdout).toContain("remote: prod, dev");
  });

  it("places the tenant on hosted and sends no pool", async () => {
    engine({
      "POST /placement": { executor: "hosted", environments: [{ name: "prod" }] },
    });

    expect(await main(["place", "hosted", "--engine-url", "http://engine:4000"])).toBe(0);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/placement",
      body: { executor: "hosted" },
    });
    expect(calls[0]?.body).toEqual({ executor: "hosted" });
    expect(stdout).toContain("hosted: prod");
  });

  it("refuses a place mode that is not hosted or remote, including local", async () => {
    engine({});

    expect(await main(["place", "--engine-url", "http://engine:4000"])).toBe(2);
    expect(stderr).toContain("needs hosted, remote");
    expect(stderr).toContain("puppi place hosted");
    expect(calls).toEqual([]);

    stderr = "";
    expect(await main(["place", "local", "--engine-url", "http://engine:4000"])).toBe(2);
    expect(stderr).toContain("needs hosted, remote");
    expect(calls).toEqual([]);

    stderr = "";
    expect(await main(["place", "banana", "--engine-url", "http://engine:4000"])).toBe(2);
    expect(stderr).toContain("needs hosted, remote");
    expect(calls).toEqual([]);

    stdout = "";
    expect(await main(["place", "--help"])).toBe(0);
    expect(stdout).toContain("puppi place <hosted|remote>");
    expect(stdout).not.toContain("local|remote|hosted");
    expect(calls).toEqual([]);
  });

  it("creates an environment, and is a no-op when it already exists", async () => {
    const existing = {
      id: "e1",
      name: "prod",
      kind: "persistent",
      storage_prefix: "prod",
      strict: false,
      schedules_paused: false,
      executor: "local" as const,
      active_deployment_id: null,
      inserted_at: "2026-09-18T09:00:00Z",
    };

    engine({ "GET /environments": [existing] });

    expect(await run("env", "create", "prod")).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(stdout).toContain("already exists");
  });

  it("updates an existing environment when --executor differs", async () => {
    const existing = {
      id: "e1",
      name: "prod",
      kind: "persistent",
      storage_prefix: "prod",
      strict: false,
      schedules_paused: false,
      executor: "local" as const,
      active_deployment_id: null,
      inserted_at: "2026-09-18T09:00:00Z",
    };

    engine({
      "GET /environments": [existing],
      "POST /environments/prod/placement": { ...existing, executor: "remote" },
    });

    expect(await run("env", "create", "prod", "--executor", "remote")).toBe(0);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /environments",
      "POST /environments/prod/placement",
    ]);
    expect(calls[1]?.body).toEqual({ executor: "remote" });
    expect(stdout).toContain("updated to remote");
  });

  it("leaves an existing environment alone when --executor already matches", async () => {
    const existing = {
      id: "e1",
      name: "prod",
      kind: "persistent",
      storage_prefix: "prod",
      strict: false,
      schedules_paused: false,
      executor: "remote" as const,
      active_deployment_id: null,
      inserted_at: "2026-09-18T09:00:00Z",
    };

    engine({ "GET /environments": [existing] });

    expect(await run("env", "create", "prod", "--executor", "remote")).toBe(0);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
    expect(stdout).toContain("already exists");
  });

  it("binds a connection with its config and secret refs", async () => {
    engine({
      "GET /environments/prod/bindings": [],
      "PUT /environments/prod/bindings/warehouse": {
        name: "warehouse",
        config: { host: "127.0.0.1" },
        secret_refs: { password: "pg_password" },
        mode: "live",
        updated_at: "2026-09-18T09:00:00Z",
      },
    });

    expect(
      await run(
        "env",
        "bind",
        "warehouse",
        "--config",
        '{"host":"127.0.0.1"}',
        "--secret-ref",
        "password=pg_password",
      ),
    ).toBe(0);

    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      config: { host: "127.0.0.1" },
      secret_refs: { password: "pg_password" },
      mode: "live",
    });
  });

  it("reads a secret's value from the environment, and prints the version rather than the value", async () => {
    engine({
      "PUT /environments/prod/secrets/pg_password": {
        name: "pg_password",
        backend: "database",
        version: 3,
        rotated_at: null,
      },
    });

    process.env["TEST_PG_PASSWORD"] = "hunter2";

    try {
      expect(await run("env", "secret", "pg_password", "--from-env", "TEST_PG_PASSWORD")).toBe(0);
    } finally {
      delete process.env["TEST_PG_PASSWORD"];
    }

    expect(calls[0]?.body).toEqual({ value: "hunter2" });
    expect(stdout).toContain("version 3");
    expect(stdout).not.toContain("hunter2");
  });

  it("is a usage error when neither --value nor --from-env is given", async () => {
    engine({});

    expect(await run("env", "secret", "pg_password")).toBe(2);
    expect(stderr).toContain("--value <value>, --from-env <VAR>, --on-worker, or --forget");
  });

  it("refuses an empty value from --from-env", async () => {
    engine({});
    process.env["TEST_PG_PASSWORD"] = "   ";

    try {
      expect(await run("env", "secret", "pg_password", "--from-env", "TEST_PG_PASSWORD")).toBe(2);
    } finally {
      delete process.env["TEST_PG_PASSWORD"];
    }

    expect(stderr).toContain("TEST_PG_PASSWORD is empty");
    expect(calls).toEqual([]);
  });

  it("refuses an unset --from-env variable", async () => {
    engine({});
    delete process.env["TEST_PG_PASSWORD_MISSING"];

    expect(
      await run("env", "secret", "pg_password", "--from-env", "TEST_PG_PASSWORD_MISSING"),
    ).toBe(2);
    expect(stderr).toContain("TEST_PG_PASSWORD_MISSING is not set");
    expect(calls).toEqual([]);
  });

  it("prints the engine URL and what a local secret backend means", async () => {
    engine({
      "GET /environments/prod": {
        id: "e1",
        name: "prod",
        kind: "persistent",
        storage_prefix: "prod",
        strict: false,
        schedules_paused: false,
        executor: "local",
        active_deployment_id: null,
        inserted_at: "2026-09-18T09:00:00Z",
      },
      "GET /environments/prod/bindings": [],
      "GET /environments/prod/secrets": [
        { name: "pg_password", backend: "local", version: 1, rotated_at: null },
      ],
    });

    expect(await run("env", "show")).toBe(0);
    expect(stdout).toContain("engine http://engine:4000");
    expect(stdout).toContain(
      "local: this engine stores AES-256-GCM ciphertext. The key is engine-managed; in prod, PUPPI_SECRET_KEY sets it. The value is write-only.",
    );
  });

  it("removes a binding and a secret, and pauses schedules", async () => {
    engine({
      "DELETE /environments/prod/bindings/scratch": { name: "scratch" },
      "DELETE /environments/prod/secrets/drill_note": { name: "drill_note" },
      "POST /environments/prod/schedules/pause": {
        name: "prod",
        kind: "persistent",
        storage_prefix: "prod",
        strict: false,
        schedules_paused: true,
        active_deployment_id: null,
        inserted_at: "2026-09-18T09:00:00Z",
      },
    });

    expect(await run("env", "unbind", "scratch")).toBe(0);
    expect(await run("env", "secret", "drill_note", "--forget")).toBe(0);
    expect(await run("env", "pause")).toBe(0);

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /environments/prod/bindings/scratch",
      "DELETE /environments/prod/secrets/drill_note",
      "POST /environments/prod/schedules/pause",
    ]);
    expect(stdout).toContain("unbound scratch");
    expect(stdout).toContain("secret drill_note removed");
    expect(stdout).toContain("schedules paused");
  });
});

describe("puppi, generally", () => {
  it("needs an environment for everything but build, help and `env list`", async () => {
    engine({});

    expect(await main(["assets"])).toBe(2);
    expect(stderr).toContain("--env <name> or PUPPI_ENV");
  });

  it("turns an engine refusal into one line and exit 1, not a stack trace", async () => {
    engine({});

    expect(await run("assets")).toBe(1);
    expect(stderr).toContain("engine answered 404 not found");
  });

  it("lists its commands, and refuses one it does not have", async () => {
    engine({});

    expect(await main(["help"])).toBe(0);
    expect(stdout).toContain("puppi rollback");

    expect(await main(["banana"])).toBe(2);
    expect(stderr).toContain('no command "banana"');
  });

  it("prints help before it asks for an environment", async () => {
    engine({});

    expect(await main(["assets", "--help"])).toBe(0);
    expect(stdout).toContain("puppi assets");
    expect(stderr).toBe("");
    expect(calls).toEqual([]);

    stdout = "";
    expect(await main(["env", "bind", "--help"])).toBe(0);
    expect(stdout).toContain("puppi env bind");
    expect(calls).toEqual([]);
  });

  it("suggests a command and a flag the user almost typed", async () => {
    engine({});

    expect(await main(["buid"])).toBe(2);
    expect(stderr).toContain("did you mean `puppi build`?");

    stderr = "";
    expect(await main(["assets", "--engin-url", "http://engine:4000"])).toBe(2);
    expect(stderr).toContain("did you mean `--engine-url`?");
    expect(calls).toEqual([]);

    stderr = "";
    expect(await main(["env", "crate", "--engine-url", "http://engine:4000"])).toBe(2);
    expect(stderr).toContain("did you mean `puppi env create`?");

    stderr = "";
    expect(await main(["worker", "stat", "--engine-url", "http://engine:4000"])).toBe(2);
    expect(stderr).toContain("did you mean `puppi worker start`?");

    stderr = "";
    expect(await main(["build", "--force"])).toBe(2);
    expect(stderr).toContain("unknown flag --force");
  });
});
