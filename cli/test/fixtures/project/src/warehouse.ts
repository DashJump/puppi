/**
 * A local stub the fixture bundle carries for the `warehouse` connection.
 * The type is `warehouse-stub`, and `clientModule` is this file.
 */

export class Client {
  async write(): Promise<{
    storage_ref: string;
    observed_schema: [];
    stats: { row_count: number; bytes: null; content_hash: null };
  }> {
    return {
      storage_ref: "p.t",
      observed_schema: [],
      stats: { row_count: 0, bytes: null, content_hash: null },
    };
  }

  async read(): Promise<never[]> {
    return [];
  }

  async query(_sql: string): Promise<Record<string, unknown>[]> {
    return [];
  }

  async drop(): Promise<void> {}

  async close(): Promise<void> {}
}
