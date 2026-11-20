import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { main } from "../src/index.js";
import { buildPaths, parseDefaultStorage } from "../src/project.js";
import { reset, sdk } from "./support/registry.js";

describe("parseDefaultStorage", () => {
  it("keeps a bare connection name as one storage for everything", () => {
    expect(parseDefaultStorage("warehouse")).toBe("warehouse");
  });

  it("keeps a per-role map", () => {
    expect(parseDefaultStorage({ source: "datalake", model: "warehouse" })).toEqual({
      source: "datalake",
      model: "warehouse",
    });
  });

  it("treats empty as unset", () => {
    expect(parseDefaultStorage(undefined)).toBeUndefined();
    expect(parseDefaultStorage("")).toBeUndefined();
    expect(parseDefaultStorage({})).toBeUndefined();
  });

  it("refuses a role that is not a storage default", () => {
    expect(() => parseDefaultStorage({ warehouse: "datalake" })).toThrow(
      /defaultStorage.warehouse is not a role/,
    );
  });

  it("refuses a value that is neither a name nor a map", () => {
    expect(() => parseDefaultStorage(3)).toThrow(/connection name or a map/);
    expect(() => parseDefaultStorage({ source: 1 })).toThrow(/defaultStorage.source must be/);
  });
});

describe("buildPaths", () => {
  let dir: string;

  afterEach(async () => {
    await reset();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads entry and out by evaluating the config, including a function return", async () => {
    dir = await writeConfig(`import { defineConfig } from "@puppi/sdk";

function pipeline() {
  return "src/main.ts";
}

export default defineConfig({
  entry: pipeline(),
  out: "build",
  defaultStorage: "warehouse",
  connections: {},
});
`);

    expect(await buildPaths(dir)).toEqual({
      entry: join(dir, "src/main.ts"),
      out: join(dir, "build"),
      config: join(dir, "puppi.config.ts"),
    });
  });

  it("resolves a path built from import.meta.url", async () => {
    dir = await writeConfig(`import { defineConfig } from "@puppi/sdk";

export default defineConfig({
  entry: new URL("./src/main.ts", import.meta.url).pathname,
  connections: {},
});
`);

    expect((await buildPaths(dir)).entry).toBe(join(dir, "src/main.ts"));
  });

  it("defaults entry and out when the config omits them", async () => {
    dir = await writeConfig(`import { defineConfig } from "@puppi/sdk";
export default defineConfig({ connections: {} });
`);

    expect(await buildPaths(dir)).toEqual({
      entry: join(dir, "src/pipeline.ts"),
      out: join(dir, "dist"),
      config: join(dir, "puppi.config.ts"),
    });
  });

  it("refuses an entry that does not evaluate to a string", async () => {
    dir = await writeConfig(`import { defineConfig } from "@puppi/sdk";
export default defineConfig({ entry: 3, connections: {} });
`);

    await expect(buildPaths(dir)).rejects.toThrow(/entry must be a string/);
  });

  it("refuses a file that does not default-export defineConfig", async () => {
    dir = await writeConfig("export default { entry: 'src/pipeline.ts' };\n");

    await expect(buildPaths(dir)).rejects.toThrow(/default-export defineConfig/);
  });

  it("does not register the config's Client on the CLI's SDK", async () => {
    await reset();
    dir = await writeConfig(`import { defineConfig } from "@puppi/sdk";

class Client {}

export default defineConfig({
  connections: {
    acme: { type: "acme-eval", Client, clientModule: "./src/acme.js" },
  },
});
`);

    await buildPaths(dir);

    expect(sdk.collect().adapters["acme-eval"]).toBeUndefined();
  });
});

async function writeConfig(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "puppi-config-"));

  await writeFile(join(dir, "puppi.config.ts"), source);

  return dir;
}

describe("puppi build with no config it can read", () => {
  let dir: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("names a leftover puppi.config.json instead of reading it", async () => {
    dir = await mkdtemp(join(tmpdir(), "puppi-config-"));
    await writeFile(join(dir, "puppi.config.json"), "{}\n");

    const stderr = capture();

    expect(await main(["build", "--dir", dir])).toBe(1);
    expect(stderr()).toMatch(/puppi.config.json is no longer read/);
  });

  it("says when the project has no config", async () => {
    dir = await mkdtemp(join(tmpdir(), "puppi-config-"));

    const stderr = capture();

    expect(await main(["build", "--dir", dir])).toBe(1);
    expect(stderr()).toMatch(/no puppi.config.ts/);
  });
});

function capture(): () => string {
  let text = "";

  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    text += String(chunk);
    return true;
  });

  return () => text;
}
