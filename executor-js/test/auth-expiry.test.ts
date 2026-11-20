/**
 * A bearer token that dies after pages are stored. The checkpoint is still
 * a resume point, so the 401 is retryable and the next attempt, with a new
 * token, writes each id once. A 401 before any page is a bad credential and
 * stays terminal.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client as Filesystem } from "@puppi/adapter-filesystem";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { errorEvent, execute } from "../src/execute.js";
import type { ExecutorEvent, ExecutorInput } from "../src/protocol.js";
import { bundleCarryingStorage } from "./support/storage-adapters.js";

const httpEntry = resolve(dirname(fileURLToPath(import.meta.url)), "../../sdk/dist/index.js");

const ROWS = [0, 1, 2, 3, 4, 5].map((id) => ({ id, created: id + 1 }));
const PAGE = 2;

interface Api {
  url: string;
  close: () => Promise<void>;
}

const roots: string[] = [];
let api: Api;

beforeAll(async () => {
  api = await listen();
});

afterAll(async () => {
  await api.close();
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a 401 during a paginated append", () => {
  it("is retryable once a page is stored, and the new token resumes", async () => {
    const root = directory();
    const ref = "run.things__auth";
    const first = await attempt(root, ref, "alpha", null);

    expect(first.error?.message).toMatch(/401/);
    expect(first.checkpoint).not.toBeNull();
    expect(errorEvent(first.error).class).toBe("retryable");

    const second = await attempt(root, ref, "beta", first.checkpoint);

    expect(second.error).toBeUndefined();
    expect(await readIds(root, ref)).toEqual(ROWS.map((row) => row.id));
  });

  it("keeps a 403 terminal after a page is stored", async () => {
    const root = directory();
    const outcome = await attempt(root, "run.things__forbidden", "forbidden", null);

    expect(outcome.error?.message).toMatch(/403/);
    expect(outcome.checkpoint).not.toBeNull();
    expect(errorEvent(outcome.error).class).toBe("terminal");
  });

  it("stays terminal when the first page is refused", async () => {
    const root = directory();
    const outcome = await attempt(root, "run.things__dead", "dead", null);

    expect(outcome.error?.message).toMatch(/401/);
    expect(outcome.checkpoint).toBeNull();
    expect(errorEvent(outcome.error).class).toBe("terminal");
  });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "puppi-auth-"));
  roots.push(root);
  return root;
}

async function attempt(
  root: string,
  ref: string,
  token: string,
  checkpoint: Record<string, unknown> | null,
): Promise<{ error?: Error; checkpoint: Record<string, unknown> | null }> {
  const events: ExecutorEvent[] = [];
  const input: ExecutorInput = {
    bundle_ref: writeBundle(root, token),
    sdk_version: "0.2.0",
    asset_key: "source/things",
    partition: "",
    inputs: {},
    checkpoint,
    cursor_from: null,
    bindings: {
      lake: { type: "filesystem", config: { root }, secrets: {}, mode: "live" },
    },
    storage_connection: "lake",
    output_storage_ref: ref,
    connections: {},
  };

  try {
    await execute(input, (event) => {
      events.push(event);
    });
    return { checkpoint: lastCheckpoint(events) };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      checkpoint: lastCheckpoint(events),
    };
  }
}

function lastCheckpoint(events: ExecutorEvent[]): Record<string, unknown> | null {
  const found = events.filter((event) => event.event === "checkpoint");
  const last = found.at(-1);

  return last && last.event === "checkpoint" ? last.state : null;
}

async function readIds(root: string, ref: string): Promise<unknown[]> {
  const storage = new Filesystem({ root }, {});

  try {
    const rows = await storage.read(ref);

    return rows.map((row) => row["id"]);
  } finally {
    await storage.close();
  }
}

function writeBundle(root: string, token: string): string {
  const path = join(root, `bundle-${token}.mjs`);

  writeFileSync(path, bundleCarryingStorage(bundle(token)));
  return path;
}

function bundle(token: string): string {
  return `
    export default {
      assets: {
        "source/things": {
          key: "source/things",
          group: "default",
          visibility: "project",
          role: "source",
          producer: "ts",
          deps: [],
          connections: [],
          partitioning: {},
          checks: {},
          config: { mode: "append", cursor: "created" },
          run: async (ctx) => {
            const { OpenApiClient } = await import(${JSON.stringify(httpEntry)});
            const state = ctx.checkpointState ?? {};
            if (state.page === null) return;
            const cursor = typeof state.page === "string" ? state.page : null;

            class Client extends OpenApiClient {
              constructor() {
                super(
                  { base_url: ${JSON.stringify(api.url)} },
                  {},
                  {
                    api: "demo",
                    baseUrl: ${JSON.stringify(api.url)},
                    headers: { authorization: ${JSON.stringify(`Bearer ${token}`)} },
                  },
                  {
                    operations: {
                      listItems: { method: "get", path: "/items", query: ["cursor", "limit"] },
                    },
                  },
                );
              }

              items(page) {
                return this.pages(
                  "listItems",
                  { rows: "data", next: "next", param: "cursor" },
                  { query: { limit: ${PAGE} }, cursor: page },
                );
              }
            }

            const client = new Client();

            for await (const page of client.items(cursor)) {
              const created = page.data.at(-1)?.created;
              ctx.checkpoint({
                ...(created === undefined ? {} : { created }),
                page: page.cursor,
              });
              await ctx.emit(page.data);
            }
          },
        },
      },
      adapters: {},
    };
  `;
}

function listen(): Promise<Api> {
  const served = new Map<string, number>();
  const server = createServer((req, res) => {
    answer(req, res, served);
  });

  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        reject(new Error("auth fixture did not bind a port"));
        return;
      }

      resolveListen({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function answer(req: IncomingMessage, res: ServerResponse, served: Map<string, number>): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";

  const servedPages = served.get(token) ?? 0;
  const forbidden = token === "forbidden" && servedPages >= 2;

  if (token === "dead" || (token === "alpha" && servedPages >= 2) || forbidden) {
    send(res, forbidden ? 403 : 401, { error: forbidden ? "forbidden" : "token expired" });
    return;
  }

  served.set(token, (served.get(token) ?? 0) + 1);

  const start = Number(url.searchParams.get("cursor") ?? "0");
  const data = ROWS.slice(start, start + PAGE);
  const nextAt = start + data.length;

  send(res, 200, { data, next: nextAt < ROWS.length ? String(nextAt) : null });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
