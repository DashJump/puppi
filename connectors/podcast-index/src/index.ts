/**
 * `@puppi/adapter-podcast-index`: a source connector over the Podcast Index
 * API. Each request is signed with `X-Auth-Key`, `X-Auth-Date`, and
 * `Authorization: sha1(apiKey + apiSecret + unixTime)`. The date is refreshed
 * per request; the API rejects a timestamp outside a three-minute window.
 * `api_secret` is a second binding secret. The connector can name only
 * `api_key`.
 */

import { createHash } from "node:crypto";

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  type HttpResult,
  NotFound,
  OpenApiClient,
  openApiClientOptions,
  type Page,
  type RequestOptions,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaEpisode, SchemaFeed } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export default connector;

const type = connector.type;
const auth = connector.auth;

/** One call returns at most this many episodes, and `max` cannot be higher. */
const EPISODE_CAP = 1000;
/** `episodes/byfeedid` accepts at most this many comma-separated ids. */
const ID_LIST_CAP = 200;
/** How many shows a search contributes when the caller does not say. */
const DEFAULT_SHOW_MATCHES = 10;
/** The weekly SQLite dump of every live feed. Public, unsigned. */
export const FEEDS_DUMP_URL = "https://public.podcastindex.org/podcastindex_feeds.db.tgz";

/**
 * A `podcasts/feeds` row. `feed_id` is the hex SHA-256 of `rss_url`, the same
 * key the RSS connector uses. The index id stays in `podcast_index_id`.
 * `subject_id` and `added_at` are not here: the API has no Puppi subject,
 * and no time the feed was added.
 */
export interface Show {
  feed_id: string;
  title: string;
  rss_url: string;
  podcast_index_id: number | null;
  image_url: string | null;
  author: string | null;
  language: string | null;
  known: boolean;
}

/**
 * A `podcasts/episodes` row, shared with the RSS connector.
 * `episode_id` is the item guid, or the SHA-256 of `feed_id` + `audio_url`
 * when that guid is missing. `guid` is that same hash in the missing case.
 * `published_at` is the append watermark.
 * `observed_at` is when this client read the row.
 */
export interface Episode {
  episode_id: string;
  feed_id: string;
  guid: string;
  title: string;
  description: string | null;
  /** ISO 8601. The append watermark. */
  published_at: string;
  audio_url: string;
  audio_type: string | null;
  audio_bytes: number | null;
  duration_sec: number | null;
  episode_url: string | null;
  season: number | null;
  episode_n: number | null;
  /** ISO 8601. */
  observed_at: string;
}

interface PageOptions {
  /** Episodes per page. Defaults to the API cap of 1000. */
  max?: number;
  /** Only episodes published after this unix time. */
  since?: number;
  /** Episodes already returned. Null starts at the newest. */
  cursor?: number | null;
}

export type EpisodeQuery =
  | ({ feedId: number } & PageOptions)
  | ({ feedUrl: string } & PageOptions)
  | ({ query: string; feedLimit?: number } & PageOptions);

type EpisodeBody = Api["responses"]["episodesByFeedId"];

