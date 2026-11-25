/** Source connector for Chargebee API v2, Product Catalog 2.0. */

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  type PageArgs,
  type PageRule,
  trimSlash,
} from "@puppi/sdk";

import connector from "./define.js";
import type {
  SchemaCustomer as Customer,
  SchemaInvoice as Invoice,
  SchemaItem as Item,
  SchemaSubscription as Subscription,
} from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type { Customer, Invoice, Item, Subscription };

export default connector;

const type = connector.type;
const auth = connector.auth;

const PAGE = { rows: "list", next: "next_offset", param: "offset" } as const satisfies PageRule;

const ENTITY = {
  list_customers: "customer",
  list_subscriptions: "subscription",
  list_invoices: "invoice",
  list_items: "item",
} as const;

/** A dot or other host character would send the API key to another host. */
const SITE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    const [defaults, openApi] = openApiClientOptions(connector, config, secrets, operations, {
      baseUrl: (version) => baseUrl(config, version),
      extract,
    });

    super({ ...config, base_url: defaults.baseUrl }, options, defaults, openApi);
  }

  override check(): Promise<CredentialCheck> {
    return this.prove("/customers?limit=1", auth.username);
  }

  @read
  customers(args: { limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Customer>("list_customers", PAGE, pageArgs(args));
  }

  @read
  subscriptions(args: { limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Subscription>("list_subscriptions", PAGE, pageArgs(args));
  }

  @read
  invoices(args: { limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Invoice>("list_invoices", PAGE, pageArgs(args));
  }

  @read
  items(args: { limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Item>("list_items", PAGE, pageArgs(args));
  }
}

function pageArgs(args: { limit?: number; cursor?: PageArgs["cursor"] }): PageArgs {
  return { cursor: args.cursor, query: { limit: args.limit } };
}

/** Each list entry wraps the resource (`{ customer }`). */
function extract(
  operationId: string,
  body: unknown,
): { data: unknown[]; next: string | null } | undefined {
  if (!Object.hasOwn(ENTITY, operationId)) return undefined;

  const entity = ENTITY[operationId as keyof typeof ENTITY];
  const record = body as { list?: unknown; next_offset?: unknown };
  const list = record?.list;

  if (!Array.isArray(list)) throw new Error('rows "list" is not an array');

  const next = record.next_offset;

  return {
    data: list.map((row) => (row as Record<string, unknown>)[entity]),
    next: typeof next === "string" && next !== "" ? next : null,
  };
}

function baseUrl(config: Record<string, unknown>, version: string): string {
  const override = config["base_url"];

  if (typeof override === "string" && override !== "") {
    return `${trimSlash(override)}/api/${version}`;
  }

  const site = config["site"];

  if (typeof site !== "string" || site === "") throw new Error(`${type} requires site`);

  if (!SITE.test(site)) throw new Error(`${type} site must be one DNS label`);

  return `https://${site}.chargebee.com/api/${version}`;
}
