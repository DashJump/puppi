/**
 * `@puppi/adapter-zendesk-support`: a source connector over the Zendesk
 * Support API. Auth is HTTP Basic of `{email}/token:{api_token}`. The version
 * is a prefix of the base URL (`/api/<version>`), from `api_version` or the
 * default in `define.ts`. `tickets()` walks the list by following `links.next`.
 */

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  type PageArgs,
  trimSlash,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaTicket as Ticket } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type { Ticket };

export default connector;

const auth = connector.auth;

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    const [defaults, openApi] = openApiClientOptions(connector, config, secrets, operations, {
      baseUrl: (version) => baseUrl(config, version),
    });

    super({ ...config, base_url: defaults.baseUrl }, options, defaults, openApi);
  }

  /** `GET /api/<version>/users/me` proves `api_token`. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/users/me", auth.secret);
  }

  /**
   * Every page of tickets. `cursor` is the absolute `links.next` URL.
   * The last page yields a null cursor. `page[size]` opts into cursor
   * pagination. Without it Zendesk answers with offset pages, which omit
   * `links.next`, and the walk stops after the first hundred tickets.
   * The default is Zendesk's maximum of 100.
   */
  @read
  tickets(args: { pageSize?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Ticket>(
      "listTickets",
      { rows: "tickets", next: "links.next" },
      {
        cursor: args.cursor,
        query: { "page[size]": args.pageSize ?? 100 },
      },
    );
  }
}

/** Account host plus `/api/<version>`. `base_url` replaces the host. */
function baseUrl(config: Record<string, unknown>, version: string): string {
  const override = config["base_url"];

  if (typeof override === "string" && override !== "")
    return `${trimSlash(override)}/api/${version}`;

  const subdomain = config["subdomain"];

  if (typeof subdomain !== "string" || subdomain === "") {
    throw new Error("zendesk-support requires subdomain");
  }

  return `https://${subdomain}.zendesk.com/api/${version}`;
}
