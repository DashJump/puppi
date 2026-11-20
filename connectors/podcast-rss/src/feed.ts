/**
 * RSS 2.0 and Atom 1.0, normalized to the `podcasts/episodes` row.
 * The HTTP client only decodes JSON, so the fetch wrapper rewrites a feed
 * before that decode. `fast-xml-parser` reads the document.
 */

import { XMLParser } from "fast-xml-parser";

/**
 * Fields parsed from one item. `episodes()` adds `episode_id`, `feed_id`,
 * and `observed_at`. Items with no enclosure URL or no parseable publish
 * date are omitted, so `audio_url` and `published_at` are always set.
 * `published_at` is UTC ISO 8601. An empty guid means the item had none.
 */
export interface EpisodeDraft {
  guid: string;
  title: string;
  description: string | null;
  published_at: string;
  audio_url: string;
  audio_type: string | null;
  audio_bytes: number | null;
  duration_sec: number | null;
  episode_url: string | null;
  season: number | null;
  episode_n: number | null;
}

/** One `podcasts/episodes` row. */
export interface Episode extends EpisodeDraft {
  episode_id: string;
  feed_id: string;
  observed_at: string;
}

export interface FeedPage {
  next: string | null;
  episodes: EpisodeDraft[];
}

interface Node {
  qualified: string;
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

interface Media {
  url: string;
  type: string | null;
  length: number | null;
  audio: boolean;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
});

/** `fetch` that turns an RSS or Atom body into the JSON `send` decodes. */
export function normalizeFeedFetch(inner: typeof fetch): typeof fetch {
  const wrapped: typeof fetch = async (input, init) => {
    const response = await inner(input, init);

    if (!response.ok) return response;

    const body = new Uint8Array(await response.arrayBuffer());
    const raw = decodeFeed(body, response.headers.get("content-type"));
    const trimmed = raw.replace(/^\uFEFF/, "").trimStart();

    if (!trimmed.startsWith("<")) {
      return new Response(raw, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const url = requestUrl(input);

    let page: FeedPage;

    try {
      page = parseFeed(trimmed, url);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      throw new Error(`podcast-rss could not parse ${url}: ${detail}`, { cause: error });
    }

    return new Response(JSON.stringify(page), {
      status: response.status,
      statusText: response.statusText,
      headers: { "content-type": "application/json" },
    });
  };

  return wrapped;
}

/**
 * Decodes the feed body for the `<` check and the XML parser.
 * A BOM wins, then the Content-Type charset, then `encoding` on the XML
 * declaration, then UTF-8. TextDecoder throws on an unknown label, and
 * this wrapper has no log, so that label is read as UTF-8.
 */
function decodeFeed(body: Uint8Array, contentType: string | null): string {
  const label = bomEncoding(body) ?? charsetOf(contentType) ?? declaredEncoding(body) ?? "utf-8";

  try {
    return new TextDecoder(label).decode(body);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;

    return new TextDecoder("utf-8").decode(body);
  }
}

function bomEncoding(body: Uint8Array): string | null {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return "utf-8";
  }

  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return "utf-16le";
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return "utf-16be";

  return null;
}

function charsetOf(contentType: string | null): string | null {
  if (!contentType) return null;

  const match = /;\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(contentType);
  const label = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();

  if (!label) return null;

  return label;
}

/**
 * Reads the charset named by the XML declaration.
 * The declaration is ASCII, so the sniff stops at the first high byte
 * and does not assume the charset it is trying to discover.
 */
function declaredEncoding(body: Uint8Array): string | null {
  const limit = Math.min(body.length, 256);
  const codes: number[] = [];

  for (let index = 0; index < limit; index++) {
    const byte = body[index];

    if (byte === undefined || byte > 0x7f) break;

    codes.push(byte);
  }

  const head = String.fromCharCode(...codes);
  const match = /^<\?xml\s[^?]*?\sencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(head);
  const label = (match?.[1] ?? match?.[2])?.trim();

  if (!label) return null;

  return label;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;

  return input.url;
}

function parseFeed(xml: string, pageUrl: string): FeedPage {
  const root = parseXml(xml);

  if (root.name !== "rss" && root.name !== "feed" && root.name !== "RDF") {
    throw new Error(`unsupported root <${root.qualified}>`);
  }

  const { meta, items } = entries(root);
  const href = nextHref(meta);

  return {
    next: href ? absolute(href, pageUrl) : null,
    episodes: items.flatMap((item) => {
      const episode = episodeFrom(item);

      return episode === null ? [] : [episode];
    }),
  };
}

export function isFeedPage(body: unknown): body is FeedPage {
  return (
    body !== null && typeof body === "object" && "episodes" in body && Array.isArray(body.episodes)
  );
}

function episodeFrom(item: Node): EpisodeDraft | null {
  const media = pickAudio(mediasOf(item));
  const published = publishedOf(item);

  if (!media?.url || published === null) return null;

  return {
    guid: textNamed(item, "guid") ?? textNamed(item, "id") ?? "",
    title: textNamed(item, "title") ?? "",
    description:
      textNamed(item, "encoded") ?? textNamed(item, "description") ?? textNamed(item, "summary"),
    published_at: published,
    audio_url: media.url,
    audio_type: media.type,
    audio_bytes: media.length,
    duration_sec: durationSec(textNamed(item, "duration")),
    episode_url: linkOf(item),
    season: whole(textNamed(item, "season")),
    episode_n: whole(textNamed(item, "episode")),
  };
}

function entries(root: Node): { meta: Node; items: Node[] } {
  if (root.name === "feed") return { meta: root, items: children(root, "entry") };

  const channel = root.children.find((child) => child.name === "channel");
  const meta = channel ?? root;
  const items = children(meta, "item");

  if (channel) {
    for (const item of children(root, "item")) {
      if (!items.includes(item)) items.push(item);
    }
  }

  return { meta, items };
}

function publishedOf(item: Node): string | null {
  for (const name of ["pubDate", "published", "updated", "date"]) {
    const text = textNamed(item, name);

    if (text) return publishedAt(text);
  }

  return null;
}

function publishedAt(value: string): string | null {
  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) return null;

  return new Date(parsed).toISOString();
}

