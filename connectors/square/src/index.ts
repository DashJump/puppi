import {
  read,
  type CredentialCheck,
  type ClientOptions,
  type PageArgs,
  OpenApiClient,
  openApiClientOptions,
} from "@puppi/sdk";

import connector from "./define.js";
import type {
  SchemaCustomer as Customer,
  SchemaLocation as Location,
  SchemaOrder as Order,
  SchemaPayment as Payment,
  SchemaPaymentRefund as PaymentRefund,
  SchemaSearchOrdersQuery as OrdersQuery,
  operations as spec,
} from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type { Customer, Location, Order, OrdersQuery, Payment, PaymentRefund };

type ListQuery<Id extends "ListCustomers" | "ListPayments" | "ListPaymentRefunds"> = Omit<
  NonNullable<spec[Id]["parameters"]["query"]>,
  "cursor" | "limit"
>;

export type CustomersQuery = ListQuery<"ListCustomers">;
export type PaymentsQuery = ListQuery<"ListPayments">;
export type RefundsQuery = ListQuery<"ListPaymentRefunds">;

export default connector;

const auth = connector.auth;

const CURSOR = { next: "cursor", param: "cursor" } as const;

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
        headers: (version) => ({ "Square-Version": version }),
        extract,
      }),
    );
  }

  override check(): Promise<CredentialCheck> {
    return this.prove("/v2/locations", auth.secret);
  }

  /** Every location, including inactive ones, in one response. */
  @read
  async locations(): Promise<Location[]> {
    const body = await this.read("ListLocations");
    const locations = body?.locations;

    return Array.isArray(locations) ? locations : [];
  }

  @read
  payments(args: { query?: PaymentsQuery; limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Payment, "ListPayments">(
      "ListPayments",
      { rows: "payments", ...CURSOR },
      { cursor: args.cursor, query: { ...args.query, limit: args.limit } },
    );
  }

  @read
  customers(args: { query?: CustomersQuery; limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Customer, "ListCustomers">(
      "ListCustomers",
      { rows: "customers", ...CURSOR },
      { cursor: args.cursor, query: { ...args.query, limit: args.limit } },
    );
  }

  @read
  orders(args: {
    locationIds: readonly string[];
    query?: OrdersQuery;
    limit?: number;
    cursor?: PageArgs["cursor"];
  }) {
    return this.pages<Order, "SearchOrders">(
      "SearchOrders",
      { rows: "orders", ...CURSOR },
      {
        cursor: args.cursor,
        body: {
          location_ids: [...args.locationIds],
          query: args.query,
          limit: args.limit,
        },
      },
    );
  }

  @read
  refunds(args: { query?: RefundsQuery; limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<PaymentRefund, "ListPaymentRefunds">(
      "ListPaymentRefunds",
      { rows: "refunds", ...CURSOR },
      { cursor: args.cursor, query: { ...args.query, limit: args.limit } },
    );
  }
}

const ROWS = {
  ListCustomers: "customers",
  ListPayments: "payments",
  ListPaymentRefunds: "refunds",
  SearchOrders: "orders",
} as const;

// ListCustomers returns `{}` for an empty account. pages() requires the row field to be an array.
function extract(operationId: string, body: unknown): { data: unknown[]; next: null } | undefined {
  const key = ROWS[operationId as keyof typeof ROWS];

  if (key === undefined) return undefined;

  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};

  if (record[key] !== undefined) return undefined;

  return { data: [], next: null };
}
