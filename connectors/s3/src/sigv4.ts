/**
 * AWS Signature Version 4 for one request, hand-rolled over `node:crypto`,
 * so the adapter carries no AWS SDK. Pure: the time and credentials are
 * arguments, so the signature is testable against the vector AWS publishes.
 */

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

export interface SignOptions {
  region: string;
  service: string;
  credentials: Credentials;
  now?: Date;
}

/**
 * The request's headers plus `host`, `x-amz-date`, `x-amz-security-token`
 * when a session token is given, and `authorization`.
 */
export function sign(request: SignRequest, options: SignOptions): Record<string, string> {
  const now = options.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const url = new URL(request.url);
  const headers: Record<string, string> = { host: hostHeader(url), "x-amz-date": amzDate };

  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;

  if (options.credentials.sessionToken) {
    headers["x-amz-security-token"] = options.credentials.sessionToken;
  }

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method.toUpperCase(),
    url.pathname || "/",
    canonicalQuery(url.search.slice(1)),
    canonicalHeaders,
    signedHeaders,
    sha256(request.body),
  ].join("\n");
  const scope = `${date}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = [date, options.region, options.service, "aws4_request"].reduce<Buffer>(
    (key, part) => hmac(key, part),
    Buffer.from(`AWS4${options.credentials.secretAccessKey}`),
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");

  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${options.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** `host`, or `host:port` when the port is not the scheme's default; `URL` already drops a default port. */
function hostHeader(url: URL): string {
  return url.host;
}

function canonicalQuery(query: string): string {
  if (!query) return "";

  return query
    .split("&")
    .map((pair): [string, string] => {
      const at = pair.indexOf("=");

      return at === -1 ? [pair, ""] : [pair.slice(0, at), pair.slice(at + 1)];
    })
    .sort(([k1, v1], [k2, v2]) => (k1 < k2 ? -1 : k1 > k2 ? 1 : v1 < v2 ? -1 : v1 > v2 ? 1 : 0))
    .map(
      ([key, value]) => `${encode(decodeURIComponent(key))}=${encode(decodeURIComponent(value))}`,
    )
    .join("&");
}

/** RFC 3986 unreserved characters only: what SigV4 calls URI-encoding. */
export function encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}
