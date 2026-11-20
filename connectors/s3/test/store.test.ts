import { describe, expect, it } from "vite-plus/test";

import { Client, configure, S3Store } from "../src/index.js";
import { sha256 } from "../src/sigv4.js";

/**
 * The four verbs against a scripted server: what was sent, and what each
 * answer turns into. Nothing here touches the network.
 */
interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

function fake(handler: (call: Call) => Response) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(input instanceof Request ? input.url : String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body instanceof Uint8Array ? init.body : null,
    };

    calls.push(call);

    return handler(call);
  }) as typeof fetch;

  return { calls, fetchImpl };
}

const credentials = { accessKeyId: "AKID", secretAccessKey: "SECRET" };
const now = () => new Date("2026-09-17T10:00:00Z");

function store(
  handler: (call: Call) => Response,
  config: Partial<Parameters<typeof configure>[0]> = {},
) {
  const { calls, fetchImpl } = fake(handler);
  const checked = configure(
    { bucket: "lake", region: "eu-west-1", ...config },
    {
      access_key_id: credentials.accessKeyId,
      secret_access_key: credentials.secretAccessKey,
    },
  );

  return {
    calls,
    store: new S3Store(checked.config, checked.credentials, { fetch: fetchImpl, now }),
  };
}

describe("the s3 store", () => {
  it("PUTs the bytes, signed with their digest, under the virtual-hosted bucket url", async () => {
    const { calls, store: s3 } = store(() => new Response(null, { status: 200 }));
    const bytes = new Uint8Array([1, 2, 3]);

    await s3.put("prod/a.parquet", bytes);

    const [call] = calls;
    expect(call?.method).toBe("PUT");
    expect(call?.url.href).toBe("https://lake.s3.eu-west-1.amazonaws.com/prod/a.parquet");
    expect(call?.body).toBe(bytes);
    expect(call?.headers["x-amz-content-sha256"]).toBe(sha256(bytes));
    expect(call?.headers["x-amz-date"]).toBe("20260917T100000Z");
    expect(call?.headers["authorization"]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20260917\/eu-west-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it("uses path-style urls for a custom endpoint, or when asked", async () => {
    const minio = store(() => new Response(null, { status: 200 }), {
      endpoint: "http://127.0.0.1:9000",
    });
    await minio.store.put("prod/a.parquet", new Uint8Array());
    expect(minio.calls[0]?.url.href).toBe("http://127.0.0.1:9000/lake/prod/a.parquet");
    expect(minio.calls[0]?.headers["host"]).toBe("127.0.0.1:9000");

    const r2 = store(() => new Response(null, { status: 200 }), {
      endpoint: "https://acct.r2.cloudflarestorage.com",
      force_path_style: false,
    });
    await r2.store.put("prod/a.parquet", new Uint8Array());
    expect(r2.calls[0]?.url.href).toBe("https://lake.acct.r2.cloudflarestorage.com/prod/a.parquet");

    const aws = store(() => new Response(null, { status: 200 }), { force_path_style: true });
    await aws.store.put("prod/a b.parquet", new Uint8Array());
    expect(aws.calls[0]?.url.href).toBe(
      "https://s3.eu-west-1.amazonaws.com/lake/prod/a%20b.parquet",
    );
  });

  it("GETs the bytes back, and names the key when there are none", async () => {
    const { store: s3 } = store((call) =>
      call.url.pathname === "/prod/a.parquet"
        ? new Response(new Uint8Array([7, 8]), { status: 200 })
        : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }),
    );

    expect(await s3.get("prod/a.parquet")).toEqual(new Uint8Array([7, 8]));
    await expect(s3.get("prod/b.parquet")).rejects.toThrow(
      "nothing at prod/b.parquet in bucket lake",
    );
  });

  it("DELETEs, treating a missing key as deleted", async () => {
    const { calls, store: s3 } = store(() => new Response(null, { status: 204 }));

    await s3.delete("prod/a.parquet");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.headers["x-amz-content-sha256"]).toBe(sha256(""));

    const missing = store(() => new Response("", { status: 404 }));
    await expect(missing.store.delete("prod/a.parquet")).resolves.toBeUndefined();
  });

  it("lists with ListObjectsV2, following continuation tokens", async () => {
    const pages: Record<string, string> = {
      "": `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken>
             <Contents><Key>prod/a.parquet</Key><Size>1</Size></Contents>
             <Contents><Key>prod/b&amp;c.parquet</Key></Contents></ListBucketResult>`,
      "t&2": `<ListBucketResult><IsTruncated>false</IsTruncated>
             <Contents><Key>prod/d.parquet</Key></Contents></ListBucketResult>`,
    };
    const { calls, store: s3 } = store(
      (call) =>
        new Response(pages[call.url.searchParams.get("continuation-token") ?? ""], { status: 200 }),
    );

    expect(await s3.list("prod/")).toEqual([
      "prod/a.parquet",
      "prod/b&c.parquet",
      "prod/d.parquet",
    ]);
    expect(calls.map((call) => call.url.href)).toEqual([
      "https://lake.s3.eu-west-1.amazonaws.com/?list-type=2&prefix=prod%2F",
      "https://lake.s3.eu-west-1.amazonaws.com/?continuation-token=t%262&list-type=2&prefix=prod%2F",
    ]);
  });

  it("names the status on a refusal, so the executor can classify it, and unreachable on a network failure", async () => {
    const { store: slow } = store(
      () => new Response("SlowDown", { status: 503, statusText: "Service Unavailable" }),
    );
    await expect(slow.put("prod/a.parquet", new Uint8Array())).rejects.toThrow(
      "s3 answered 503 Service Unavailable for PUT prod/a.parquet in bucket lake: SlowDown",
    );

    const { store: denied } = store(
      () => new Response("AccessDenied", { status: 403, statusText: "Forbidden" }),
    );
    await expect(denied.list("prod/")).rejects.toThrow(/s3 answered 403 Forbidden for GET list/);

    const down = new S3Store(
      configure({ bucket: "lake" }, { access_key_id: "a", secret_access_key: "b" }).config,
      credentials,
      { fetch: (() => Promise.reject(new Error("fetch failed"))) as unknown as typeof fetch },
    );
    await expect(down.get("prod/a.parquet")).rejects.toThrow(/s3 unreachable at .*: fetch failed/);
  });
});

describe("the s3 adapter", () => {
  it("round-trips a materialization through the store", async () => {
    const objects = new Map<string, Uint8Array>();
    const { fetchImpl } = fake((call) => {
      const key = call.url.pathname.slice(1);

      if (call.method === "PUT") {
        objects.set(key, call.body!);
        return new Response(null, { status: 200 });
      }

      const bytes = objects.get(key);
      return bytes ? new Response(bytes, { status: 200 }) : new Response("", { status: 404 });
    });
    const client = new Client(
      { bucket: "lake", endpoint: "http://127.0.0.1:9000" },
      { access_key_id: "AKID", secret_access_key: "SECRET" },
      { fetch: fetchImpl },
    );
    const rows = [{ id: 1, tags: ["x"], nothing: null }];

    const written = await client.write("prod.core_x__abc", rows);

    expect(written.stats.row_count).toBe(1);
    expect([...objects.keys()]).toEqual(["lake/prod/core_x__abc.parquet"]);
    expect(await client.read("prod.core_x__abc")).toEqual(rows);
    await expect(client.query("select 1")).rejects.toThrow(/s3 storage runs no queries/);
  });
});
