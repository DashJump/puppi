/**
 * `@puppi/adapter-nager-date`: a source connector over https://date.nager.at
 * (v3), public holidays by country. No key. A country the service does not
 * cover answers 404. `publicHolidays` and `next` report that as `null`:
 * "not covered" is data, not a failure.
 */

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  NotFound,
  OpenApiClient,
  openApiClientOptions,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaCountry, SchemaHoliday, SchemaLongWeekend } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type Country = SchemaCountry;
export type Holiday = SchemaHoliday;
export type LongWeekend = SchemaLongWeekend;

export default connector;

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(config, options, ...openApiClientOptions(connector, config, secrets, operations));
  }

  /** `GET /AvailableCountries` proves the host answers. */
  override async check(): Promise<CredentialCheck> {
    await this.read("availableCountries");

    return { ok: true };
  }

  /** The countries the service covers. */
  @read
  availableCountries(): Promise<Country[]> {
    return this.read("availableCountries");
  }

  /** A year's public holidays for an ISO 3166-1 alpha-2 code, or null when the country is not covered. */
  @read
  publicHolidays(year: number, countryCode: string): Promise<Holiday[] | null> {
    return this.readOrNull("publicHolidays", { path: { year, countryCode } });
  }

  /** The next public holidays across every covered country, soonest first. */
  @read
  nextWorldwide(): Promise<Holiday[]> {
    return this.read("nextWorldwide");
  }

  /** The next 365 days of holidays for one country, or null when it is not covered. */
  @read
  next(countryCode: string): Promise<Holiday[] | null> {
    return this.readOrNull("next", { path: { countryCode } });
  }

  /** A 404 from Nager means the country is not covered. */
  private async readOrNull<Id extends keyof Api["responses"]>(
    operationId: Id,
    args: { path: Record<string, string | number> },
  ): Promise<Api["responses"][Id] | null> {
    try {
      return await this.read(operationId, args);
    } catch (error) {
      if (error instanceof NotFound) return null;

      throw error;
    }
  }

  @read
  longWeekends(year: number, countryCode: string): Promise<LongWeekend[]> {
    return this.read("longWeekends", { path: { year, countryCode } });
  }
}
