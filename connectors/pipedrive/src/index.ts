/** Source connector for the Pipedrive CRM API. */

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
import { type Api, operations } from "./operations.js";

type ListId =
  | "getDeals"
  | "getPersons"
  | "getOrganizations"
  | "getActivities"
  | "getPipelines"
  | "getStages";

type RowOf<Id extends ListId> = NonNullable<
  NonNullable<Api["responses"][Id]> extends { data?: readonly (infer Row)[] | null } ? Row : never
>;

export type Deal = RowOf<"getDeals">;
export type Person = RowOf<"getPersons">;
export type Organization = RowOf<"getOrganizations">;
export type Activity = RowOf<"getActivities">;
export type Pipeline = RowOf<"getPipelines">;
export type Stage = RowOf<"getStages">;

export interface ListArgs {
  limit?: number;
  cursor?: PageArgs["cursor"];
}

export default connector;

const auth = connector.auth;

const LIST = {
  rows: "data",
  next: "additional_data.next_cursor",
  param: "cursor",
} as const satisfies PageRule;

export class Client extends OpenApiClient<Api> {
  private readonly host: string;

  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    const host = hostOf(config);
    const [defaults, openApi] = openApiClientOptions(connector, config, secrets, operations, {
      baseUrl: (version) => `${host}/api/${version}`,
    });

    super({ ...config, base_url: defaults.baseUrl }, options, defaults, openApi);
    this.host = host;
  }

  /** API v2 has no current-user operation, so the check uses v1. */
  override check(): Promise<CredentialCheck> {
    return this.prove(`${this.host}/api/v1/users/me`, auth.secret);
  }

  @read
  deals(args: ListArgs = {}) {
    return this.pages<Deal, "getDeals">("getDeals", LIST, pageArgs(args));
  }

  @read
  persons(args: ListArgs = {}) {
    return this.pages<Person, "getPersons">("getPersons", LIST, pageArgs(args));
  }

  @read
  organizations(args: ListArgs = {}) {
    return this.pages<Organization, "getOrganizations">("getOrganizations", LIST, pageArgs(args));
  }

  @read
  activities(args: ListArgs = {}) {
    return this.pages<Activity, "getActivities">("getActivities", LIST, pageArgs(args));
  }

  @read
  pipelines(args: ListArgs = {}) {
    return this.pages<Pipeline, "getPipelines">("getPipelines", LIST, pageArgs(args));
  }

  @read
  stages(args: ListArgs = {}) {
    return this.pages<Stage, "getStages">("getStages", LIST, pageArgs(args));
  }
}

function pageArgs(args: ListArgs): PageArgs {
  return { cursor: args.cursor, query: { limit: args.limit } };
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function hostOf(config: Record<string, unknown>): string {
  const override = config["base_url"];

  if (typeof override === "string" && override !== "") return trimSlash(override);

  const domain = config["company_domain"];

  if (typeof domain !== "string" || domain === "") {
    throw new Error("pipedrive requires company_domain");
  }

  if (!DNS_LABEL.test(domain)) {
    throw new Error(`pipedrive company_domain ${JSON.stringify(domain)} is not a DNS label`);
  }

  return `https://${domain}.pipedrive.com`;
}
