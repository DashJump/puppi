import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { HttpStatusError, NotFound } from "@puppi/sdk";
import { describe, expect, it } from "vitest";

import * as connector from "../src/index.js";
import { Client, FEEDS_DUMP_URL } from "../src/index.js";
import { operations } from "../src/operations.js";

const KEY = "UXKCGDSYGUUEVQJSYDZH";
const SECRET = "yzJe2eE7XV-3eY576dyRZ6wXyAbndh6LUrCZ8KN|";
const UNIX = 1_613_713_388;
const OBSERVED_AT = new Date(UNIX * 1000).toISOString();
/** Independent of the client: sha1(key + secret + unix time), lowercase hex. */
const AUTHORIZATION = "73a1fffed61c1d30d858beb1fc48f355386449d2";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

const feed = fixture("podcast-by-feed-id.json");
const missing = fixture("podcast-missing.json");
const search = fixture("search.json");
const episodes = fixture("episodes.json");
const episodesShifted = fixture("episodes-shifted.json");

interface Call {
  url: string;
  headers: Record<string, string>;
}

function clientFor(respond: (url: URL) => Response, options: { now?: () => Date } = {}) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;

    calls.push({ url: url.href, headers });

    return respond(url);
  }) as typeof fetch;

  const client = new Client(
    { base_url: "https://podcastindex.test" },
    { api_key: KEY, api_secret: SECRET },
    { fetch: fetchImpl, now: options.now ?? (() => new Date(UNIX * 1000)) },
  );

  return { calls, client };
}

async function collect<T>(pages: AsyncIterable<T>): Promise<T[]> {
  const rows: T[] = [];

  for await (const page of pages) rows.push(page);

  return rows;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Error",
  });
}

/** A feed-id episode lookup resolves `/podcasts/byfeedid` before it lists episodes. */
function withFeed(respond: (url: URL) => Response): (url: URL) => Response {
  return (url) => (url.pathname === "/podcasts/byfeedid" ? json(feed) : respond(url));
}

/** Newest `max` episodes, which is what /episodes/byfeedid returns. */
function episodePage(max: number): Record<string, unknown> {
  const items = (episodes["items"] as unknown[]).slice(0, max);

  return { ...episodes, count: items.length, items };
}

const RSS = "https://feeds.theincomparable.com/batmanuniversity";
const FEED_ID = createHash("sha256").update(RSS).digest("hex");
const THIN_RSS = "https://example.test/thin.xml";
const THIN_ID = createHash("sha256").update(THIN_RSS).digest("hex");

const showRow = {
  feed_id: FEED_ID,
  title: "Batman University",
  rss_url: "https://feeds.theincomparable.com/batmanuniversity",
  podcast_index_id: 75075,
  image_url: "https://example.test/artwork.jpg",
  author: "The Incomparable",
  language: "en",
  known: true,
};

const newestEpisode = {
  episode_id: "episode-guid-30",
  feed_id: FEED_ID,
  guid: "episode-guid-30",
  title: "Newest",
  description: "The full description.",
  published_at: "2021-01-31T20:43:20.000Z",
  audio_url: "https://example.test/ep30.mp3",
  audio_type: "audio/mpeg",
  audio_bytes: 4987654,
  duration_sec: 1800,
  episode_url: "https://example.test/ep30",
  season: 2,
  episode_n: 3,
  observed_at: OBSERVED_AT,
};

