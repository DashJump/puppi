/**
 * `@puppi/adapter-github`: a source connector over the GitHub REST API.
 * Auth is a bearer token. The API version is pinned by `define.ts` and may
 * be overridden with `api_version` on the binding. `issues()` walks
 * `GET /repos/{owner}/{repo}/issues`.
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
        headers: (version) => ({
          accept: "application/vnd.github+json",
          "x-github-api-version": version,
        }),
      }),
    );
  }

  /** `GET /user` proves `token`. */
  override check(): Promise<CredentialCheck> {
    return this.prove("/user", auth.secret);
  }

  /**
   * Every page of issues in `owner`/`repo`, including pull requests.
   * `cursor` is the `Link: rel="next"` URL. The last page yields a null
   * cursor. The body is the row array. `perPage`, `state`, and `since` are
   * sent only when the caller passed them. GitHub's default `state` is
   * `open`.
   */
  @read
  issues(args: {
    owner: string;
    repo: string;
    state?: "open" | "closed" | "all";
    since?: string;
    perPage?: number;
    cursor?: PageArgs["cursor"];
  }) {
    return this.pages<Issue>(
      "listIssues",
      {
        rows: "$",
        next: { header: "link", rel: "next" },
      },
      {
        cursor: args.cursor,
        path: { owner: args.owner, repo: args.repo },
        query: { state: args.state, since: args.since, per_page: args.perPage },
      },
    );
  }
}
