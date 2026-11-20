/**
 * The engine command tests talk to.
 * One fetch stub, so each file does not reimplement the `/api/v1` prefix,
 * the route key, and the `{ data }` envelope.
 */

import { vi } from "vitest";

export interface EngineCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface EngineReply {
  status: number;
  body: unknown;
}

const DEPLOYED = {
  id: "d1",
  status: "ready",
  active: true,
  validation: { errors: [], warnings: [] },
};

function install(calls: EngineCall[], reply: (method: string, path: string) => EngineReply): void {
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = new URL(input);
    const path = url.pathname.replace("/api/v1", "") + url.search;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : (init?.body ?? undefined);

    calls.push({ method, path, headers: headersOf(init?.headers), body });

    const answer = reply(method, path);

    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
    });
  });
}

/** Route values are the `{ data }` payload. A missing route is 404. */
export function stubEngine(routes: Record<string, unknown>, calls: EngineCall[]): void {
  install(calls, (method, path) => {
    const route = routes[`${method} ${path}`];

    if (route === undefined) return { status: 404, body: { error: "not found" } };

    return { status: 200, body: { data: route } };
  });
}

/** Route values are a status and the raw JSON body. A missing route is 404. */
export function stubAnswers(routes: Record<string, EngineReply>, calls: EngineCall[]): void {
  install(
    calls,
    (method, path) => routes[`${method} ${path}`] ?? { status: 404, body: { error: "not found" } },
  );
}

/**
 * A deploy the engine accepts: the bundle is absent, the upload lands, and
 * the deployment comes back ready. `executor` is the answer to
 * `GET /environments/:name`, which is what decides the unsigned warning.
 */
export function stubDeploy(options?: {
  executor?: string;
  onDeployment?: (body: Record<string, unknown>) => void;
}): void {
  vi.stubGlobal("fetch", async (input: string | URL, request?: RequestInit) => {
    const method = request?.method ?? "GET";
    const url = new URL(input);

    if (options?.executor && method === "GET" && /\/environments\/[^/]+$/.test(url.pathname)) {
      return json(200, { data: { executor: options.executor } });
    }

    if (method === "HEAD" && url.pathname.startsWith("/api/v1/bundles/")) {
      return new Response(null, { status: 404 });
    }

    if (method === "PUT" && url.pathname.startsWith("/api/v1/bundles/")) {
      return new Response(null, { status: 201 });
    }

    if (method === "POST" && url.pathname.endsWith("/deployments")) {
      if (typeof request?.body === "string") {
        options?.onDeployment?.(JSON.parse(request.body) as Record<string, unknown>);
      }

      return json(201, { data: DEPLOYED });
    }

    return json(404, { error: "not found" });
  });
}

function headersOf(headers: RequestInit["headers"]): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}
