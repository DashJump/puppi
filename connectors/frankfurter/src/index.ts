/**
 * `@puppi/adapter-frankfurter`: a source connector over https://frankfurter.dev,
 * the ECB's reference rates. No key. Rates are published on TARGET business
 * days, so `latest` on a weekend carries Friday's date.
 */

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaLatest, SchemaSeries } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type Latest = SchemaLatest;
export type Series = SchemaSeries;

export default connector;

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(config, options, ...openApiClientOptions(connector, config, secrets, operations));
  }

  /** `GET /currencies` proves the host answers. */
  override async check(): Promise<CredentialCheck> {
    await this.read("getCurrencies");

    return { ok: true };
  }

  /** The most recent rates against `base` (EUR by default). */
  @read
  latest(options: { base?: string; symbols?: readonly string[] } = {}): Promise<Latest> {
    return this.read("getLatest", {
      query: { base: options.base, symbols: options.symbols?.join(",") },
    });
  }

  /** Every published day between two ISO dates, inclusive; `end` omitted means today. */
  @read
  series(range: {
    start: string;
    end?: string;
    base?: string;
    symbols?: readonly string[];
  }): Promise<Series> {
    return this.read("getSeries", {
      path: { range: `${range.start}..${range.end ?? ""}` },
      query: { base: range.base, symbols: range.symbols?.join(",") },
    });
  }

  /** Rates on one ISO date; a weekend or holiday answers with the previous business day's. */
  @read
  on(date: string, options: { base?: string; symbols?: readonly string[] } = {}): Promise<Latest> {
    return this.read("getOn", {
      path: { date },
      query: { base: options.base, symbols: options.symbols?.join(",") },
    });
  }

  /** code -> currency name, for every currency the ECB publishes. */
  @read
  currencies(): Promise<Record<string, string>> {
    return this.read("getCurrencies");
  }
}
