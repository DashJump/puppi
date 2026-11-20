/**
 * `@puppi/adapter-facebook-marketing`: a source connector over the Facebook
 * Marketing API. Auth is a bearer access token. The API version is a prefix
 * of the base URL (`/<version>`), from `api_version` or the default in
 * `define.ts`. `campaigns()` walks the list.
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
import type { SchemaCampaign as Campaign } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type { Campaign };

export default connector;

const auth = connector.auth;
const defaultBaseUrl = connector.defaultBaseUrl;

export class Client extends OpenApiClient<Api> {
  private readonly account: string;

  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    const account = accountId(config);
    const [defaults, openApi] = openApiClientOptions(connector, config, secrets, operations, {
      baseUrl: (version) => baseUrl(config, version),
      extract,
    });

    super({ ...config, base_url: defaults.baseUrl }, options, defaults, openApi);
    this.account = account;
  }

  /** `GET /<version>/{account}?fields=id` proves `access_token`. */
  override check(): Promise<CredentialCheck> {
    return this.prove(`/${this.account}?fields=id`, auth.secret);
  }

  /**
   * Every page of campaigns. `cursor` is `paging.cursors.after`, sent back
   * as `after`. Graph includes that cursor on the last page too; `paging.next`
   * is what says another page exists. Following `after` once `next` is gone
   * asks for a page the API answers with no rows and a new cursor, and the
   * walk never finishes. The last page yields a null cursor. `fields` is
   * always sent: the edge returns only `id` when it is omitted, which drops
   * name, status, and updated_time.
   */
  @read
  campaigns(args: { limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Campaign>(
      "listCampaigns",
      {
        rows: "data",
        next: "paging.cursors.after",
        param: "after",
      },
      {
        cursor: args.cursor,
        path: { account: this.account },
        query: { limit: args.limit, fields: CAMPAIGN_FIELDS },
      },
    );
  }
}

/** The campaign fields this client reads. The edge returns only `id` without `fields`. */
const CAMPAIGN_FIELDS = "id,name,status,updated_time";

/**
 * Campaign pages end when `paging.next` is absent. `cursors.after` is the
 * end of this page, including the last one, so it is not a signal to
 * continue. The cursor we hand back is `after` (or the `after` query on
 * `next`), not the URL: `next` can embed the access token, and the client
 * already sends that as a bearer header.
 */
function extract(
  operationId: string,
  body: unknown,
): { data: unknown[]; next: string | null } | undefined {
  if (operationId !== "listCampaigns") return undefined;

  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = record["data"];

  if (!Array.isArray(data)) throw new Error('rows "data" is not an array');

  const paging =
    record["paging"] !== null && typeof record["paging"] === "object"
      ? (record["paging"] as Record<string, unknown>)
      : undefined;
  const nextUrl = paging?.["next"];

  if (typeof nextUrl !== "string" || nextUrl === "") return { data, next: null };

  const cursors =
    paging?.["cursors"] !== null && typeof paging?.["cursors"] === "object"
      ? (paging["cursors"] as Record<string, unknown>)
      : undefined;
  const after = cursors?.["after"];

  if (typeof after === "string" && after !== "") return { data, next: after };

  let fromUrl: string | null = null;

  try {
    fromUrl = new URL(nextUrl, "https://graph.facebook.com").searchParams.get("after");
  } catch {
    fromUrl = null;
  }

  return { data, next: fromUrl && fromUrl !== "" ? fromUrl : null };
}

/** Graph host plus `/<version>`. `base_url` replaces the host. */
function baseUrl(config: Record<string, unknown>, version: string): string {
  const override = config["base_url"];
  const host = typeof override === "string" && override !== "" ? override : defaultBaseUrl;

  if (typeof host !== "string" || host === "") {
    throw new Error("facebook-marketing requires base_url");
  }

  return `${trimSlash(host)}/${version}`;
}

/** Graph ad-account ids are `act_` plus the id. A leading `act_` is not doubled. */
function accountId(config: Record<string, unknown>): string {
  const id = config["ad_account_id"];

  if (typeof id !== "string" || id.replace(/^act_/, "") === "") {
    throw new Error("facebook-marketing requires ad_account_id");
  }

  return `act_${id.replace(/^act_/, "")}`;
}
