/**
 * Source connector for Notion users, title search, and data source queries.
 */

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  type PageArgs,
  TerminalError,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaPageOrDataSourceListResponse, SchemaUserObjectResponse } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type User = SchemaUserObjectResponse;

export type PageOrDataSource = SchemaPageOrDataSourceListResponse["results"][number];

export type SearchBody = Omit<Api["requests"]["post-search"], "start_cursor" | "page_size">;

export type DataSourceQueryBody = Omit<
  Api["requests"]["post-database-query"],
  "start_cursor" | "page_size"
>;

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
        headers: (version) => ({ "Notion-Version": version }),
        extract,
      }),
    );
  }

  /** Proves `token` with `GET /v1/users/me`. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/v1/users/me", auth.secret);
  }

  /** Every user this integration can see. `cursor` is sent back as the `start_cursor` query parameter. */
  @read
  users(args: { pageSize?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<User, "get-users">(
      "get-users",
      { rows: "results", next: "next_cursor", param: "start_cursor" },
      {
        cursor: args.cursor,
        query: { page_size: args.pageSize },
      },
    );
  }

  /** Title search. `cursor` is sent back as `start_cursor` in the JSON body. */
  @read
  search(
    args: {
      body?: SearchBody;
      pageSize?: number;
      cursor?: PageArgs["cursor"];
    } = {},
  ) {
    return this.pages<PageOrDataSource, "post-search">(
      "post-search",
      { rows: "results", next: "next_cursor", param: "start_cursor" },
      {
        cursor: args.cursor,
        body: readBody<Api["requests"]["post-search"]>(args.body, args.pageSize),
      },
    );
  }

  /** Pages in one data source. `cursor` is sent back as `start_cursor` in the JSON body. */
  @read
  queryDataSource(args: {
    dataSourceId: string;
    body?: DataSourceQueryBody;
    pageSize?: number;
    cursor?: PageArgs["cursor"];
  }) {
    return this.pages<PageOrDataSource, "post-database-query">(
      "post-database-query",
      { rows: "results", next: "next_cursor", param: "start_cursor" },
      {
        cursor: args.cursor,
        path: { data_source_id: args.dataSourceId },
        body: readBody<Api["requests"]["post-database-query"]>(args.body, args.pageSize),
      },
    );
  }
}

function readBody<Body extends { start_cursor?: string; page_size?: number }>(
  fields: Omit<Body, "start_cursor" | "page_size"> | undefined,
  pageSize: number | undefined,
): Body {
  const body = { ...fields } as Body;

  if (pageSize !== undefined) body.page_size = pageSize;

  return body;
}

// `next_cursor` is empty when `request_status.type` is `incomplete`,
// so the page rule would end the walk and commit a partial list.
function extract(operationId: string, body: unknown): undefined {
  if (operationId !== "post-database-query" && operationId !== "post-search") return undefined;

  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const status = record["request_status"];

  if (status === null || typeof status !== "object") return undefined;

  const fields = status as Record<string, unknown>;

  if (fields["type"] !== "incomplete") return undefined;

  const reason = fields["incomplete_reason"];
  const code = typeof reason === "string" && reason !== "" ? reason : "incomplete";

  throw new CappedQuery(code);
}

class CappedQuery extends TerminalError {
  readonly code: string;

  constructor(code: string) {
    super(`Notion capped this query (${code}). Narrow the filter and query again.`);
    this.code = code;
  }
}
