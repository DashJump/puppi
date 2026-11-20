/**
 * A project-local client declared from `puppi.config.ts`, so the class the
 * bundle registers is this one. `clientModule` is passed because the file
 * is not an `@puppi/adapter-*` package.
 */

export const type = "rates";

export const configSchema = { base_url: "string" };

export const secretFields = ["api_key"];

/** Where `puppi-env.d.ts` imports `Client` from. Not an `@puppi/adapter-*` package. */
export const clientModule = "./src/rates.js";

export class Client {
  static readonly bundled = "rates";

  constructor(
    readonly config: Record<string, unknown>,
    readonly secrets: Record<string, string>,
  ) {}
}
