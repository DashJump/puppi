/**
 * `@puppi/adapter-world-bank`: a source connector over the World Bank
 * Indicators API (https://api.worldbank.org/v2). No key. `countries()` and
 * `indicator()` yield pages. Each page is a `[meta, rows]` pair. A query
 * that matches nothing is `[meta, null]` with `pages: 0`, which yields no
 * rows. A refusal comes back as a 200 carrying `[{ message: [...] }]`,
 * which is turned into an error here.
 */

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  type PageArgs,
  type PageRule,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaCountry, SchemaNamed, SchemaObservation } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type Named = SchemaNamed;
export type Country = SchemaCountry;
export type Observation = SchemaObservation;

export default connector;

const PER_PAGE = 500;

/** Both lists are `[meta, rows]`, and the next page is `page` plus one. */
const WORLD_BANK_PAGE = {
  rows: "1",
  next: { page: "page", pages: "pages" },
  param: "page",
} as const satisfies PageRule;

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(
      config,
      options,
      ...openApiClientOptions(connector, config, secrets, operations, { extract }),
    );
  }

  /** First page of countries proves the host answers. */
  override async check(): Promise<CredentialCheck> {
    await this.read("listCountries", {
      query: { format: "json", per_page: 1, page: 1 },
    });

    return { ok: true };
  }

  /**
   * Every page of countries and aggregates. `cursor` is the next page
   * number. The last page yields a null cursor.
   */
  @read
  countries(args: Pick<PageArgs, "cursor"> = {}) {
    return this.pages<Country>("listCountries", WORLD_BANK_PAGE, {
      cursor: args.cursor,
      query: { format: "json", per_page: PER_PAGE },
    });
  }

  /**
   * Every page of one indicator. `mrv` asks for the most recent N values
   * per country; `date` for a year or a `2000:2020` range; `countries` for a
   * `;`-separated code list, `all` by default. `cursor` is the next page number.
   */
  @read
  indicator(
    code: string,
    options: {
      mrv?: number;
      date?: string;
      countries?: string;
      cursor?: PageArgs["cursor"];
    } = {},
  ) {
    return this.pages<Observation>("indicator", WORLD_BANK_PAGE, {
      cursor: options.cursor,
      path: { countries: options.countries ?? "all", code },
      query: { format: "json", per_page: PER_PAGE, mrv: options.mrv, date: options.date },
    });
  }
}

/**
 * An empty selection is `[meta, null]` with `pages: 0`. The stock page rule
 * only accepts an array in the rows slot, so that body would throw. Every
 * other body, including a `[{ message }]` refusal, stays on that rule.
 */
function extract(operationId: string, body: unknown): { data: unknown[]; next: null } | undefined {
  if (operationId !== "listCountries" && operationId !== "indicator") return undefined;
  if (!emptySelection(body)) return undefined;

  return { data: [], next: null };
}

/** World Bank answers a query with no rows as `[{ page: 0, pages: 0, … }, null]`. */
function emptySelection(body: unknown): boolean {
  const index = Number(WORLD_BANK_PAGE.rows);

  if (!Array.isArray(body) || body.length <= index || body[index] !== null) return false;

  const meta = body[0];

  if (meta === null || typeof meta !== "object" || "message" in meta) return false;

  return Number((meta as Record<string, unknown>)[WORLD_BANK_PAGE.next.pages]) === 0;
}