describe("podcast-index connector", () => {
  it("exports the source interface and is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: { base_url: "https://podcastindex.test" },
      }),
    );
  });

  it("signs each request with the published SHA-1 header", async () => {
    expect(createHash("sha1").update(`${KEY}${SECRET}${UNIX}`).digest("hex")).toBe(AUTHORIZATION);

    const { calls, client } = clientFor((url) => {
      if (url.pathname === "/podcasts/byfeedid") return json(feed);

      return json(missing, 404);
    });

    expect(await client.show({ feedId: 75075 })).toEqual(showRow);

    const headers = calls[0]?.headers ?? {};

    expect(headers["X-Auth-Date"]).toBe(String(UNIX));
    expect(headers["X-Auth-Key"]).toBe(KEY);
    expect(headers["Authorization"]).toBe(AUTHORIZATION);
    expect(headers["user-agent"]).toMatch(/^puppi-adapter-podcast-index\//);
    expect(calls[0]?.url).not.toContain(KEY);
    expect(calls[0]?.url).not.toContain(SECRET);
    expect(JSON.stringify(headers)).not.toContain(SECRET);
  });

  it("sends the signer's X-Auth-Key once, with the other signing headers", async () => {
    const { calls, client } = clientFor((url) =>
      url.pathname === "/podcasts/byfeedid" ? json(feed) : json(missing, 404),
    );

    await client.show({ feedId: 75075 });

    const headers = calls[0]?.headers ?? {};

    expect(Object.keys(headers).filter((name) => name.toLowerCase() === "x-auth-key")).toEqual([
      "X-Auth-Key",
    ]);
    expect(headers["X-Auth-Key"]).toBe(KEY);
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === "x-auth-date")).toEqual([
      "X-Auth-Date",
    ]);
    expect(headers["X-Auth-Date"]).toBe(String(UNIX));
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === "authorization")).toEqual([
      "Authorization",
    ]);
    expect(headers["Authorization"]).toBe(AUTHORIZATION);
  });

  it("refreshes the signature on the next request", async () => {
    let unix = UNIX;
    const { calls, client } = clientFor(
      (url) => (url.pathname === "/podcasts/byfeedurl" ? json(feed) : json(missing, 404)),
      { now: () => new Date(unix++ * 1000) },
    );

    await client.show({ feedUrl: "https://feeds.theincomparable.com/batmanuniversity" });
    unix = UNIX + 5;
    await client.show({ feedUrl: "https://feeds.theincomparable.com/batmanuniversity" });

    expect(calls[0]?.headers["X-Auth-Date"]).toBe(String(UNIX));
    expect(calls[1]?.headers["X-Auth-Date"]).toBe(String(UNIX + 5));
    expect(calls[1]?.headers["Authorization"]).toBe(
      createHash("sha1")
        .update(`${KEY}${SECRET}${UNIX + 5}`)
        .digest("hex"),
    );
    expect(calls[1]?.headers["Authorization"]).not.toBe(calls[0]?.headers["Authorization"]);
  });

  it("resolves a show by feed URL and reports an unknown feed as null", async () => {
    const { calls, client } = clientFor((url) => {
      if (url.searchParams.get("url") === "https://example.test/missing.xml") return json(missing);
      if (url.searchParams.get("id") === "404") return json("nope", 404);

      return json(feed);
    });

    expect(
      await client.show({ feedUrl: "https://feeds.theincomparable.com/batmanuniversity" }),
    ).toEqual(showRow);
    expect(await client.show({ feedUrl: "https://example.test/missing.xml" })).toBeNull();
    expect(await client.show({ feedId: 404 })).toBeNull();
    expect(calls[0]?.url).toContain("/podcasts/byfeedurl");
  });

  it("maps a search into shows, including a feed that only has a publish time", async () => {
    const { calls, client } = clientFor(() => json(search));
    const pages = [];

    for await (const page of client.shows({ query: "batman", max: 5 })) pages.push(page);

    expect(pages).toEqual([
      {
        cursor: null,
        data: [
          showRow,
          {
            feed_id: THIN_ID,
            title: "Thin Feed",
            rss_url: THIN_RSS,
            podcast_index_id: 920666,
            image_url: "https://example.test/thin.jpg",
            author: null,
            language: null,
            known: true,
          },
        ],
      },
    ]);
    const query = new URL(calls[0]?.url ?? "").searchParams;

    expect(query.get("q")).toBe("batman");
    expect(query.get("max")).toBe("5");
    expect(query.get("fulltext")).toBe("true");
  });

  it("pages episodes by feed id without repeating a row", async () => {
    const { calls, client } = clientFor(
      withFeed((url) => json(episodePage(Number(url.searchParams.get("max"))))),
    );
    const pages = [];

    for await (const page of client.episodes({ feedId: 75075, max: 2 })) {
      pages.push({ cursor: page.cursor, ids: page.data.map((row) => row.episode_id) });
    }

    expect(pages).toEqual([
      { cursor: 2, ids: ["episode-guid-30", "episode-guid-20"] },
      { cursor: null, ids: ["episode-guid-10"] },
    ]);
    expect(pages[1]?.ids).not.toContain("episode-guid-30");
    expect(pages[1]?.ids).not.toContain("episode-guid-20");
    expect(calls[0]?.url).toContain("/podcasts/byfeedid");
    expect(new URL(calls[0]?.url ?? "").searchParams.get("id")).toBe("75075");
    const listed = calls.slice(1);

    expect(listed.map((call) => new URL(call.url).searchParams.get("max"))).toEqual(["2", "4"]);
    expect(listed[0]?.url).toContain("/episodes/byfeedid");
    expect(new URL(listed[0]?.url ?? "").searchParams.get("fulltext")).toBe("true");
  });

  it("stops when a wider episode window does not grow", async () => {
    const two = episodePage(2);
    const { calls, client } = clientFor(withFeed(() => json(two)));
    const ids: string[] = [];

    for await (const page of client.episodes({ feedId: 75075, max: 2 })) {
      ids.push(...page.data.map((row) => row.episode_id));
    }

    expect(ids).toEqual(["episode-guid-30", "episode-guid-20"]);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toContain("/podcasts/byfeedid");
  });

  it("skips an episode the widening window repeats after a newer one is published", async () => {
    let listed = 0;
    const { client } = clientFor(
      withFeed((url) => {
        const max = Number(url.searchParams.get("max"));
        const body = listed++ === 0 ? episodes : episodesShifted;
        const items = (body["items"] as unknown[]).slice(0, max);

        return json({ ...body, count: items.length, items });
      }),
    );
    const ids: string[] = [];

    for await (const page of client.episodes({ feedId: 75075, max: 2 })) {
      ids.push(...page.data.map((row) => row.episode_id));
    }

    expect(ids).toEqual(["episode-guid-30", "episode-guid-20", "episode-guid-10"]);
  });

  it("lists episodes by feed URL and sends since", async () => {
    const { calls, client } = clientFor((url) =>
      json(episodePage(Number(url.searchParams.get("max")))),
    );

    const pages = [];

    for await (const page of client.episodes({
      feedUrl: "https://feeds.theincomparable.com/batmanuniversity",
      since: 1_610_000_000,
      max: 10,
    })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    expect(pages[0]?.cursor).toBeNull();
    expect(pages[0]?.data[0]).toEqual(newestEpisode);
    const query = new URL(calls[0]?.url ?? "").searchParams;

    expect(calls[0]?.url).toContain("/episodes/byfeedurl");
    expect(query.get("url")).toBe("https://feeds.theincomparable.com/batmanuniversity");
    expect(query.get("since")).toBe("1610000000");
    expect(query.get("max")).toBe("10");
  });

  it("lists episodes for the shows a search returns", async () => {
    const { calls, client } = clientFor((url) => {
      if (url.pathname === "/search/byterm") return json(search);

      return json(episodePage(Number(url.searchParams.get("max"))));
    });
    const ids: string[] = [];

    for await (const page of client.episodes({ query: "batman", max: 10 })) {
      ids.push(...page.data.map((row) => row.episode_id));
    }

    expect(ids).toEqual(["episode-guid-30", "episode-guid-20", "episode-guid-10"]);
    expect(calls[0]?.url).toContain("/search/byterm");
    expect(new URL(calls[1]?.url ?? "").searchParams.get("id")).toBe("75075,920666");
  });

  it("hashes episode_id and guid when the guid is missing, and skips rows that cannot be appended", async () => {
    const audio = "https://example.test/noguid.mp3";
    const rss = "https://example.test/show.xml";
    const feedId = createHash("sha256").update(rss).digest("hex");
    const hashed = createHash("sha256").update(`${feedId}${audio}`).digest("hex");
    const { calls, client } = clientFor((url) => {
      if (url.pathname === "/podcasts/byfeedid") {
        return json({ status: "true", feed: { id: 75075, url: rss, title: "Show" } });
      }

      return json({
        status: "true",
        items: [
          { id: 99, title: "No guid", datePublished: 1_612_125_800, enclosureUrl: audio },
          { id: 98, feedId: 75075, title: "No audio", datePublished: 1_612_125_800, guid: "x" },
          { id: 97, feedId: 75075, title: "No date", guid: "y", enclosureUrl: audio },
        ],
      });
    });
    const pages = await collect(client.episodes({ feedId: 75075, max: 10 }));
    const row = pages[0]?.data[0];

    expect(calls[0]?.url).toContain("/podcasts/byfeedid");
    expect(calls[1]?.url).toContain("/episodes/byfeedid");
    expect(pages[0]?.data).toHaveLength(1);
    expect(row?.episode_id).toBe(hashed);
    expect(row?.guid).toBe(hashed);
    expect(row?.feed_id).toBe(feedId);
    expect(row?.audio_url).toBe(audio);
    expect(row?.published_at).toBe("2021-01-31T20:43:20.000Z");
    expect(row?.observed_at).toBe(OBSERVED_AT);
    expect(row?.audio_bytes).toBeNull();
    expect(row?.episode_url).toBeNull();
  });

  it("hashes the rss url when a feed has no index id", async () => {
    const url = "https://example.test/only.xml";
    const { client } = clientFor(() => json({ status: "true", feed: { title: "Url only", url } }));

    expect(await client.show({ feedUrl: url })).toEqual({
      feed_id: createHash("sha256").update(url).digest("hex"),
      title: "Url only",
      rss_url: url,
      podcast_index_id: null,
      image_url: null,
      author: null,
      language: null,
      known: true,
    });
  });

  it("throws when the episode list shrinks under the rows already read", async () => {
    let phase = 0;
    const { client } = clientFor(withFeed(() => json(episodePage(phase++ === 0 ? 2 : 1))));

    await expect(collect(client.episodes({ feedId: 75075, max: 2 }))).rejects.toThrow(
      /returned 1 episodes after 2 were already read/,
    );
  });

  it("throws when a full page hits the 1000 episode cap", async () => {
    const items = Array.from({ length: 1000 }, (_, index) => ({ id: 1000 - index, feedId: 1 }));
    const { client } = clientFor(
      withFeed(() => json({ status: "true", items, count: items.length })),
    );

    await expect(collect(client.episodes({ feedId: 1, max: 1000 }))).rejects.toThrow(
      /the most one call returns/,
    );
  });

  it("streams the feeds dump unsigned", async () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 1, 2, 3]);
    const { calls, client } = clientFor(() => new Response(bytes));
    const body = new Uint8Array(await new Response(await client.feedsDump()).arrayBuffer());

    expect(body).toEqual(bytes);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(FEEDS_DUMP_URL);
    expect(calls[0]?.headers["user-agent"]).toMatch(/^puppi-adapter-podcast-index\//);
    expect(calls[0]?.headers).not.toHaveProperty("X-Auth-Key");
    expect(calls[0]?.headers).not.toHaveProperty("Authorization");
  });

  it("leaves the API signature off the dump after a signed call", async () => {
    const { calls, client } = clientFor((url) =>
      url.pathname === "/podcasts/byfeedid" ? json(feed) : new Response("tgz"),
    );

    await client.show({ feedId: 75075 });
    await client.feedsDump();

    expect(calls[0]?.headers["X-Auth-Key"]).toBe(KEY);
    expect(calls[1]?.headers).not.toHaveProperty("X-Auth-Key");
    expect(calls[1]?.headers).not.toHaveProperty("Authorization");
  });

  it("throws NotFound when the dump is missing and HttpStatusError when it is refused", async () => {
    const missingDump = clientFor(() => new Response("gone", { status: 404 }));

    await expect(missingDump.client.feedsDump()).rejects.toBeInstanceOf(NotFound);

    const refused = clientFor(() => new Response("bad agent", { status: 403 }));

    await expect(refused.client.feedsDump()).rejects.toBeInstanceOf(HttpStatusError);
  });
});
