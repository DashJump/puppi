/**
 * `@puppi/adapter-podcast-rss`: a source connector over RSS 2.0 and Atom 1.0
 * feeds. `episodes({ feed_url })` GETs that URL (`podcasts/feeds.rss_url`),
 * so one binding reads many feeds. No key. A `rel="next"` link is the next
 * page. `limit` slices one document; pass that cursor back to resume.
 */

import { createHash } from "node:crypto";

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  type PageArgs,
} from "@puppi/sdk";

import connector from "./define.js";
import { type Episode, type EpisodeDraft, isFeedPage, normalizeFeedFetch } from "./feed.js";
import { type Api, operations } from "./operations.js";

export type { Episode };

export default connector;

const FEED_ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.1";

interface Walk {
  url: string;
  offset: number;
}

export class Client extends OpenApiClient<Api> {
  private readonly now: () => Date;

  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions & { now?: () => Date } = {},
  ) {
    const { now, ...clientOptions } = options;

    super(
      config,
      { ...clientOptions, fetch: normalizeFeedFetch(clientOptions.fetch ?? fetch) },
      ...openApiClientOptions(connector, config, secrets, operations, {
        baseUrl: "",
        headers: { accept: FEED_ACCEPT },
      }),
    );
    this.now = now ?? (() => new Date());
  }

  /** The binding names no host. `episodes` is what GETs a feed. */
  override check(): Promise<CredentialCheck> {
    return Promise.resolve({ ok: true });
  }

  /**
   * Every remaining page of `feed_url`. `cursor` is the next-page URL, or a
   * `{ offset, url }` token when `limit` stopped inside one document. Null
   * on the last page. `published_at` is the append watermark; pass `cursor`
   * back to resume the walk. Older episodes stay in the page.
   */
  @read
  episodes(args: {
    feed_url: string;
    limit?: number;
    cursor?: PageArgs["cursor"];
  }): AsyncGenerator<{ cursor: string | null; data: Episode[] }> {
    return this.walk(args);
  }

  private async *walk(args?: {
    feed_url: string;
    limit?: number;
    cursor?: PageArgs["cursor"];
  }): AsyncGenerator<{ cursor: string | null; data: Episode[] }> {
    const feed = feedUrl(args?.feed_url);
    const feedId = sha256(feed);
    const size = pageSize(args?.limit);
    let walk = parseCursor(args?.cursor ?? null, feed);
    const seen = new Set<string>();

    for (;;) {
      const key = `${walk.offset}\n${walk.url}`;

      if (seen.has(key)) return;

      seen.add(key);

      const page = await this.load(walk.url);
      const observedAt = this.now().toISOString();
      const rows = page.episodes.map((episode) => stamp(episode, feedId, observedAt));
      const nextUrl = follow(page.next, walk.url);

      if (size === undefined) {
        const data = rows.slice(walk.offset);

        if (data.length > 0) yield { cursor: nextUrl, data };
        if (nextUrl === null) return;

        walk = { url: nextUrl, offset: 0 };
        continue;
      }

      let offset = walk.offset;

      if (offset >= rows.length) {
        if (nextUrl === null) return;

        walk = { url: nextUrl, offset: 0 };
        continue;
      }

      while (offset < rows.length) {
        const data = rows.slice(offset, offset + size);

        offset += data.length;

        const more = offset < rows.length;
        const cursor = more ? offsetCursor(offset, walk.url) : nextUrl;

        if (data.length > 0) yield { cursor, data };
        if (more) continue;
        if (cursor === null) return;

        walk = { url: cursor, offset: 0 };
        break;
      }
    }
  }

  private async load(url: string): Promise<{ next: string | null; episodes: EpisodeDraft[] }> {
    const result = await this.send<unknown>(url);

    if (!isFeedPage(result.data)) {
      throw new Error(`podcast-rss answered ${url} without a feed document`);
    }

    return {
      next: typeof result.data.next === "string" ? result.data.next : null,
      episodes: result.data.episodes,
    };
  }
}

function stamp(episode: EpisodeDraft, feedId: string, observedAt: string): Episode {
  const episodeId = episode.guid !== "" ? episode.guid : sha256(feedId + episode.audio_url);

  return {
    episode_id: episodeId,
    feed_id: feedId,
    guid: episode.guid !== "" ? episode.guid : episodeId,
    title: episode.title,
    description: episode.description,
    published_at: episode.published_at,
    audio_url: episode.audio_url,
    audio_type: episode.audio_type,
    audio_bytes: episode.audio_bytes,
    duration_sec: episode.duration_sec,
    episode_url: episode.episode_url,
    season: episode.season,
    episode_n: episode.episode_n,
    observed_at: observedAt,
  };
}

/** Lowercase hex SHA-256. `feed_id` is this of the `feed_url` argument (the rss URL). */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function feedUrl(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("podcast-rss requires feed_url");

  return value;
}

function pageSize(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;

  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("podcast-rss limit must be a positive integer");
  }

  return limit;
}

function parseCursor(cursor: string | number | null, feed: string): Walk {
  if (cursor === null || cursor === "") return { url: feed, offset: 0 };

  const text = String(cursor);

  if (text.startsWith("https://") || text.startsWith("http://")) return { url: text, offset: 0 };

  if (text.startsWith("{")) {
    const parsed = offsetOf(text);

    if (parsed) return parsed;
  }

  throw new Error(`podcast-rss cursor is not a page token: ${text}`);
}

function offsetOf(text: string): Walk | null {
  try {
    const parsed = JSON.parse(text) as { offset?: unknown; url?: unknown };

    if (
      typeof parsed.url === "string" &&
      (parsed.url.startsWith("https://") || parsed.url.startsWith("http://")) &&
      typeof parsed.offset === "number" &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return { url: parsed.url, offset: parsed.offset };
    }
  } catch {
    return null;
  }

  return null;
}

function offsetCursor(offset: number, url: string): string {
  return JSON.stringify({ offset, url });
}

function follow(next: string | null, current: string): string | null {
  if (!next || next === current) return null;
  if (!next.startsWith("https://") && !next.startsWith("http://")) return null;

  return next;
}
