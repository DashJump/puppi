import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it, vi } from "vitest";

import * as connector from "../src/index.js";
import { Client } from "../src/index.js";
import { operations } from "../src/operations.js";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, object> };
  paths: Record<
    string,
    { get: { responses: Record<string, { content: { "application/json": { schema: object } } }> } }
  >;
};

/** A response body from the pinned schema, with the fields this case cares about. */
function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

const currencies =
  spec.paths["/currencies"]!.get.responses["200"]!.content["application/json"].schema;

function fake(payload: unknown, status = 200) {
  const urls: URL[] = [];

  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(new URL(input instanceof Request ? input.url : String(input)));
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;

  return {
    urls,
    client: new Client({ base_url: "https://fx.test/v1" }, {}, { fetch: fetchImpl }),
  };
}

describe("frankfurter client", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://fx.test/v1" },
      }),
    );
  });

  it("probes currencies on check", async () => {
    const { urls, client } = fake(body(currencies, { EUR: "Euro" }));

    expect(await client.check()).toEqual({ ok: true });
    expect(urls[0]?.pathname).toBe("/v1/currencies");
  });

  it("fetches the latest rates for a base and symbol list", async () => {
    const { urls, client } = fake(
      body(spec.components.schemas["latest"]!, {
        amount: 1,
        base: "USD",
        date: "2026-09-15",
        rates: { EUR: 0.85 },
      }),
    );

    const latest = await client.latest({ base: "USD", symbols: ["EUR", "GBP"] });

    expect(latest.rates["EUR"]).toBe(0.85);
    expect(urls[0]?.href).toBe("https://fx.test/v1/latest?base=USD&symbols=EUR%2CGBP");
  });

  it("asks for a date range with the api's `start..end` path, open-ended when end is omitted", async () => {
    const { urls, client } = fake(
      body(spec.components.schemas["series"]!, {
        amount: 1,
        base: "EUR",
        start_date: "2026-09-01",
        end_date: "2026-09-15",
        rates: {},
      }),
    );

    await client.series({ start: "2026-09-01", end: "2026-09-15" });
    await client.series({ start: "2026-09-01" });

    expect(urls.map((u) => u.pathname)).toEqual(["/v1/2026-09-01..2026-09-15", "/v1/2026-09-01.."]);
  });

  it("surfaces a 429 with its status", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { client } = fake("too many", 429);
    const caught: unknown[] = [];
    const pending = client.currencies().catch((error: unknown) => {
      caught.push(error);
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(caught).toHaveLength(1);
    expect(() => {
      throw caught[0];
    }).toThrow(/frankfurter answered 429/);
    vi.useRealTimers();
  });
});
