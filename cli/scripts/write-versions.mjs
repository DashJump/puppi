#!/usr/bin/env node
/**
 * `src/scaffold-versions.ts` is this script's output. `pnpm build` runs it
 * with `--check`, so a version bump has to rewrite the file before it ships.
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = new URL("../src/scaffold-versions.ts", import.meta.url);

const packages = [
  ["@puppi/cli", new URL("../package.json", import.meta.url)],
  [
    "@puppi/adapter-filesystem",
    new URL("../../connectors/filesystem/package.json", import.meta.url),
  ],
];

const versions = Object.fromEntries(
  packages.map(([name, url]) => {
    const parsed = JSON.parse(readFileSync(url, "utf8"));

    if (parsed.name !== name || typeof parsed.version !== "string" || parsed.version.length === 0) {
      throw new Error(`write-versions: ${url.pathname} is not ${name} with a version`);
    }

    return [name, parsed.version];
  }),
);

const lines = Object.keys(versions)
  .sort()
  .map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(versions[name])},`)
  .join("\n");

const text = `/** Versions \`puppi init\` writes, copied from each package's package.json. */
export const scaffoldVersions: Record<string, string> = {
${lines}
};
`;

if (process.argv.includes("--check")) {
  const current = readFileSync(target, "utf8");

  if (current !== text) {
    throw new Error("src/scaffold-versions.ts is stale. Run node scripts/write-versions.mjs");
  }
} else {
  writeFileSync(target, text);
}
