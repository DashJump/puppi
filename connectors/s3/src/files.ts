/**
 * Files in the same bucket as the Parquet store. `put`, `get`, `head`, and
 * `drop` are `ObjectStorage`. `putStream` is the upload underneath: one PUT
 * under 8 MiB, multipart above that, hashed while the body is read. `keyFor`
 * prepends the binding prefix. The table store does not use that prefix.
 *
 * Signed with the package SigV4. An endpoint (R2, MinIO) is path-style.
 * With no endpoint the client uses virtual-hosted AWS. `region` is `auto`
 * on R2 and `us-east-1` otherwise.
 */

import { createHash } from "node:crypto";

import { HttpStatusError, userAgentFor } from "@puppi/sdk";

import { type Credentials, encode, sha256, sign } from "./sigv4.js";

export interface FileOptions {
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface PutStreamOptions {
  contentType?: string | null;
  /** A size hint, such as an RSS enclosure length. Only picks the part size. */
  contentLength?: number | null;
}

export interface PutStreamResult {
  bytes: number;
  sha256: string;
  etag: string | null;
}

const MIB = 1024 * 1024;
/** S3's minimum part is 5 MiB, except the last. One part stays in memory. */
const PART = 8 * MIB;
const MAX_PARTS = 10_000;
/** One try plus three retries. The body is buffered, so a retry sends the same bytes. */
const ATTEMPTS = 4;
const RETRY_MS = 50;
const USER_AGENT = userAgentFor("s3");

interface SignedRequest {
  method: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export class S3Objects {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  /** Bucket URL with no trailing slash. Objects live under it. */
  private readonly base: string;

  constructor(
    private readonly config: { bucket: string; region: string; prefix: string },
    private readonly credentials: Credentials,
    endpoint: string | null,
    options: FileOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    // Path style when the binding sets an endpoint (R2, MinIO). Virtual-hosted on AWS.
    this.base = endpoint
      ? `${endpoint.replace(/\/+$/, "")}/${encode(config.bucket)}`
      : `https://${config.bucket}.s3.${config.region}.amazonaws.com`;
  }

  /** The object key, with the binding's prefix. */
  keyFor(key: string): string {
    return this.config.prefix ? `${this.config.prefix}/${key}` : key;
  }

  /**
   * Stores one object at the storage ref and hashes it on the way.
   * The key is prefixed the same way `head` prefixes it. `ctx.emitFile` calls this.
   */
  async put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: { contentType?: string | null } = {},
  ): Promise<{ sha256: string; bytes: number; contentType: string | null }> {
    const contentType = options.contentType ?? "application/octet-stream";
    const put = await this.putStream(key, body, { contentType });

    return { sha256: put.sha256, bytes: put.bytes, contentType };
  }

  /** The object's bytes. A missing object throws. */
  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.send(this.url(key), { method: "GET" });

    if (response.status === 404) {
      await response.body?.cancel();
      throw new Error(`nothing at ${this.keyFor(key)}`);
    }

    if (!response.ok || !response.body) throw await refused(`GET ${this.keyFor(key)}`, response);

    return response.body;
  }

  /** Deletes the object. A missing object is already gone. */
  async drop(key: string): Promise<void> {
    const response = await this.send(this.url(key), { method: "DELETE" });

    if (response.ok || response.status === 404) {
      await response.body?.cancel();
      return;
    }

    throw await refused(`DELETE ${this.keyFor(key)}`, response);
  }

  /** The object's size and type, or null when there is none. */
  async head(key: string): Promise<{ bytes: number | null; contentType: string | null } | null> {
    const response = await this.send(this.url(key), { method: "HEAD" });

    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }

    if (!response.ok) throw await refused(`HEAD ${this.keyFor(key)}`, response);

    await response.body?.cancel();
    const raw = response.headers.get("content-length");
    const length = raw === null ? Number.NaN : Number(raw);