function durationSec(value: string | null): number | null {
  if (!value) return null;

  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const parts = trimmed.split(":");

  if (parts.length !== 2 && parts.length !== 3) return null;

  const numbers = parts.map((part) => Number(part));

  if (numbers.some((part) => !Number.isInteger(part) || part < 0)) return null;

  const seconds = numbers.at(-1);
  const minutes = numbers.at(-2);
  const hours = numbers.length === 3 ? numbers[0] : 0;

  if (seconds === undefined || minutes === undefined || hours === undefined) return null;

  return hours * 3600 + minutes * 60 + seconds;
}

function whole(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;

  return Number(value.trim());
}

function linkOf(item: Node): string | null {
  for (const child of item.children) {
    if (child.name !== "link" || child.attrs["rel"] === "enclosure") continue;

    const href = child.attrs["href"];

    if (href && (child.attrs["rel"] === undefined || child.attrs["rel"] === "alternate")) {
      return href;
    }

    const text = textOf(child);

    if (text && !href) return text;
  }

  return null;
}

function mediasOf(item: Node): Media[] {
  const found: Media[] = [];

  for (const child of item.children) {
    if (child.name === "enclosure" && child.attrs["url"]) {
      found.push(toMedia(child.attrs["url"], child.attrs["type"], child.attrs["length"]));
    } else if (child.name === "link" && child.attrs["rel"] === "enclosure" && child.attrs["href"]) {
      found.push(toMedia(child.attrs["href"], child.attrs["type"], child.attrs["length"]));
    } else if (child.name === "content" && child.attrs["url"] && isAudioMedium(child)) {
      found.push(
        toMedia(
          child.attrs["url"],
          child.attrs["type"],
          child.attrs["fileSize"] ?? child.attrs["length"],
        ),
      );
    }
  }

  return found;
}

function isAudioMedium(node: Node): boolean {
  const type = node.attrs["type"];

  return node.attrs["medium"] === "audio" || (type !== undefined && type.startsWith("audio/"));
}

function toMedia(url: string, type: string | undefined, length: string | undefined): Media {
  return {
    url,
    type: type ?? null,
    length: bytes(length),
    audio: type !== undefined && type.startsWith("audio/"),
  };
}

function pickAudio(medias: Media[]): Media | null {
  return medias.find((media) => media.audio) ?? medias[0] ?? null;
}

function bytes(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nextHref(node: Node): string | null {
  for (const child of node.children) {
    if (child.name === "link" && child.attrs["rel"] === "next" && child.attrs["href"]) {
      return child.attrs["href"];
    }
  }

  return null;
}

function absolute(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function textNamed(node: Node, name: string): string | null {
  const exact = node.children.find((child) => child.qualified === name);
  const any = node.children.find((child) => child.name === name);

  return textOf(exact ?? any);
}

function children(node: Node, name: string): Node[] {
  return node.children.filter((child) => child.name === name);
}

function textOf(node: Node | undefined): string | null {
  if (!node) return null;

  const parts: string[] = [];

  collect(node, parts);

  const text = parts.join("").replace(/\s+/g, " ").trim();

  return text === "" ? null : text;
}

function collect(node: Node, parts: string[]): void {
  if (node.text) parts.push(node.text);

  for (const child of node.children) collect(child, parts);
}

function parseXml(xml: string): Node {
  const parsed: unknown = parser.parse(xml);

  if (!isRecord(parsed)) throw new Error("feed has no root element");

  const rootName = Object.keys(parsed).find((key) => key !== "?xml");
  const root = rootName === undefined ? undefined : parsed[rootName];

  if (rootName === undefined || root === undefined) throw new Error("feed has no root element");

  return toNode(rootName, root);
}

function toNode(qualified: string, value: unknown): Node {
  const name = local(qualified);

  if (!isRecord(value)) {
    return { qualified, name, attrs: {}, children: [], text: textValue(value) };
  }

  const attrs: Record<string, string> = {};
  const nodes: Node[] = [];
  let text = "";

  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("@_")) {
      attrs[local(key.slice(2))] = textValue(child);
      continue;
    }

    if (key === "#text") {
      text += textValue(child);
      continue;
    }

    for (const one of Array.isArray(child) ? child : [child]) nodes.push(toNode(key, one));
  }

  return { qualified, name, attrs, children: nodes, text };
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function local(qualified: string): string {
  const index = qualified.indexOf(":");

  return index === -1 ? qualified : qualified.slice(index + 1);
}