export class Client extends OpenApiClient<Api> {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly now: () => Date;

  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions & { now?: () => Date } = {},
  ) {
    super(config, options, ...openApiClientOptions(connector, config, secrets, operations));
    this.apiKey = secrets[auth.secret] ?? "";
    this.apiSecret = secrets["api_secret"] ?? "";
    this.now = options.now ?? (() => new Date());
  }

  /** `GET /categories/list` proves `api_key`. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/categories/list", auth.secret);
  }

  /** The feed for an id or URL, or null when the index does not know it. */
  @read
  async show(args: { feedId: number } | { feedUrl: string }): Promise<Show | null> {
    try {
      const body =
        "feedId" in args
          ? await this.read("podcastByFeedId", { query: { id: args.feedId } })
          : await this.read("podcastByFeedUrl", { query: { url: args.feedUrl } });

      if (!accepted(body.status) || !body.feed) return null;

      return toShow(body.feed);
    } catch (error) {
      if (error instanceof NotFound) return null;

      throw error;
    }
  }

  /** Shows matching `query`. The API returns one window, so `cursor` is always null. */
  @read
  async *shows(args: {
    query: string;
    max?: number;
    cursor?: number | null;
  }): AsyncGenerator<Page<Show, null>> {
    if (typeof args.cursor === "number") return;

    const body = await this.read("searchPodcasts", {
      query: { q: args.query, max: args.max, fulltext: true },
    });

    if (!accepted(body.status)) return;

    const data = (body.feeds ?? []).flatMap((item) => {
      const row = toShow(item);

      return row === null ? [] : [row];
    });

    if (data.length > 0) yield { cursor: null, data };
  }

  /**
   * Episodes for a feed id, a feed URL, or the shows a search matched.
   * A feed id is resolved to its rss URL first, so `feed_id` is the hash of
   * that URL. Newest first. `published_at` is the append watermark: the next poll
   * passes that time, in unix seconds, as `since`. `cursor` is only how
   * many episodes this poll already returned. There is no page token: the
   * API returns the newest `max` (at most 1000), so the next page asks for
   * a wider window and yields the new tail. A publish between those requests
   * shifts that newest-first window, so an `episode_id` already yielded in
   * this poll is skipped. A full window at 1000 throws, because anything
   * older was not returned.
   */
  @read
  async *episodes(args: EpisodeQuery): AsyncGenerator<Page<Episode, number>> {
    const pageSize = args.max ?? EPISODE_CAP;

    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > EPISODE_CAP) {
      throw new Error(`${type} max must be an integer from 1 to ${EPISODE_CAP}`);
    }

    let offset = args.cursor ?? 0;

    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`${type} cursor must be a non-negative integer`);
    }

    const target = await this.episodeTarget(args);

    if (target === null) return;

    const seen = new Set<string>();

    for (;;) {
      const requested = offset + pageSize;

      if (requested > EPISODE_CAP) {
        throw new Error(capMessage());
      }

      const body = await this.episodeBody(target, args.since, requested);

      if (!accepted(body.status)) return;

      const raw = body.items ?? [];
      const observedAt = this.now().toISOString();

      if (raw.length < offset) {
        throw new Error(
          `${type} returned ${raw.length} episodes after ${offset} were already read`,
        );
      }

      if (raw.length >= EPISODE_CAP) throw new Error(capMessage());

      const page = raw.slice(offset).flatMap((item) => {
        const row = toEpisode(item, observedAt, rssFor(item, target));

        if (row === null || seen.has(row.episode_id)) return [];

        seen.add(row.episode_id);

        return [row];
      });
      const more = raw.length === requested;

      if (page.length > 0) yield { data: page, cursor: more ? requested : null };
      if (!more) return;

      offset = requested;
    }
  }

  /**
   * The weekly feeds dump as it downloads: a gzipped tar holding one SQLite
   * file. Unsigned, because the dump host is public. The caller reads the stream.
   */
  @read
  feedsDump(): Promise<ReadableStream<Uint8Array>> {
    return this.download(FEEDS_DUMP_URL);
  }

  protected override dispatch<T>(
    pathOrUrl: string,
    init: { method?: RequestOptions["method"]; body?: unknown } = {},
  ): Promise<HttpResult<T>> {
    this.sign();

    return super.dispatch(pathOrUrl, init);
  }

  /** A feed URL, or index ids whose rss URLs are already known. Null when nothing can be keyed. */
  private async episodeTarget(args: EpisodeQuery): Promise<EpisodeTarget | null> {
    if ("feedUrl" in args) return { url: args.feedUrl, rssUrl: args.feedUrl, rssById: new Map() };
    if (!("query" in args)) {
      const rssUrl = await this.rssUrl(args.feedId);

      return rssUrl === null
        ? null
        : { id: String(args.feedId), rssUrl, rssById: new Map([[args.feedId, rssUrl]]) };
    }

    const feeds = await this.matchingFeeds(args.query, args.feedLimit);

    return feeds.length === 0
      ? null
      : { id: feeds.map(([id]) => String(id)).join(","), rssById: new Map(feeds) };
  }

  /** The rss URL for an index id, or null when the index does not know the feed. */
  private async rssUrl(feedId: number): Promise<string | null> {
    try {
      const body = await this.read("podcastByFeedId", { query: { id: feedId } });

      if (!accepted(body.status) || !body.feed) return null;

      return text(body.feed.url);
    } catch (error) {
      if (error instanceof NotFound) return null;

      throw error;
    }
  }

  private async matchingFeeds(
    query: string,
    feedLimit: number | undefined,
  ): Promise<[number, string][]> {
    const body = await this.read("searchPodcasts", {
      query: { q: query, max: feedLimit ?? DEFAULT_SHOW_MATCHES },
    });

    if (!accepted(body.status)) return [];

    const feeds: [number, string][] = [];
    const seen = new Set<number>();

    for (const item of body.feeds ?? []) {
      const id = whole(item.id);
      const url = text(item.url);

      if (id === null || url === null || seen.has(id)) continue;

      seen.add(id);
      feeds.push([id, url]);
    }

    if (feeds.length > ID_LIST_CAP) {
      throw new Error(
        `${type} search matched ${feeds.length} shows; episodes/byfeedid accepts at most ${ID_LIST_CAP} ids`,
      );
    }

    return feeds;
  }

  private episodeBody(
    target: { id?: string; url?: string },
    since: number | undefined,
    max: number,
  ): Promise<EpisodeBody> {
    if (target.url !== undefined) {
      return this.read("episodesByFeedUrl", {
        query: { url: target.url, since, max, fulltext: true },
      });
    }

    return this.read("episodesByFeedId", {
      query: { id: target.id, since, max, fulltext: true },
    });
  }

  private sign(): void {
    delete this.headers["X-Auth-Date"];
    delete this.headers["X-Auth-Key"];
    delete this.headers["Authorization"];

    if (this.apiKey === "") return;

    const unix = Math.floor(this.now().getTime() / 1000);

    this.headers["X-Auth-Date"] = String(unix);
    this.headers["X-Auth-Key"] = this.apiKey;
    this.headers["Authorization"] = createHash("sha1")
      .update(`${this.apiKey}${this.apiSecret}${unix}`)
      .digest("hex");
  }
}