    return {
      bytes: Number.isFinite(length) ? length : null,
      contentType: response.headers.get("content-type"),
    };
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  /**
   * Streams `body` into the bucket and hashes it on the way. At most one
   * part is held. A body smaller than one part is a single PUT. Anything
   * larger is a multipart upload, which appears only once it completes and
   * is aborted when anything fails.
   */
  async putStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: PutStreamOptions = {},
  ): Promise<PutStreamResult> {
    const partSize = partSizeFor(options.contentLength ?? null);
    const contentType = options.contentType ?? "application/octet-stream";
    const hash = createHash("sha256");
    const reader = body.getReader();
    let bytes = 0;
    let buffer: Uint8Array[] = [];
    let buffered = 0;
    let uploadId: string | null = null;
    const parts: { number: number; etag: string }[] = [];

    const flush = async (): Promise<void> => {
      const part = concat(buffer, buffered);
      buffer = [];
      buffered = 0;

      if (uploadId === null) uploadId = await this.createMultipart(key, contentType);

      const number = parts.length + 1;
      const etag = await this.uploadPart(key, uploadId, number, part);
      parts.push({ number, etag });
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;
        if (!value) continue;

        hash.update(value);
        bytes += value.length;

        let offset = 0;

        while (offset < value.length) {
          const end = offset + Math.min(partSize - buffered, value.length - offset);
          const slice = value.subarray(offset, end);
          buffer.push(slice);
          buffered += slice.length;
          offset = end;

          if (buffered >= partSize) await flush();
        }
      }

      if (uploadId === null) {
        const response = await this.send(this.url(key), {
          method: "PUT",
          headers: { "content-type": contentType },
          body: concat(buffer, buffered),
        });

        if (!response.ok) throw await refused(`PUT ${this.keyFor(key)}`, response);

        const etag = response.headers.get("etag");
        await response.body?.cancel();

        return { bytes, sha256: hash.digest("hex"), etag };
      }

      if (buffered > 0) await flush();

      return {
        bytes,
        sha256: hash.digest("hex"),
        etag: await this.completeMultipart(key, uploadId, parts),
      };
    } catch (error) {
      await reader.cancel().catch(() => undefined);

      if (uploadId !== null) await this.abortMultipart(key, uploadId).catch(() => undefined);

      throw error;
    }
  }

  private url(key: string, query: Record<string, string> = {}): string {
    const path = this.keyFor(key).split("/").map(encode).join("/");
    const search = Object.entries(query)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([name, value]) => `${encode(name)}=${encode(value)}`)
      .join("&");

    return `${this.base}/${path}${search ? `?${search}` : ""}`;
  }

  /**
   * One signed request. 429, 5xx, and a dropped connection are tried again,
   * up to three extra times, because the body is already buffered. The last
   * response is returned so the caller can throw with its status. A redirect
   * is not followed: the signature would not cover the next host.
   */
  private async send(url: string, init: SignedRequest): Promise<Response> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const payload = init.body ?? new Uint8Array();
      const headers = sign(
        {
          method: init.method,
          url,
          body: payload,
          headers: {
            ...init.headers,
            "user-agent": USER_AGENT,
            "x-amz-content-sha256": sha256(payload),
          },
        },
        {
          region: this.config.region,
          service: "s3",
          credentials: this.credentials,
          now: this.now(),
        },
      );

      try {
        const response = await this.fetchImpl(url, {
          method: init.method,
          headers,
          body: init.body,
          redirect: "manual",
        });

        if ((response.status < 500 && response.status !== 429) || attempt === ATTEMPTS - 1) {
          return response;
        }

        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (attempt === ATTEMPTS - 1) throw unreachable(error);
      }

      await delay(Math.random() * RETRY_MS * 2 ** attempt);
    }

    throw unreachable(new Error("retries exhausted"));
  }

  private async createMultipart(key: string, contentType: string): Promise<string> {
    const response = await this.send(this.url(key, { uploads: "" }), {
      method: "POST",
      headers: { "content-type": contentType },
    });
    const xml = await response.text();
    const id = xmlTag(xml, "UploadId");

    if (!response.ok || !id) {
      throw new HttpStatusError(
        "s3",
        response.status,
        response.statusText,
        `create upload for ${this.keyFor(key)}`,
        xml.slice(0, 300),
        response.headers,
      );
    }

    return id;
  }

  private async uploadPart(
    key: string,
    uploadId: string,
    number: number,
    part: Uint8Array,
  ): Promise<string> {
    const response = await this.send(this.url(key, { partNumber: String(number), uploadId }), {
      method: "PUT",
      body: part,
    });
    const etag = response.headers.get("etag");

    if (!response.ok || !etag) {
      throw await refused(`part ${number} of ${this.keyFor(key)}`, response);
    }

    await response.body?.cancel();

    return etag;
  }

  private async completeMultipart(
    key: string,
    uploadId: string,
    parts: { number: number; etag: string }[],
  ): Promise<string | null> {
    const xml =
      "<CompleteMultipartUpload>" +
      parts
        .map(
          (part) =>
            `<Part><PartNumber>${part.number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
        )
        .join("") +
      "</CompleteMultipartUpload>";
    const response = await this.send(this.url(key, { uploadId }), {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: xml,
    });
    const answer = await response.text();

    // S3 can answer 200 with an <Error> body. The object was not committed.
    // InternalError and SlowDown on that 200 are retried; any other code keeps its status.
    if (!response.ok || /<Error[\s>]/.test(answer)) {
      const code = xmlTag(answer, "Code");
      const status =
        response.ok && (code === "InternalError" || code === "SlowDown") ? 500 : response.status;

      throw new HttpStatusError(
        "s3",
        status,
        response.statusText,
        `complete upload of ${this.keyFor(key)}`,
        answer.slice(0, 300),
        response.headers,
      );
    }

    return xmlTag(answer, "ETag");
  }

  private async abortMultipart(key: string, uploadId: string): Promise<void> {
    const response = await this.send(this.url(key, { uploadId }), { method: "DELETE" });

    await response.body?.cancel();
  }
}

function partSizeFor(hint: number | null): number {
  if (!hint || hint <= 0) return PART;

  return Math.max(PART, Math.ceil(hint / MAX_PARTS));
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
}

function xmlTag(xml: string, tag: string): string | null {
  const value = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];

  return value ? unescapeXml(value) : null;
}

function unescapeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function httpError(what: string, response: Response, body: string): HttpStatusError {
  return new HttpStatusError(
    "s3",
    response.status,
    response.statusText,
    what,
    body.slice(0, 300),
    response.headers,
  );
}

async function refused(what: string, response: Response): Promise<HttpStatusError> {
  const body = await response.text().catch(() => "");

  return httpError(what, response, body);
}

function unreachable(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  return new Error(`s3 unreachable: ${message}`, { cause: error });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
