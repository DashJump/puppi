#!/usr/bin/env node
/**
 * Copies `bin/puppi.js` into `dist` and rewrites its import. The published
 * package ships `dist` only, so the bin has to load `./index.js` from there.
 * `bin/puppi.js` stays the checked-in wrapper, which imports `../dist/index.js`.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const source = new URL("../bin/puppi.js", import.meta.url);
const target = new URL("../dist/puppi.js", import.meta.url);
const text = readFileSync(source, "utf8").replaceAll(
  'from "../dist/index.js"',
  'from "./index.js"',
);

if (!text.includes('from "./index.js"') || text.includes("../dist/")) {
  throw new Error("stage-bin: the puppi bin import was not rewritten");
}

writeFileSync(target, text);
chmodSync(target, 0o755);
