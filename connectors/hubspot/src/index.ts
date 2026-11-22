/**
 * `@puppi/adapter-hubspot`: a source connector over the HubSpot CRM contacts API.
 * Auth is a bearer access token. `contacts()` walks the list.
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
import type { SchemaSimplePublicObjectWithAssociations as Contact } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type { Contact };

export default connector;

const auth = connector.auth;
const defaultBaseUrl = connector.defaultBaseUrl;

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

  /** `GET /contacts?limit=1` on the versioned CRM base proves `access_token`. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/contacts?limit=1", auth.secret);
  }

  /**
   * Every page of contacts. `cursor` is `paging.next.after` from the
   * previous page. The last page yields a null cursor.
   */
  @read
  contacts(args: { limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Contact>(
      "get-/crm/objects/2026-09/contacts_/crm/objects/2026-09-beta/{objectType}",
      {
        rows: "results",
        next: "paging.next.after",
        param: "after",
      },
      { cursor: args.cursor, query: { limit: args.limit } },
    );
  }
}

/** A `YYYY-MM` version follows `objects`. A numbered version precedes it. `base_url` replaces the host. */
function baseUrl(config: Record<string, unknown>, version: string): string {
  const override = config["base_url"];
  const host = typeof override === "string" && override !== "" ? override : defaultBaseUrl;

  if (typeof host !== "string" || host === "") throw new Error("hubspot requires base_url");

  const root = trimSlash(host);
  const prefix = /^\d{4}-\d{2}$/.test(version)
    ? `/crm/objects/${version}`
    : `/crm/${version}/objects`;

  return `${root}${prefix}`;
}
