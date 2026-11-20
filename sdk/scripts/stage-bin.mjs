#!/usr/bin/env node
/**
 * Copies `write-operations.mjs` into `dist` and rewrites its import. The
 * published bin is `dist/write-operations.js`, and that file loads
 * `./http/openapi.js` beside it. The script under `scripts/` imports
 * `../dist/http/openapi.js` so `pnpm generate` in this repo can run it
 * before the copy exists.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const source = new URL("./write-operations.mjs", import.meta.url);
const target = new URL("../dist/write-operations.js", import.meta.url);
const text = readFileSync(source, "utf8").replaceAll(
  'from "../dist/http/openapi.js"',
  'from "./http/openapi.js"',
);

if (!text.includes('from "./http/openapi.js"') || text.includes("../dist/")) {
  throw new Error("stage-bin: the write-operations import was not rewritten");
}

writeFileSync(target, text);
chmodSync(target, 0o755);
