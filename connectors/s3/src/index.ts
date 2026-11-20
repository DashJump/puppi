/**
 * `@puppi/adapter-s3`: Parquet tables and files on S3-compatible storage.
 * Config: `bucket`, `region` (`us-east-1`, or `auto` on R2), optional
 * `endpoint` (MinIO and R2), optional `prefix` (file keys only), and
 * `force_path_style`. Secrets: `access_key_id`, `secret_access_key`, and an
 * optional `session_token`. Tables are one Parquet object per materialization.
 * Files are `ObjectStorage`: `put`, `get`, `head`, `drop`, plus `putStream`
 * and `keyFor`. Both are signed with the one SigV4.
 */

import { type ObjectStore, ObjectStorageAdapter, parseStorageRef } from "@puppi/adapter-storage";
import { read, write, type ObjectHead, type ObjectStorage, type PutObjectResult } from "@puppi/sdk";

import connector from "./define.js";
import { S3Objects, type PutStreamOptions, type PutStreamResult } from "./files.js";
import { type Credentials, encode, sha256, sign } from "./sigv4.js";

export default connector;

export { type Credentials, sign } from "./sigv4.js";

export const DEFAULT_REGION = "us-east-1";

export interface S3Config {
  bucket: string;
  region: string;
  /** `https://s3.<region>.amazonaws.com` unless set; MinIO and R2 set it. */
  endpoint: string;
  /**
   * `<endpoint>/<bucket>/<key>` rather than `<bucket>.<endpoint>/<key>`.
   * On by default when an endpoint is given, since emulators and most
   * self-hosted stores need it; explicit either way.
   */
  forcePathStyle: boolean;
  /** Prepended to file keys. Parquet objects do not use it. */
  prefix: string;
}

/** What a store needs beyond its binding: a `fetch` to inject in tests, and a clock for the signature. */
export interface StoreOptions {
  fetch?: typeof fetch;
  now?: () => Date;
}

const EMPTY_SHA256 = sha256("");

export class S3Store implements ObjectStore {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  /** The bucket's URL without a trailing slash: objects live under it. */
  private readonly base: string;

  constructor(
    readonly config: S3Config,
    private readonly credentials: Credentials,
    options: StoreOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());

    const endpoint = new URL(config.endpoint);

    this.base = config.forcePathStyle
      ? `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}/${config.bucket}`
      : `${endpoint.protocol}//${config.bucket}.${endpoint.host}`;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const response = await this.request("PUT", key, {
      body: bytes,
      headers: { "content-type": "application/vnd.apache.parquet" },
    });

    await response.body?.cancel();
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.request("GET", key, { allow: [404] });