function capMessage(): string {
  return `${type} returned ${EPISODE_CAP} episodes, the most one call returns, so the list is incomplete`;
}

interface EpisodeTarget {
  id?: string;
  url?: string;
  /** Rss URL for a lookup that names one show. */
  rssUrl?: string;
  /** Index id to rss URL, from a search or a resolved feed id. */
  rssById: Map<number, string>;
}

function rssFor(item: SchemaEpisode, target: EpisodeTarget): string | null {
  if (typeof item.feedId === "number") {
    const known = target.rssById.get(item.feedId);

    if (known !== undefined) return known;
  }

  return target.rssUrl ?? null;
}

function toShow(feed: SchemaFeed): Show | null {
  const rssUrl = text(feed.url) ?? "";
  const feedId = feedKey(rssUrl);

  if (feedId === null) return null;

  return {
    feed_id: feedId,
    title: text(feed.title) ?? "",
    rss_url: rssUrl,
    podcast_index_id: whole(feed.id),
    image_url: text(feed.artwork) ?? text(feed.image),
    author: text(feed.author),
    language: text(feed.language),
    known: true,
  };
}

function toEpisode(item: SchemaEpisode, observedAt: string, rssUrl: string | null): Episode | null {
  const audioUrl = text(item.enclosureUrl);
  const publishedAt = unixIso(item.datePublished);
  const feedId = rssUrl === null ? null : feedKey(rssUrl);

  if (audioUrl === null || publishedAt === null || feedId === null) return null;

  const rssGuid = text(item.guid);
  const episodeId = rssGuid ?? sha256(feedId + audioUrl);

  return {
    episode_id: episodeId,
    feed_id: feedId,
    guid: rssGuid ?? episodeId,
    title: text(item.title) ?? "",
    description: text(item.description),
    published_at: publishedAt,
    audio_url: audioUrl,
    audio_type: text(item.enclosureType),
    audio_bytes: whole(item.enclosureLength),
    duration_sec: whole(item.duration),
    episode_url: text(item.link),
    season: whole(item.season),
    episode_n: whole(item.episode),
    observed_at: observedAt,
  };
}

/** Hex SHA-256 of the rss URL. The same input the RSS connector hashes. */
function feedKey(rssUrl: string): string | null {
  return rssUrl === "" ? null : sha256(rssUrl);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function accepted(status: unknown): boolean {
  return status !== false && status !== "false";
}

function text(value: string | undefined): string | null {
  return value || null;
}

function whole(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function unixIso(value: number | undefined): string | null {
  const time = whole(value);

  return time === null ? null : new Date(time * 1000).toISOString();
}
