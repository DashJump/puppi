/** A local stub for the dev fixture. It is not a postgres client. */

export class Client {
  constructor(
    readonly config: Record<string, unknown>,
    readonly secrets: Record<string, string>,
  ) {}

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

  async query(): Promise<never[]> {
    return [];
  }

  async drop(): Promise<void> {}
}
