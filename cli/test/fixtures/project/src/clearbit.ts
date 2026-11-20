/**
 * An adapter for a connection type this workspace does not serve, written in
 * the project that needs it. `puppi.config.ts` passes the class to
 * `defineConfig`, so it rides in the deployment bundle.
 */

const DIRECTION = Symbol.for("puppi.direction");

export class Client {
  constructor(
    private readonly config: Record<string, unknown>,
    private readonly secrets: Record<string, string>,
  ) {}

  async get(path: string): Promise<unknown> {
    const response = await fetch(`${String(this.config["base_url"])}${path}`, {
      headers: { authorization: `Bearer ${this.secrets["api_key"] ?? ""}` },
    });

    if (!response.ok) throw new Error(`clearbit answered ${response.status} for ${path}`);

    return response.json();
  }
}

const prototype = Client.prototype as unknown as Record<string, unknown>;

Object.defineProperty(prototype["get"] as object, DIRECTION, { value: "read" });
