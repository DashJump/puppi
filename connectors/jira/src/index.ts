/**
 * `@puppi/adapter-jira`: a source connector over the Jira Cloud platform
 * REST API. Auth is HTTP Basic: config `email` and secret `api_token`.
 * `issues()` walks GET `/rest/api/3/search/jql`.
 */

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  type PageArgs,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaIssue as Issue } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type { Issue };

export default connector;

const auth = connector.auth;

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
        baseUrl: () => baseUrl(config),
      }),
    );
  }

  /** `GET /rest/api/3/myself` proves `api_token`. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/rest/api/3/myself", auth.secret);
  }

  /**
   * Every page of a JQL search. `cursor` is `nextPageToken`. The last page
   * yields a null cursor. The first page sends no token. Enhanced search
   * returns ids unless `fields` is set, so summary and updated are requested.
   */
  @read
  issues(args: { jql: string; maxResults?: number; cursor?: PageArgs["cursor"] }) {
    return this.pages<Issue>(
      "searchIssues",
      { rows: "issues", next: "nextPageToken", param: "nextPageToken" },
      {
        cursor: args.cursor,
        query: { jql: args.jql, maxResults: args.maxResults, fields: "summary,updated" },
      },
    );
  }
}

function baseUrl(config: Record<string, unknown>): string {
  if (typeof config["base_url"] === "string" && config["base_url"] !== "")
    return config["base_url"];

  const domain = config["domain"];

  if (typeof domain !== "string" || domain === "") throw new Error("jira requires domain");
  if (domain.startsWith("https://")) return domain;
  if (domain.includes(".")) return `https://${domain}`;

  return `https://${domain}.atlassian.net`;
}
