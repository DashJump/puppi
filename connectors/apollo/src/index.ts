/**
 * Source connector for Apollo.io people and organization enrichment and search.
 */

import {
  read,
  TerminalError,
  type CredentialCheck,
  type ClientOptions,
  type Page,
  OpenApiClient,
  openApiClientOptions,
} from "@puppi/sdk";

import connector from "./define.js";
import type { operations as spec } from "./openapi.js";
import { type Api, operations } from "./operations.js";

type PersonQuery = NonNullable<spec["people-enrichment"]["parameters"]["query"]>;
type PeopleBulkQuery = NonNullable<spec["bulk-people-enrichment"]["parameters"]["query"]>;
type OrganizationQuery = NonNullable<spec["organization-enrichment"]["parameters"]["query"]>;
type PeopleSearchQuery = Omit<
  NonNullable<spec["people-api-search"]["parameters"]["query"]>,
  "page" | "per_page"
>;
type OrganizationSearchQuery = Omit<
  NonNullable<spec["organization-search"]["parameters"]["query"]>,
  "page" | "per_page"
>;

export type PersonEnrichment = Api["responses"]["people-enrichment"];
export type PeopleEnrichment = Api["responses"]["bulk-people-enrichment"];
export type OrganizationEnrichment = Api["responses"]["organization-enrichment"];
export type OrganizationsEnrichment = Api["responses"]["bulk-organization-enrichment"];

type SearchRow<Body, Key extends string> =
  NonNullable<Body> extends {
    [K in Key]?: readonly (infer Row)[] | null;
  }
    ? NonNullable<Row>
    : never;

export type Person = SearchRow<Api["responses"]["people-api-search"], "people">;
export type Organization = SearchRow<Api["responses"]["organization-search"], "organizations">;

export type PeopleBulkBody = NonNullable<Api["requests"]["bulk-people-enrichment"]>;
export type OrganizationsBulkBody = NonNullable<Api["requests"]["bulk-organization-enrichment"]>;

export default connector;

const auth = connector.auth;

// Both search descriptions state this display cap in prose. The JSON still
// reports totals past it, and a null cursor there would commit the prefix.
const SEARCH_PAGE_CAP = 500;
const SEARCH_RECORD_CAP = 50_000;

export class SearchCapError extends TerminalError {
  readonly code = "search_cap";

  constructor() {
    super(
      "Apollo search returns at most 500 pages and 50,000 records. Narrow the filters and search again.",
    );
  }
}

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(config, options, ...openApiClientOptions(connector, config, secrets, operations));
  }

  /** `GET /users/api_profile` proves `api_key`. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/users/api_profile", auth.secret);
  }

  /** One person from `POST /people/match`. The return value is Apollo's body. */
  @read
  enrichPerson(args: { query?: PersonQuery } = {}) {
    return this.read("people-enrichment", { query: args.query });
  }

  /** Up to 10 people from `POST /people/bulk_match`. `matches` follows `details`. */
  @read
  enrichPeople(args: { body: PeopleBulkBody; query?: PeopleBulkQuery }) {
    return this.read("bulk-people-enrichment", { query: args.query, body: args.body });
  }

  /** One organization from `GET /organizations/enrich`. */
  @read
  enrichOrganization(args: { query?: OrganizationQuery } = {}) {
    return this.read("organization-enrichment", { query: args.query });
  }

  /**
   * Up to 10 organizations from `POST /organizations/bulk_enrich`.
   * `domains` is the `domains[]` query. `body.details` wins when both are set.
   */
  @read
  enrichOrganizations(args: { body?: OrganizationsBulkBody; domains?: readonly string[] } = {}) {
    if (args.domains === undefined) {
      return this.read("bulk-organization-enrichment", { body: args.body });
    }

    return this.post(
      "bulk-organization-enrichment",
      queryString({ "domains[]": args.domains }),
      args.body,
    );
  }

  /**
   * Pages of people from `POST /mixed_people/api_search`. `cursor` is the next
   * page number, or null on the last page. This call does not return emails.
   */
  @read
  searchPeople(args: { query?: PeopleSearchQuery; perPage?: number; cursor?: number | null } = {}) {
    return walkSearch<Person>(args.cursor ?? null, args.perPage, (page) =>
      this.searchPage("people-api-search", args.query, page, args.perPage, (body) => ({
        rows: arrayAt(body, "people") as Person[],
        totals: {
          totalPages: null,
          totalEntries: numberAt(body["total_entries"]),
        },
      })),
    );
  }

  /**
   * Pages of organizations from `POST /mixed_companies/search`. `cursor` is the
   * next page number, or null on the last page.
   */
  @read
  searchOrganizations(
    args: { query?: OrganizationSearchQuery; perPage?: number; cursor?: number | null } = {},
  ) {
    return walkSearch<Organization>(args.cursor ?? null, args.perPage, (page) =>
      this.searchPage("organization-search", args.query, page, args.perPage, (body) => {
        const pagination = record(body["pagination"]);

        return {
          rows: arrayAt(body, "organizations") as Organization[],
          totals: {
            totalPages: numberAt(pagination["total_pages"]),
            totalEntries: numberAt(pagination["total_entries"]),
          },
        };
      }),
    );
  }

  private searchPage<Row>(
    operationId: "people-api-search" | "organization-search",
    query: object | undefined,
    page: number,
    perPage: number | undefined,
    parse: (body: Record<string, unknown>) => { rows: Row[]; totals: Totals },
  ): Promise<{ rows: Row[]; totals: Totals }> {
    return this.post(operationId, searchQuery(query, page, perPage)).then((body) =>
      parse(record(body)),
    );
  }

  private post<Id extends keyof Api["responses"]>(
    operationId: Id,
    search: string,
    body?: unknown,
  ): Promise<Api["responses"][Id]> {
    const operation = operations[operationId];

    return this.send<Api["responses"][Id]>(`${operation.path}${search}`, {
      method: operation.method === "post" ? "POST" : "GET",
      ...(body === undefined ? {} : { body }),
    }).then((result) => result.data);
  }
}

