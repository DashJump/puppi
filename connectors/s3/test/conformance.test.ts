import { assertConformant, runStorageConformance } from "@puppi/conformance";
import { describe, expect, it } from "vitest";

import { Client } from "../src/index.js";

/**
 * The whole suite against an in-memory S3: the verbs are exercised through
 * the adapter rather than asserted one at a time, which is what catches a
 * write that does not keep each ref.
 */
function fakeS3() {
  const objects = new Map<string, Uint8Array>();

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    // Path style: the bucket is the first segment, and a key is what follows
    // it. A listing answers with keys relative to the bucket, as S3 does.
    const key = decodeURIComponent(url.pathname).replace(/^\/lake\/?/, "");
    const method = init?.method ?? "GET";

    if (method === "PUT") {
      objects.set(key, init?.body as Uint8Array);
      return new Response(null, { status: 200 });
    }

    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }

    if (url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const contents = [...objects.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => `<Contents><Key>${name}</Key></Contents>`)
        .join("");

      return new Response(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        {
          status: 200,
        },
      );
    }

    const bytes = objects.get(key);

    return bytes ? new Response(bytes, { status: 200 }) : new Response("", { status: 404 });
  }) as typeof fetch;

  return { objects, fetchImpl };
}

describe("the s3 adapter", () => {
  it("does everything it declares", async () => {
    const { objects, fetchImpl } = fakeS3();
    const adapter = new Client(
      { bucket: "lake", endpoint: "http://127.0.0.1:9000" },
      { access_key_id: "AKID", secret_access_key: "SECRET" },
      { fetch: fetchImpl },
    );

    const checks = await runStorageConformance({
      adapter,
      prefix: "conformance",
      sharedDigest: true,
    });

    assertConformant(checks);
    expect(checks.filter((check) => check.status === "skipped")).toEqual([]);
    // drop_prefix ran last and emptied everything the suite wrote.
    expect([...objects.keys()]).toEqual([]);
  }, 30_000);
});
