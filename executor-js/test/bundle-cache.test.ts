import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { openCache } from "../src/worker/bundle-cache.js";

const body = Buffer.from("export default { adapters: {}, assets: {} };\n");
const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;

describe("bundle cache", () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      ),
    );
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("a 401 on a shared download lets the other token try", async () => {
    const seen: string[] = [];
    const url = await serve((token, response) => {
      seen.push(token);
      if (token === "denied") {
        response.writeHead(401);
        response.end();
        return;
      }
      response.writeHead(200);
      response.end(body);
    });

    const cache = openCache(remember(), url);
    const denied = cache(digest, "denied");
    const allowed = cache(digest, "allowed");

    await expect(denied).rejects.toThrow("bundle download failed with 401");
    await expect(allowed).resolves.toMatch(/\.mjs$/);
    expect(seen).toEqual(["denied", "allowed"]);
  });

  it("a 500 on a shared download fails every waiter", async () => {
    const seen: string[] = [];
    const url = await serve((token, response) => {
      seen.push(token);
      response.writeHead(500);
      response.end();
    });

    const cache = openCache(remember(), url);
    const first = cache(digest, "one");
    const second = cache(digest, "two");

    await expect(first).rejects.toThrow("bundle download failed with 500");
    await expect(second).rejects.toThrow("bundle download failed with 500");
    expect(seen).toEqual(["one"]);
  });

  function remember(): string {
    const root = mkdtempSync(join(tmpdir(), "puppi-cache-"));
    roots.push(root);
    return root;
  }

  function serve(handle: (token: string, response: ServerResponse) => void): Promise<string> {
    const server = createServer((request, response) => {
      const header = request.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      handle(token, response);
    });
    servers.push(server);
    return new Promise((resolveListen) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no port");
        resolveListen(`http://127.0.0.1:${address.port}/bundle`);
      });
    });
  }
});
