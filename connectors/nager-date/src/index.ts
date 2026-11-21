/**
 * `@puppi/adapter-nager-date`: a source connector over the Nager.Date
 * community API at https://nagerholidays.com/api/v4, public holidays by
 * country. No key. A country the service does not cover answers 404.
 * `publicHolidays` and `next` report that as `null`: "not covered" is data,
 * not a failure.
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
import type { SchemaCountryV4Dto, SchemaPublicHolidayV4Dto } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type Country = SchemaCountryV4Dto;
export type Holiday = SchemaPublicHolidayV4Dto;

export default connector;

const COUNTRIES = "/api/v4/Countries/Available";
const HOLIDAYS = "/api/v4/Holidays/{countryCode}/{year}";
const NEXT = "/api/v4/Holidays/{countryCode}/Next";

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(
      config,
      { ...options, fetch: emptyNextList(options.fetch ?? fetch) },
      ...openApiClientOptions(connector, config, secrets, operations),
    );
  }

  /** `GET /api/v4/Countries/Available` proves the host answers. */
  override async check(): Promise<CredentialCheck> {
    await this.read(COUNTRIES);

    return { ok: true };
  }

  /** The countries the service covers. */
  @read
  availableCountries(): Promise<Country[]> {
    return this.read(COUNTRIES);
  }

  /** A year's public holidays for an ISO 3166-1 alpha-2 code, or null when the country is not covered. */
  @read
  publicHolidays(year: number, countryCode: string): Promise<Holiday[] | null> {
    return this.readOrNull(HOLIDAYS, { path: { year, countryCode } });
  }

  /** The next 365 days of holidays for one country, or null when it is not covered. */
  @read
  next(countryCode: string): Promise<Holiday[] | null> {
    return this.readOrNull(NEXT, { path: { countryCode } });
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
}

/**
 * `GET /api/v4/Holidays/{countryCode}/Next` answers 204 with an empty body
 * when the country has no holiday in the next 365 days. The shared client
 * only decodes a JSON body, so that answer is the empty list.
 */
function emptyNextList(fetchImpl: typeof fetch): typeof fetch {
  const wrapped: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, init);

    if (response.status !== 204) return response;

    const url = new URL(input instanceof Request ? input.url : String(input));

    if (!url.pathname.endsWith("/Next")) return response;

    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  return wrapped;
}
