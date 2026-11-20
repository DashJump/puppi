/**
 * Reads PostHog persons, insights, and HogQL queries.
 */

import {
  read,
  TerminalError,
  type CredentialCheck,
  type ClientOptions,
  type PageRule,
  OpenApiClient,
  openApiClientOptions,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaInsight, SchemaPersonListRecord } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type Person = SchemaPersonListRecord;
export type Insight = SchemaInsight;

export default connector;

const type = connector.type;
const auth = connector.auth;

const NEXT_URL = {
  rows: "results",
  next: "next",
} as const satisfies PageRule;

export class Client extends OpenApiClient<Api> {
  private readonly projectId: string;

  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    const projectId = config["project_id"];

    if (typeof projectId !== "string" || projectId === "") {
      throw new Error(`${type} requires project_id`);
    }

    super(config, options, ...openApiClientOptions(connector, config, secrets, operations));
    this.projectId = projectId;
  }

  override check(): Promise<CredentialCheck> {
    return this.prove("/api/users/@me/", auth.secret);
  }

  @read
  persons(args: { limit?: number; cursor?: string | null } = {}) {
    return this.pages<Person, "persons_list">("persons_list", NEXT_URL, {
      cursor: args.cursor,
      path: { project_id: this.projectId },
      query: { limit: args.limit },
    });
  }

  @read
  insights(args: { limit?: number; cursor?: string | null } = {}) {
    return this.pages<Insight, "insights_list">("insights_list", NEXT_URL, {
      cursor: args.cursor,
      path: { project_id: this.projectId },
      query: { limit: args.limit },
    });
  }

  @read
  async query(args: { query: string }): Promise<Record<string, unknown>[]> {
    const response: unknown = await this.read("query_create", {
      path: { project_id: this.projectId },
      body: { query: { kind: "HogQLQuery", query: args.query } },
    });

    return queryRows(response);
  }
}

function queryRows(body: unknown): Record<string, unknown>[] {
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const columns = columnNames(record["columns"]);
  const results = record["results"];

  if (!Array.isArray(results)) throw new TerminalError("posthog query returned no results");

  return results.map((row) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw new TerminalError("posthog query row length does not match columns");
    }

    const object: Record<string, unknown> = {};

    for (const [index, name] of columns.entries()) object[name] = row[index];

    return object;
  });
}

function columnNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TerminalError("posthog query returned no columns");

  const names: string[] = [];

  for (const name of value) {
    if (typeof name !== "string") throw new TerminalError("posthog query returned no columns");

    names.push(name);
  }

  return names;
}
