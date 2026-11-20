import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "rolldown";
import { describe, expect, it } from "vite-plus/test";

/**
 * `puppi build` bundles with rolldown `output.file` (cli/src/bundle.ts).
 * A dependency that dynamically `import()`s fails that build with
 * "the output.dir option must be used". `@aws-sdk/client-s3` does.
 *
 * The input is the built module. Rolldown leaves a standard decorator in
 * the output, and Node cannot parse that. A pipeline inlines this entry.
 */
describe("puppi build path", () => {
  it("bundles the client to one file and the class still heads an object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "s3-bundle-"));
    const outFile = join(dir, "bundle.js");

    try {
      await build({
        input: new URL("../dist/index.js", import.meta.url).pathname,
        platform: "node",
        output: { file: outFile, format: "esm", sourcemap: true },
        write: true,
      });

      const files = (await readdir(dir)).filter((name) => name.endsWith(".js"));
      expect(files).toEqual(["bundle.js"]);

      const bundled = (await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)) as {
        default: { type: string; secretFields: readonly string[] };
        Client: new (
          config: Record<string, unknown>,
          secrets: Record<string, string>,
          options: { fetch: typeof fetch },
        ) => { head(key: string): Promise<unknown> };
      };

      expect(bundled.default.type).toBe("s3");
      expect(bundled.default.secretFields).toEqual([
        "access_key_id",
        "secret_access_key",
        "session_token",
      ]);

      const store = new bundled.Client(
        { bucket: "podcasts", region: "us-east-1", endpoint: "http://127.0.0.1:9" },
        { access_key_id: "testaccess", secret_access_key: "testsecret" },
        { fetch: async () => new Response(null, { status: 404 }) },
      );

      expect(await store.head("missing")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
