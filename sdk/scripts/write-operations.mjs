#!/usr/bin/env node
/**
 * Writes `src/operations.ts` from a pinned OpenAPI document.
 *
 * The operation table is paths and query parameters. A list's page rule
 * lives on the client method that walks it, so this script does not load
 * `define.ts` and does not infer a list from the document.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { classifyOperations, operationsModule } from "../dist/http/openapi.js";

const [specPath, outPath] = process.argv.slice(2);

if (!specPath || !outPath) {
  throw new Error("usage: write-operations <openapi.json> <src/operations.ts>");
}

const spec = JSON.parse(readFileSync(specPath, "utf8"));

writeFileSync(outPath, operationsModule(classifyOperations(spec)));
