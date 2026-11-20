import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it, vi } from "vitest";

import * as connector from "../src/index.js";
import { Client, multiplier, NotFound, type Type } from "../src/index.js";
import { operations } from "../src/operations.js";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, object> };
};

/** A response body from the pinned schema, with the fields this case cares about. */
function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

function named(name: string, url = `https://poke.test/api/v2/pokemon/${name}/`) {
  return body(spec.components.schemas["named"]!, { name, url });
}

function namedPage(overrides: Record<string, unknown>) {
  return body(spec.components.schemas["namedPage"]!, overrides);
}

/** A fake PokeAPI: answers by path, records every url. */
function fake(routes: Record<string, unknown>) {
  const urls: string[] = [];

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const route = routes[path];

    if (route === undefined) return new Response("not here", { status: 404 });
    if (typeof route === "function") return route();

    return new Response(JSON.stringify(route), { status: 200 });
  }) as typeof fetch;

  return {
    urls,
    client: new Client({ base_url: "https://poke.test/api/v2/" }, {}, { fetch: fetchImpl }),
  };
}

const results = (names: string[]) => names.map((name) => named(name));

describe("pokeapi client", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://poke.test/api/v2/" },
      }),
    );
  });

  it("lists a page with the limit and offset it was asked for", async () => {
    const { urls, client } = fake({
      "/api/v2/pokemon?limit=2&offset=4": namedPage({
        count: 6,
        next: null,
        previous: null,
        results: [named("charmander", "https://poke.test/api/v2/pokemon/4/")],
      }),
    });

    const page = await client.list("pokemon", { limit: 2, offset: 4 });

    expect(page.results[0]?.name).toBe("charmander");
    expect(urls).toEqual(["https://poke.test/api/v2/pokemon?limit=2&offset=4"]);
  });

  it("walks every page, yielding offsets a source can checkpoint", async () => {
    const { client } = fake({
      "/api/v2/pokemon?limit=2&offset=0": namedPage({
        count: 5,
        next: "x",
        previous: null,
        results: results(["a", "b"]),
      }),
      "/api/v2/pokemon?limit=2&offset=2": namedPage({
        count: 5,
        next: "x",
        previous: null,
        results: results(["c", "d"]),
      }),
      "/api/v2/pokemon?limit=2&offset=4": namedPage({
        count: 5,
        next: null,
        previous: null,
        results: results(["e"]),
      }),
    });

    const seen: { offset: string | number | null; names: string[] }[] = [];

    for await (const page of client.pokemons({ limit: 2 })) {
      seen.push({
        offset: page.cursor,
        names: page.data.map((row) => row.name),
      });
    }

    expect(seen).toEqual([
      { offset: 2, names: ["a", "b"] },
      { offset: 4, names: ["c", "d"] },
      { offset: null, names: ["e"] },
    ]);
  });

  it("resumes from an offset", async () => {
    const { urls, client } = fake({
      "/api/v2/pokemon?limit=2&offset=2": namedPage({
        count: 10,
        next: null,
        previous: null,
        results: results(["c", "d"]),
      }),
    });

    const names: string[] = [];

    for await (const page of client.pokemons({ limit: 2, cursor: 2 })) {
      names.push(...page.data.map((row) => row.name));
    }

    expect(names).toEqual(["c", "d"]);
    expect(urls).toEqual(["https://poke.test/api/v2/pokemon?limit=2&offset=2"]);
  });

  it("turns a 429 into an error the executor retries, and a 404 into NotFound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { client } = fake({
      "/api/v2/pokemon/mew": () =>
        new Response("slow down", { status: 429, statusText: "Too Many Requests" }),
    });
    const caught: unknown[] = [];
    const pending = client.pokemon("mew").catch((error: unknown) => {
      caught.push(error);
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    expect(caught).toHaveLength(1);
    expect(() => {
      throw caught[0];
    }).toThrow(/answered 429 Too Many Requests/);
    vi.useRealTimers();
    await expect(client.pokemon("missingno")).rejects.toThrow(NotFound);
  });

  it("derives an attack multiplier from damage relations", () => {
    const relations = body(spec.components.schemas["damageRelations"]!, {
      double_damage_to: [named("grass", "")],
      half_damage_to: [named("water", "")],
      no_damage_to: [named("ghost", "")],
      double_damage_from: [],
      half_damage_from: [],
      no_damage_from: [],
    }) as Type["damage_relations"];

    expect(multiplier(relations, "grass")).toBe(2);
    expect(multiplier(relations, "water")).toBe(0.5);
    expect(multiplier(relations, "ghost")).toBe(0);
    expect(multiplier(relations, "normal")).toBe(1);
  });
});
