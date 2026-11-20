import {
  read,
  TerminalError,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  type PageArgs,
  type PageRule,
} from "@puppi/sdk";

import connector from "./define.js";
import type { operations as spec } from "./openapi.js";
import { type Api, operations } from "./operations.js";

type Row<Body> = NonNullable<Body> extends readonly (infer Item)[] ? Item : never;

export type Project = Row<Api["responses"]["listOrganizationProjects"]>;
export type Issue = Row<Api["responses"]["listOrganizationIssues"]>;
export type ProjectEvent = Row<Api["responses"]["listProjectEvents"]>;
export type IssueSort = NonNullable<
  NonNullable<spec["listOrganizationIssues"]["parameters"]["query"]>["sort"]
>;

export default connector;

const auth = connector.auth;

const SENTRY_PAGE = {
  rows: "$",
  next: { header: "link", rel: "next" },
} as const satisfies PageRule;

export class Client extends OpenApiClient<Api> {
  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    super(
      config,
      options,
      ...openApiClientOptions(connector, config, secrets, operations, { extract }),
    );
  }

  /** `GET /api/0/organizations/` proves `token`. A 403 names scope `org:read`. */
  override async check(): Promise<CredentialCheck> {
    const result = await this.prove("/api/0/organizations/", auth.secret);

    if (result.ok || result.reason !== "authorization") return result;

    return { ok: false, reason: "authorization", message: `${result.message} (scope org:read)` };
  }

  /**
   * Every page of projects in `organization`. `perPage` and `query` are sent
   * only when the caller passed them. `cursor` is the next page URL, or null
   * when `Link` `rel="next"` has `results` other than `true`.
   */
  @read
  projects(args: {
    organization: string;
    query?: string;
    perPage?: number;
    cursor?: PageArgs["cursor"];
  }) {
    return this.pages<Project>("listOrganizationProjects", SENTRY_PAGE, {
      cursor: args.cursor,
      path: { organization_id_or_slug: args.organization },
      query: { per_page: args.perPage, query: args.query },
    });
  }

  /**
   * Every page of issues in `organization`. Omitting `query` leaves Sentry's
   * default `is:unresolved`; pass `""` for every issue. `project` and
   * `environment` each send one value. `cursor` is the next page URL, or null
   * when `Link` `rel="next"` has `results` other than `true`.
   */
  @read
  issues(args: {
    organization: string;
    query?: string;
    limit?: number;
    sort?: IssueSort;
    project?: string;
    environment?: string;
    statsPeriod?: string;
    start?: string;
    end?: string;
    cursor?: PageArgs["cursor"];
  }) {
    return this.pages<Issue>("listOrganizationIssues", SENTRY_PAGE, {
      cursor: args.cursor,
      path: { organization_id_or_slug: args.organization },
      query: {
        query: args.query,
        limit: args.limit,
        sort: args.sort,
        project: args.project,
        environment: args.environment,
        statsPeriod: args.statsPeriod,
        start: args.start,
        end: args.end,
      },
    });
  }

  /**
   * Every page of error events for one project. `full: true` includes the
   * stacktrace and Sentry caps that page at 10. `statsPeriod` overrides
   * `start` and `end` when both are sent. `cursor` is the next page URL, or
   * null when `Link` `rel="next"` has `results` other than `true`.
   */
  @read
  events(args: {
    organization: string;
    project: string;
    statsPeriod?: string;
    start?: string;
    end?: string;
    full?: boolean;
    sample?: boolean;
    cursor?: PageArgs["cursor"];
  }) {
    return this.pages<ProjectEvent>("listProjectEvents", SENTRY_PAGE, {
      cursor: args.cursor,
      path: {
        organization_id_or_slug: args.organization,
        project_id_or_slug: args.project,
      },
      query: {
        statsPeriod: args.statsPeriod,
        start: args.start,
        end: args.end,
        full: args.full,
        sample: args.sample,
      },
    });
  }
}

/**
 * Sentry sends `rel="next"` on the last page too. The walk continues only
 * when that link's `results` parameter is `true`.
 */
function extract(
  operationId: string,
  body: unknown,
  headers: Headers,
): { data: unknown[]; next: string | null } | undefined {
  if (
    operationId !== "listOrganizationProjects" &&
    operationId !== "listOrganizationIssues" &&
    operationId !== "listProjectEvents"
  ) {
    return undefined;
  }

  if (!Array.isArray(body)) {
    // A 200 that is not an array cannot succeed on retry.
    throw new TerminalError(
      `expected a JSON array, received ${JSON.stringify(body).slice(0, 200)}`,
    );
  }

  return { data: body, next: nextUrl(headers) };
}

function nextUrl(headers: Headers): string | null {
  const header = headers.get("link");

  if (!header) return null;

  for (const part of header.split(",")) {
    const url = /<([^>]+)>/.exec(part)?.[1];

    if (!url) continue;

    const params = linkParams(part);

    if (params.get("rel") === "next" && params.get("results") === "true") return url;
  }

  return null;
}

function linkParams(part: string): Map<string, string> {
  const params = new Map<string, string>();
  const body = part.replace(/<[^>]*>/, "");

  for (const piece of body.split(";")) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*"?([^";]*)"?\s*$/.exec(piece);

    if (match?.[1]) params.set(match[1], match[2] ?? "");
  }

  return params;
}
