/**
 * `@puppi/adapter-intercom` lists contacts, conversations, and companies
 * from the Intercom REST API.
 */

import {
  eachPage,
  HttpStatusError,
  NotFound,
  read,
  TerminalError,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
} from "@puppi/sdk";

import connector from "./define.js";
import type {
  SchemaCompany as Company,
  SchemaCompanyScroll as CompanyScroll,
  SchemaContact as Contact,
  SchemaConversationListItem as Conversation,
} from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type { Company, Contact, Conversation };

export default connector;

const auth = connector.auth;

const COMPANIES_SCOPE = "read_users_companies";

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(
      config,
      options,
      ...openApiClientOptions(connector, config, secrets, operations, {
        headers: (version) => ({ "Intercom-Version": version }),
      }),
    );
  }

  /**
   * Proves `access_token` with `GET /contacts?per_page=1`.
   * It does not verify the companies scope.
   */
  override async check(): Promise<CredentialCheck> {
    try {
      await this.read("ListContacts", { query: { per_page: 1 } });

      return { ok: true };
    } catch (error) {
      if (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) {
        const reason =
          error.status === 403 || errorCode(error) === "token_unauthorized"
            ? "authorization"
            : "authentication";

        return {
          ok: false,
          reason,
          message: `${this.api} ${reason} failed for ${auth.secret} (${error.status} ${error.statusText})`,
        };
      }

      throw error;
    }
  }

  /**
   * Returns each page of contacts. `cursor` is `pages.next.starting_after`
   * from the previous page, and null when that field is absent.
   */
  @read
  contacts(args: { perPage?: number; cursor?: string | null } = {}) {
    return this.pages<Contact>(
      "ListContacts",
      {
        rows: "data",
        next: "pages.next.starting_after",
        param: "starting_after",
      },
      { cursor: args.cursor, query: { per_page: args.perPage } },
    );
  }

  /**
   * Returns each page of conversations. `cursor` is `pages.next.starting_after`
   * from the previous page, and null when that field is absent.
   */
  @read
  conversations(args: { perPage?: number; cursor?: string | null } = {}) {
    return this.pages<Conversation>(
      "listConversations",
      {
        rows: "conversations",
        next: "pages.next.starting_after",
        param: "starting_after",
      },
      { cursor: args.cursor, query: { per_page: args.perPage } },
    );
  }

  /**
   * Returns each page of companies. `cursor` is `scroll_param` from the
   * previous page, and null when `data` is empty.
   */
  @read
  companies(args: { cursor?: string | null } = {}) {
    // pages() follows `scroll_param` whenever it is present, including on an empty last page.
    return eachPage<Company, string>({
      cursor: args.cursor ?? null,
      fetchPage: async (cursor) => {
        try {
          const body = await this.read("scrollOverAllCompanies", {
            query: cursor === null ? {} : { scroll_param: cursor },
          });

          return scrollPage(body);
        } catch (error) {
          if (
            error instanceof HttpStatusError &&
            error.status === 401 &&
            errorCode(error) === "token_unauthorized"
          ) {
            throw new CompaniesScopeError(error);
          }

          // NotFound drops the body, so a resume 404 is the expired scroll.
          if (cursor !== null && error instanceof NotFound) throw new ScrollExpiredError(error);

          throw error;
        }
      },
    });
  }
}

export class CompaniesScopeError extends TerminalError {
  readonly code = "token_unauthorized";

  constructor(cause: HttpStatusError) {
    super(
      `intercom authorization failed for ${auth.secret} (token_unauthorized: ${COMPANIES_SCOPE})`,
      { cause },
    );
  }
}

export class MissingScrollParamError extends TerminalError {
  readonly code = "missing_scroll_param";

  constructor() {
    super("intercom companies scroll returned companies and no scroll_param");
  }
}

export class ScrollExpiredError extends TerminalError {
  readonly code = "scroll_expired";

  constructor(cause: NotFound) {
    super("intercom companies scroll expired; start the companies sync again without this cursor", {
      cause,
    });
  }
}

function scrollPage(body: CompanyScroll): { data: Company[]; next: string | null } {
  const data = body?.data ?? [];

  if (data.length === 0) return { data, next: null };

  const next = body?.scroll_param;

  if (typeof next !== "string" || next === "") throw new MissingScrollParamError();

  return { data, next };
}

/** `HttpStatusError` keeps 200 characters of the response body. A `code` past that slice is missed. */
function errorCode(error: HttpStatusError): string | undefined {
  const match = /"code"\s*:\s*"([^"]+)"/.exec(error.message);

  return match?.[1];
}
