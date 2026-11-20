import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";

import type { Row } from "@puppi/sdk";

/** Rows a spool holds in memory before it moves them to disk. */
export const SPOOL_ROWS = 10_000;

/**
 * The rows a full-refresh attempt emitted, kept off the heap. Up to `limit`
 * rows stay in memory; past that each batch is appended to a temp file as a
 * length-prefixed v8 frame, so `Date` and `bigint` values come back as they
 * went in. `batches()` reads the file again on every iteration, because a
 * streaming storage write walks its input twice.
 */
export class Spool {
  private pending: Row[] = [];
  private dir: string | null = null;
  private file: FileHandle | null = null;

  constructor(private readonly limit = SPOOL_ROWS) {}

  /** True once rows went to disk. Until then `inMemory()` is every row. */
  get onDisk(): boolean {
    return this.file !== null;
  }

  async add(rows: readonly Row[]): Promise<void> {
    for (const row of rows) this.pending.push(row);

    while (this.pending.length >= this.limit) await this.spill(this.pending.splice(0, this.limit));
  }

  inMemory(): Row[] {
    return this.pending;
  }

  batches(): AsyncIterable<Row[]> {
    return { [Symbol.asyncIterator]: () => this.read() };
  }

  async close(): Promise<void> {
    await this.file?.close();
    this.file = null;

    if (this.dir !== null) await rm(this.dir, { recursive: true, force: true });
    this.dir = null;
  }

  private async spill(rows: Row[]): Promise<void> {
    if (this.file === null) {
      this.dir = await mkdtemp(join(tmpdir(), "puppi-spool-"));
      this.file = await open(join(this.dir, "rows"), "w+");
    }

    const body = serialize(rows);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);

    await this.file.write(header);
    await this.file.write(body);
  }

  private async *read(): AsyncGenerator<Row[]> {
    const file = this.file;
    let position = 0;

    for (;;) {
      if (file === null) break;

      const header = await readExactly(file, 4, position);

      if (header === null) break;

      const size = header.readUInt32LE(0);
      const body = await readExactly(file, size, position + 4);

      if (body === null) throw new Error("spool file ended inside a batch");

      position += 4 + size;
      yield deserialize(body) as Row[];
    }

    if (this.pending.length > 0) yield [...this.pending];
  }
}

/** `size` bytes at `position`, or null at end of file. */
async function readExactly(
  file: FileHandle,
  size: number,
  position: number,
): Promise<Buffer | null> {
  const buffer = Buffer.alloc(size);
  let filled = 0;

  while (filled < size) {
    const { bytesRead } = await file.read(buffer, filled, size - filled, position + filled);

    if (bytesRead === 0) {
      if (filled === 0) return null;
      throw new Error("spool file ended inside a batch");
    }

    filled += bytesRead;
  }

  return buffer;
}