interface Totals {
  totalPages: number | null;
  totalEntries: number | null;
}

function assertSearchCap(totals: Totals, perPage: number | undefined): void {
  if (totals.totalPages !== null && totals.totalPages > SEARCH_PAGE_CAP) throw new SearchCapError();

  if (totals.totalEntries !== null && totals.totalEntries > SEARCH_RECORD_CAP) {
    throw new SearchCapError();
  }

  if (
    perPage !== undefined &&
    perPage > 0 &&
    totals.totalEntries !== null &&
    Math.ceil(totals.totalEntries / perPage) > SEARCH_PAGE_CAP
  ) {
    throw new SearchCapError();
  }
}

function nextSearchPage(
  page: number,
  rowCount: number,
  perPage: number | undefined,
  totals: Totals,
): number | null | "unknown" {
  if (totals.totalPages !== null) return page >= totals.totalPages ? null : page + 1;

  if (rowCount === 0) return null;

  if (perPage !== undefined && totals.totalEntries !== null) {
    return page * perPage >= totals.totalEntries ? null : page + 1;
  }

  if (totals.totalEntries !== null && rowCount >= totals.totalEntries) return null;

  return "unknown";
}

async function* walkSearch<Row>(
  cursor: number | null,
  perPage: number | undefined,
  load: (page: number) => Promise<{ rows: Row[]; totals: Totals }>,
): AsyncGenerator<Page<Row, number>> {
  let page = cursor ?? 1;

  if (page > SEARCH_PAGE_CAP) throw new SearchCapError();

  let current = await load(page);

  for (;;) {
    assertSearchCap(current.totals, perPage);

    const next = nextSearchPage(page, current.rows.length, perPage, current.totals);

    if (next === "unknown") {
      const following = page + 1;

      if (following > SEARCH_PAGE_CAP) throw new SearchCapError();

      const peeked = await load(following);

      assertSearchCap(peeked.totals, perPage);

      // No page count and no perPage: a short page is not proof this is the
      // last one, so the following response decides the cursor.
      if (current.rows.length > 0) {
        yield { data: current.rows, cursor: peeked.rows.length > 0 ? following : null };
      }

      if (peeked.rows.length === 0) return;

      page = following;
      current = peeked;
      continue;
    }

    if (next !== null && next > SEARCH_PAGE_CAP) throw new SearchCapError();

    if (current.rows.length > 0) yield { data: current.rows, cursor: next };

    if (next === null) return;

    page = next;
    current = await load(page);
  }
}

function queryString(query: object): string {
  return encoded(fillQuery(query));
}

// Search publishes `page` as a query parameter and no request body. The shared
// page walk would put that token in the JSON body.
function searchQuery(query: object | undefined, page: number, perPage: number | undefined): string {
  const params = fillQuery(query);

  params.set("page", String(page));

  if (perPage !== undefined) params.set("per_page", String(perPage));

  return encoded(params);
}

function fillQuery(query: object | undefined): URLSearchParams {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query ?? {})) appendQuery(params, key, value);

  return params;
}

function encoded(params: URLSearchParams): string {
  const text = params.toString();

  return text === "" ? "" : `?${text}`;
}

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== undefined && item !== null) params.append(key, String(item));
    }

    return;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    params.set(key, String(value));
  }
}

function arrayAt(body: Record<string, unknown>, key: string): unknown[] {
  const value = body[key];

  return Array.isArray(value) ? value : [];
}

function numberAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
