/**
 * `@puppi/adapter-slack`: a source connector over the Slack Web API.
 * Auth is a bearer bot token. `conversations()` walks the list. A refusal
 * is HTTP 200 with `{ ok: false, error }`, which `responseError` turns into
 * a thrown error or a failed `check`.
 */

import {
  read,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  type PageArgs,
  type ResponseError,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaChannel } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type Channel = SchemaChannel;

/** `read("conversationsInfo")` answers with the channel, not Slack's envelope. */
type SlackApi = {
  responses: Omit<Api["responses"], "conversationsInfo"> & { conversationsInfo: Channel };
};

export default connector;

const auth = connector.auth;

const AUTHENTICATION = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

const AUTHORIZATION = new Set(["missing_scope", "not_allowed_token_type"]);

export class Client extends OpenApiClient<SlackApi> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(
      config,
      options,
      ...openApiClientOptions(connector, config, secrets, operations, { reshape, responseError }),
    );
  }

  /** `GET /conversations.list?limit=1` proves `bot_token`. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/conversations.list?limit=1", auth.secret);
  }

  /**
   * Every page of conversations. `cursor` is `response_metadata.next_cursor`.
   * An empty token ends the walk.
   */
  @read
  conversations(args: { limit?: number; cursor?: PageArgs["cursor"] } = {}) {
    return this.pages<Channel>(
      "conversationsList",
      {
        rows: "channels",
        next: "response_metadata.next_cursor",
        param: "cursor",
      },
      { cursor: args.cursor, query: { limit: args.limit } },
    );
  }
}

function reshape(operationId: string, body: unknown): unknown {
  return operationId === "conversationsInfo" ? (body as { channel: unknown }).channel : body;
}

function responseError(body: unknown): ResponseError | undefined {
  const { ok, error } = (body ?? {}) as { ok?: boolean; error?: string };

  if (ok !== false) return undefined;

  const code = error ?? "not_ok";

  if (AUTHENTICATION.has(code)) return { code, reason: "authentication" };
  if (AUTHORIZATION.has(code)) return { code, reason: "authorization" };

  return { code };
}
