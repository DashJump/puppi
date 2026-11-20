/**
 * `@puppi/adapter-shopify`: a source connector over the Shopify Admin REST
 * API. Auth is the `X-Shopify-Access-Token` header. The API version is a
 * path segment. `customers()` walks the list.
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
import type { SchemaCustomer } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type Customer = SchemaCustomer;

/** `read("getCustomer")` answers with the customer, not `{ customer }`. */
type ShopifyApi = {
  responses: Omit<Api["responses"], "getCustomer"> & { getCustomer: Customer };
};

export default connector;

const auth = connector.auth;

export class Client extends OpenApiClient<ShopifyApi> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(
      config,
      options,
      ...openApiClientOptions(connector, config, secrets, operations, {
        baseUrl: (version) => baseUrl(config, version),
        reshape: (operationId, body) =>
          operationId === "getCustomer" ? (body as { customer: unknown }).customer : body,
      }),
    );
  }

  /** `GET /shop.json` proves `access_token`. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/shop.json", auth.secret);
  }

  /**
   * Every page of customers. `cursor` is the `Link: rel="next"` URL.
   * The last page yields a null cursor.
   */
  @read
  customers(args: { limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Customer>(
      "listCustomers",
      {
        rows: "customers",
        next: { header: "link", rel: "next" },
      },
      { cursor: args.cursor, query: { limit: args.limit } },
    );
  }
}

function baseUrl(config: Record<string, unknown>, version: string): string {
  if (typeof config["base_url"] === "string" && config["base_url"] !== "")
    return config["base_url"];

  const shop = config["shop"];

  if (typeof shop !== "string" || shop === "") {
    throw new Error("shopify needs config.shop or config.base_url");
  }

  const host = shop.includes(".") ? shop : `${shop}.myshopify.com`;

  return `https://${host}/admin/api/${version}`;
}
