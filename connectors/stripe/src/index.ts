/**
 * `@puppi/adapter-stripe`: a source connector over the Stripe API.
 * Auth is a bearer key. The API version is pinned by `define.ts` and may
 * be overridden with `api_version` on the binding. `customers()` walks the
 * list.
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
import type { SchemaCustomer as Customer } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type { Customer };

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
        headers: (version) => ({ "stripe-version": version }),
      }),
    );
  }

  /** `GET /v1/customers?limit=1` proves `api_key`. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/v1/customers?limit=1", auth.secret);
  }

  /**
   * Every page of customers. `cursor` is the last customer id from the
   * previous page. The last page yields a null cursor.
   */
  @read
  customers(args: { limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Customer>(
      "GetCustomers",
      {
        rows: "data",
        next: { last: "id", while: "has_more" },
        param: "starting_after",
      },
      { cursor: args.cursor, query: { limit: args.limit } },
    );
  }
}