    if (response.status === 404) {
      await response.body?.cancel();
      throw new Error(`nothing at ${key} in bucket ${this.config.bucket}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  /** S3 answers 204 whether or not the key existed. */
  async delete(key: string): Promise<void> {
    const response = await this.request("DELETE", key, { allow: [404] });

    await response.body?.cancel();
  }

  /** ListObjectsV2, following continuation tokens until the listing is complete. */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;

    do {
      const query: Record<string, string> = { "list-type": "2", prefix };

      if (token) query["continuation-token"] = token;

      const response = await this.request("GET", "", { query });
      const xml = await response.text();

      for (const match of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]*)<\/Key>/g)) {
        keys.push(unescapeXml(match[1] ?? ""));
      }

      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? unescapeXml(
            /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "",
          )
        : undefined;
    } while (token);

    return keys;
  }

  /**
   * One signed request. A non-2xx answer outside `allow` becomes an error
   * with a numeric `status`, which is what classification reads: 502, 503,
   * 504 and 429 are retried, anything else fails the attempt. The message
   * still names the status. A network failure says `unreachable`.
   */
  private async request(
    method: "GET" | "PUT" | "DELETE",
    key: string,
    options: {
      body?: Uint8Array;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      allow?: number[];
    } = {},
  ): Promise<Response> {
    const url = `${this.base}${objectPath(key)}${queryString(options.query)}`;
    const headers = sign(
      {
        method,
        url,
        body: options.body ?? new Uint8Array(),
        headers: {
          ...options.headers,
          "x-amz-content-sha256": options.body ? sha256(options.body) : EMPTY_SHA256,
        },
      },
      { region: this.config.region, service: "s3", credentials: this.credentials, now: this.now() },
    );
    const response = await this.send(url, { method, headers, body: options.body });

    if (response.ok || options.allow?.includes(response.status)) return response;

    throw await refusal(response, `${method} ${key || "list"}`, this.config.bucket);
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      throw new Error(`s3 unreachable at ${url}: ${message}`, { cause: error });
    }
  }
}

/** Each segment of the key encoded, or `/` for a request against the bucket itself. */
function objectPath(key: string): string {
  return key ? `/${key.split("/").map(encode).join("/")}` : "/";
}

/** Sorted, so the query a signature covers is the query that is sent. */
function queryString(query: Record<string, string> | undefined): string {
  if (!query) return "";

  const pairs = Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, value]) => `${encode(name)}=${encode(value)}`);

  return `?${pairs.join("&")}`;
}

async function refusal(response: Response, what: string, bucket: string): Promise<Error> {
  const detail = (await response.text().catch(() => "")).slice(0, 200);

  return Object.assign(
    new Error(
      `s3 answered ${response.status} ${response.statusText} for ${what} in bucket ${bucket}` +
        (detail ? `: ${detail}` : ""),
    ),
    { status: response.status },
  );
}

function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#(\d+));/g, (_, name: string, code?: string) =>
    code
      ? String.fromCodePoint(Number(code))
      : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[name]!,
  );
}

/** The binding's config and secrets, checked and defaulted. */
export function configure(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): { config: S3Config; credentials: Credentials } {
  const bucket = config["bucket"];
  const accessKeyId = secrets["access_key_id"];
  const secretAccessKey = secrets["secret_access_key"];

  if (typeof bucket !== "string" || !bucket) {
    throw new Error(`an s3 connection needs "bucket" in its config`);
  }

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `an s3 connection needs "access_key_id" and "secret_access_key" in its secrets`,
    );
  }

  const region = typeof config["region"] === "string" ? config["region"] : DEFAULT_REGION;
  const endpoint = typeof config["endpoint"] === "string" ? config["endpoint"] : undefined;
  const forcePathStyle = config["force_path_style"];
  const prefix = (typeof config["prefix"] === "string" ? config["prefix"].trim() : "").replace(
    /^\/+|\/+$/g,
    "",
  );

  return {
    config: {
      bucket,
      region,
      endpoint: endpoint ?? `https://s3.${region}.amazonaws.com`,
      forcePathStyle: typeof forcePathStyle === "boolean" ? forcePathStyle : endpoint !== undefined,
      prefix,
    },
    credentials: { accessKeyId, secretAccessKey, sessionToken: secrets["session_token"] },
  };
}

/** The `s3` connection: a Parquet table store and an `ObjectStorage` for files. */
export class Client extends ObjectStorageAdapter implements ObjectStorage {
  private readonly objects: S3Objects;

  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: StoreOptions = {},
  ) {
    const checked = configure(config, secrets);

    super(new S3Store(checked.config, checked.credentials, options), connector.type);
    this.objects = new S3Objects(
      checked.config,
      checked.credentials,
      stringValue(config["endpoint"]),
      options,
    );
  }

  /** The object key, with the binding's prefix. */
  @read
  keyFor(key: string): string {
    return this.objects.keyFor(key);
  }

  /** Stores one object at the storage ref. `ctx.emitFile` calls this. */
  @write
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: { contentType?: string | null } = {},
  ): Promise<PutObjectResult> {
    return this.objects.put(key, body, options);
  }

  /** The object's bytes. A missing object throws. */
  @read
  get(key: string): Promise<ReadableStream<Uint8Array>> {
    return this.objects.get(key);
  }

  /** The object's size and type, or null when there is none. */
  @read
  head(key: string): Promise<ObjectHead | null> {
    return this.objects.head(key);
  }

  @read
  exists(key: string): Promise<boolean> {
    return this.objects.exists(key);
  }

  /**
   * Streams `body` into the bucket. Under 8 MiB is one PUT. Above that is
   * multipart, one part in memory, aborted when anything fails.
   */
  @write
  putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: PutStreamOptions = {},
  ): Promise<PutStreamResult> {
    return this.objects.putStream(key, body, options);
  }

  /**
   * Deletes the file at `keyFor(key)`. A storage ref is also a table
   * materialization: that object, its pages, and a leftover commit marker
   * go too. A file key that is not a storage ref only deletes the file.
   */
  @write
  override async drop(key: string, options?: { pages?: boolean }): Promise<void> {
    await this.objects.drop(key);

    if (isTableRef(key)) await super.drop(key, options);
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isTableRef(key: string): boolean {
  try {
    parseStorageRef(key);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("malformed storage_ref:")) return false;

    throw error;
  }
}
