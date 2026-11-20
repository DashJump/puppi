/**
 * `@puppi/adapter-salesforce`: a source connector over the Salesforce REST
 * API. Auth is a bearer access token. The API version is a prefix of the
 * base URL (`/services/data/<version>`), from `api_version` or the default
 * in `define.ts`. The instance host comes from `base_url`. `accounts()`
 * walks a SOQL query.
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
import type { SchemaAccount as Account } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type { Account };

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

  /** `GET /services/data/<version>/query?q=SELECT+Id+FROM+Account+LIMIT+1` proves `access_token`. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/query?q=SELECT+Id+FROM+Account+LIMIT+1", auth.secret);
  }

  /**
   * Every page of a SOQL query. `cursor` is `nextRecordsUrl` from the
   * previous page. The last page yields a null cursor.
   */
  @read
  accounts(args: { q: string; cursor?: PageArgs["cursor"] }) {
    return this.pages<Account>(
      "query",
      { rows: "records", next: "nextRecordsUrl" },
      { cursor: args.cursor, query: { q: args.q } },
    );
  }
}

/** Instance host plus `/services/data/<version>`. `base_url` is the host. */
function baseUrl(config: Record<string, unknown>, version: string): string {
  const host = config["base_url"];

  if (typeof host !== "string" || host === "") throw new Error("salesforce requires base_url");

  return `${trimSlash(host)}/services/data/${version}`;
}
