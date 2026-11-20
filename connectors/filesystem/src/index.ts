/**
 * `@puppi/adapter-filesystem`: Parquet under a local root directory. The
 * binding's config names `root`; the storage ref `<prefix>.<name>` becomes
 * `<root>/<prefix>/<name>.parquet`. Everything about rows, schemas and
 * digests is the storage base's; this package only moves bytes.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { type ObjectStore, ObjectStorageAdapter } from "@puppi/adapter-storage";

import connector from "./define.js";

export default connector;

/**
 * A write lands in a temporary file beside its target and is renamed into
 * place, so a reader never sees a partial object and two writers to one
 * key leave a whole one.
 */
export class FileStore implements ObjectStore {
  constructor(readonly root: string) {}

  private path(key: string): string {
    return join(this.root, ...key.split("/"));
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.path(key);
    const staging = `${target}.${randomUUID()}.tmp`;

    await mkdir(dirname(target), { recursive: true });

    try {
      await writeFile(staging, bytes);
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (error: unknown) {
      if (isMissing(error))
        throw new Error(`nothing at ${key} under ${this.root}`, { cause: error });

      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    // Walk from the deepest directory the prefix fully names, so listing a
    // prefix never reads the whole root.
    const directory = prefix.endsWith("/") ? prefix.slice(0, -1) : dirname(prefix);
    const base = directory === "." ? this.root : this.path(directory);
    let entries: { name: string; parentPath: string; isFile(): boolean }[];

    try {
      entries = await readdir(base, { recursive: true, withFileTypes: true });
    } catch (error: unknown) {
      if (isMissing(error)) return [];

      throw error;
    }

    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(this.root, join(entry.parentPath, entry.name)).split(sep).join("/"))
      .filter((key) => key.startsWith(prefix) && key.endsWith(".parquet"));
  }
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

/** The `filesystem` connection. Config: `root`, the directory every prefix lives under. */
export class Client extends ObjectStorageAdapter {
  constructor(config: Record<string, unknown>, _secrets: Record<string, string> = {}) {
    const root = config["root"];

    if (typeof root !== "string" || !root) {
      throw new Error(
        `a filesystem connection needs "root" in its config: the directory to store under`,
      );
    }

    super(new FileStore(root), connector.type);
  }
}
