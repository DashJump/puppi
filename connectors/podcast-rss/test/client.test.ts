import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { NotFound } from "@puppi/sdk";
import { describe, expect, it } from "vitest";

import * as connector from "../src/index.js";
import { Client, type Episode } from "../src/index.js";
import { operations } from "../src/operations.js";

const FEED = "https://feeds.test/show.xml";
const SEEN = "2026-10-09T06:00:00.000Z";
const FEED_ID = sha256(FEED);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
}

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));
}

interface FeedBytes {
  body: Uint8Array;
  type: string;
}

function harness(
  routes: Record<string, string | number | FeedBytes>,
  config: Record<string, unknown> = {},
) {
  const calls: { url: string; headers: Headers }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);

    calls.push({ url, headers: new Headers(init?.headers) });

    const route = routes[url];

    if (route === undefined) return new Response("missing", { status: 404 });
    if (typeof route === "number") return new Response("no", { status: route });

    if (typeof route === "string") {
      return new Response(route, {
        status: 200,
        headers: { "content-type": "application/rss+xml" },
      });
    }

    return new Response(route.body, {
      status: 200,
      headers: { "content-type": route.type },
    });
  }) as typeof fetch;

  return {
    calls,
    client: new Client(config, {}, { fetch: fetchImpl, now: () => new Date(SEEN) }),
  };
}

async function pages(
  client: Client,
  args: { feed_url: string; limit?: number; cursor?: string | null },
) {
  const seen: { cursor: string | null; guids: string[] }[] = [];

  for await (const page of client.episodes({
    feed_url: args.feed_url,
    limit: args.limit,
    cursor: args.cursor,
  })) {
    seen.push({ cursor: page.cursor, guids: page.data.map((row) => row.guid) });
  }

  return seen;
}

async function titles(route: string | FeedBytes): Promise<string[]> {
  const { client } = harness({ [FEED]: route });
  const seen: string[] = [];

  for await (const page of client.episodes({ feed_url: FEED })) {
    for (const row of page.data) seen.push(row.title);
  }

  return seen;
}

describe("podcast-rss connector", () => {
  it("exports the source interface and is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config: {},
      }),
    );
  });

  it("reads an RSS item into an episode row", async () => {
    const { calls, client } = harness({ [FEED]: fixture("show.xml") });
    const seen: Episode[][] = [];

    for await (const page of client.episodes({ feed_url: FEED })) seen.push(page.data);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toEqual({
      episode_id: "ep-1",
      feed_id: FEED_ID,
      guid: "ep-1",
      title: "Tom & Jerry",
      description: "full <b>notes</b>",
      published_at: "2021-02-26T05:00:00.000Z",
      audio_url: "https://cdn.test/ep-1.mp3",
      audio_type: "audio/mpeg",
      audio_bytes: 1234,
      duration_sec: 3723,
      episode_url: "https://example.test/ep-1",
      season: 2,
      episode_n: 3,
      observed_at: SEEN,
    });
    expect(seen[0]?.[1]).toMatchObject({
      episode_id: "ep-2",
      feed_id: FEED_ID,
      guid: "ep-2",
      published_at: "2024-03-01T12:00:00.000Z",
      audio_url: "https://cdn.test/ep-2.mp3",
      audio_type: "audio/mpeg",
      audio_bytes: 99,
      duration_sec: 123,
      observed_at: SEEN,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(FEED);
    expect(calls[0]?.headers.get("accept")).toContain("application/rss+xml");
    expect(calls[0]?.headers.get("user-agent")).toContain("puppi-adapter-podcast-rss");
  });

  it("hashes a missing guid and skips an item with no audio or no date", async () => {
    const { client } = harness({ [FEED]: fixture("show.xml") });
    const seen: Episode[] = [];

    for await (const page of client.episodes({ feed_url: FEED })) seen.push(...page.data);

    const id = sha256(`${FEED_ID}https://cdn.test/noguid.mp3`);

    expect(seen.map((row) => row.title)).toEqual(["Tom & Jerry", "Video first", "No guid"]);
    expect(seen[2]).toEqual({
      episode_id: id,
      feed_id: FEED_ID,
      guid: id,
      title: "No guid",
      description: null,
      published_at: "2021-03-01T00:00:00.000Z",
      audio_url: "https://cdn.test/noguid.mp3",
      audio_type: "audio/mpeg",
      audio_bytes: null,
      duration_sec: null,
      episode_url: null,
      season: null,
      episode_n: null,
      observed_at: SEEN,
    });
  });

  it("reads an RSS feed that names an XSL stylesheet", async () => {
    const styled = fixture("show.xml").replace(
      /^(<\?xml[^?]*\?>)/,
      '$1\n<?xml-stylesheet type="text/xsl" href="/feed.xsl"?>',
    );

    expect(styled).toContain("<?xml-stylesheet");
    expect(await titles(styled)).toEqual(["Tom & Jerry", "Video first", "No guid"]);
  });

  it("reads an Atom feed", async () => {
    const { client } = harness({ [FEED]: fixture("show.atom") });
    const seen: Episode[] = [];

    for await (const page of client.episodes({ feed_url: FEED })) seen.push(...page.data);

    expect(seen.map((row) => row.guid)).toEqual(["tag:example.test,2021:ep-1", "atom-2"]);
    expect(seen[0]).toMatchObject({
      episode_id: "tag:example.test,2021:ep-1",
      title: "Atom One",
      published_at: "2021-02-26T05:00:00.000Z",
      audio_url: "https://cdn.test/atom-1.mp3",
      audio_type: "audio/mpeg",
      audio_bytes: 50,
      episode_url: "https://example.test/atom-1",
      description: "hello & welcome",
      feed_id: FEED_ID,
      observed_at: SEEN,
    });
    expect(seen[1]).toMatchObject({
      published_at: "2022-01-02T03:04:05.000Z",
      duration_sec: 62,
      audio_url: "https://cdn.test/atom-2.mp3",
    });
  });

  it("follows a relative next link and resumes from that cursor", async () => {
    const page2 = "https://feeds.test/page2.xml";
    const { calls, client } = harness({
      [FEED]: fixture("page-1.xml"),
      [page2]: fixture("page-2.xml"),
    });

    const seen = await pages(client, { feed_url: FEED });

    expect(seen).toEqual([
      { cursor: page2, guids: ["p1"] },
      { cursor: null, guids: ["p2"] },
    ]);
    expect(calls.map((call) => call.url)).toEqual([FEED, page2]);

    const resumed = await pages(client, { feed_url: FEED, cursor: page2 });

    expect(resumed).toEqual([{ cursor: null, guids: ["p2"] }]);
  });

  it("splits one document when limit is set and resumes at the offset", async () => {
    const { calls, client } = harness({ [FEED]: fixture("show.xml") });
    const seen = await pages(client, { feed_url: FEED, limit: 2 });
    const cursor = JSON.stringify({ offset: 2, url: FEED });

    expect(seen).toEqual([
      { cursor, guids: ["ep-1", "ep-2"] },
      { cursor: null, guids: [sha256(`${FEED_ID}https://cdn.test/noguid.mp3`)] },
    ]);
    expect(calls).toHaveLength(1);

    const resumed = await pages(client, { feed_url: FEED, cursor, limit: 2 });

    expect(resumed).toEqual([
      { cursor: null, guids: [sha256(`${FEED_ID}https://cdn.test/noguid.mp3`)] },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("follows a next link when the first document has no episodes", async () => {
    const page2 = "https://feeds.test/page2.xml";
    const { calls, client } = harness({
      [FEED]: fixture("empty-next.xml"),
      [page2]: fixture("page-2.xml"),
    });

    expect(await pages(client, { feed_url: FEED })).toEqual([{ cursor: null, guids: ["p2"] }]);
    expect(calls.map((call) => call.url)).toEqual([FEED, page2]);
  });

  it("stops when the next link repeats the page", async () => {
    const loop = `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><atom:link rel="next" href="${FEED}"/><item><guid>only</guid><title>Only</title><pubDate>Wed, 01 Jan 2020 00:00:00 GMT</pubDate><enclosure url="https://cdn.test/only.mp3" type="audio/mpeg"/></item></channel></rss>`;
    const { calls, client } = harness({ [FEED]: loop });

    expect(await pages(client, { feed_url: FEED })).toEqual([{ cursor: null, guids: ["only"] }]);
    expect(calls).toHaveLength(1);
  });

  it("rejects a feed that is not RSS or Atom", async () => {
    const { client } = harness({ [FEED]: "<html><body>nope</body></html>" });

    await expect(pages(client, { feed_url: FEED })).rejects.toThrow(/could not parse/);
  });

  it("checks without a request and refuses a call that names no feed", async () => {
    const { calls, client } = harness({ [FEED]: fixture("show.xml") });

    expect(await client.check()).toEqual({ ok: true });
    expect(calls).toEqual([]);

    await expect(client.episodes({ feed_url: "" }).next()).rejects.toThrow(
      "podcast-rss requires feed_url",
    );
    await expect(
      (client.episodes as () => ReturnType<Client["episodes"]>)().next(),
    ).rejects.toThrow("podcast-rss requires feed_url");
    expect(calls).toEqual([]);
  });

  it("hashes feed_url across a resumed page and a second feed", async () => {
    const page2 = "https://feeds.test/page2.xml";
    const other = "https://feeds.test/other.xml";
    const { calls, client } = harness({
      [FEED]: fixture("page-1.xml"),
      [page2]: fixture("page-2.xml"),
      [other]: fixture("show.xml"),
    });

    const walked: { cursor: string | null; ids: string[]; guids: string[] }[] = [];

    for await (const page of client.episodes({ feed_url: FEED })) {
      walked.push({
        cursor: page.cursor,
        ids: page.data.map((row) => row.feed_id),
        guids: page.data.map((row) => row.guid),
      });
    }

    expect(walked).toEqual([
      { cursor: page2, ids: [FEED_ID], guids: ["p1"] },
      { cursor: null, ids: [FEED_ID], guids: ["p2"] },
    ]);

    const resumed: Episode[] = [];

    for await (const page of client.episodes({ feed_url: FEED, cursor: page2 })) {
      resumed.push(...page.data);
    }

    expect(resumed.map((row) => row.feed_id)).toEqual([FEED_ID]);
    expect(resumed.map((row) => row.guid)).toEqual(["p2"]);

    const second: Episode[] = [];

    for await (const page of client.episodes({ feed_url: other })) second.push(...page.data);

    expect(second.length).toBeGreaterThan(0);
    expect(new Set(second.map((row) => row.feed_id))).toEqual(new Set([sha256(other)]));
    expect(calls.map((call) => call.url)).toEqual([FEED, page2, page2, other]);
  });

  it("reports a missing feed as not found", async () => {
    const { client } = harness({ [FEED]: 404 });

    await expect(pages(client, { feed_url: FEED })).rejects.toBeInstanceOf(NotFound);
  });

  it("decodes an ISO-8859-1 feed from the Content-Type charset", async () => {
    expect(
      await titles({
        body: fixtureBytes("iso-8859-1.xml"),
        type: "application/rss+xml; charset=ISO-8859-1",
      }),
    ).toEqual(["Café"]);
  });

  it("decodes a windows-1252 feed from the XML declaration", async () => {
    expect(
      await titles({
        body: fixtureBytes("windows-1252.xml"),
        type: "application/rss+xml",
      }),
    ).toEqual(["“Café”"]);
  });

  it("decodes a UTF-16 LE feed from its BOM", async () => {
    expect(
      await titles({
        body: fixtureBytes("utf-16le.xml"),
        type: "application/rss+xml",
      }),
    ).toEqual(["Café"]);
  });

  it("prefers the Content-Type charset over the XML declaration", async () => {
    expect(
      await titles({
        body: fixtureBytes("header-over-declaration.xml"),
        type: "application/rss+xml; charset=ISO-8859-1",
      }),
    ).toEqual(["Café"]);
  });
});
