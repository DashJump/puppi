import {
  eachPage,
  read,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  trimSlash,
} from "@puppi/sdk";

import connector from "./define.js";
import type { SchemaRunReportRequest, SchemaRunReportResponse } from "./openapi.js";
import { type Api, operations } from "./operations.js";

export type RunReportBody = Omit<SchemaRunReportRequest, "offset">;

/** Keys are the dimension names, then the metric names. A missing cell is null. */
export type ReportRow = Record<string, string | null>;

export default connector;

const type = connector.type;
const auth = connector.auth;
const defaultBaseUrl = connector.defaultBaseUrl;

export class Client extends OpenApiClient<Api> {
  private readonly propertyId: string;

  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    const id = propertyId(config);
    const [defaults, openApi] = openApiClientOptions(connector, config, secrets, operations, {
      baseUrl: (version) => baseUrl(config, version),
    });

    super({ ...config, base_url: defaults.baseUrl }, options, defaults, openApi);
    this.propertyId = id;
  }

  override check(): Promise<CredentialCheck> {
    return this.prove(`/properties/${encodeURIComponent(this.propertyId)}/metadata`, auth.secret);
  }

  @read
  getMetadata() {
    return this.read("properties.getMetadata", { path: { property: this.propertyId } });
  }

  @read
  runReport(args: { body?: RunReportBody; cursor?: string | null } = {}) {
    const body = args.body ?? {};

    return eachPage({
      cursor: args.cursor ?? null,
      fetchPage: async (cursor) => {
        const start = rowOffset(cursor);
        const report = await this.read("properties.runReport", {
          path: { property: this.propertyId },
          body: cursor === null ? body : { ...body, offset: cursor },
        });

        return { data: reportRows(report), next: nextOffset(report, start) };
      },
    });
  }
}

function baseUrl(config: Record<string, unknown>, version: string): string {
  const override = config["base_url"];
  const host = typeof override === "string" && override !== "" ? override : defaultBaseUrl;

  return `${trimSlash(host)}/${version}`;
}

function propertyId(config: Record<string, unknown>): string {
  const id = config["property_id"];

  if (typeof id !== "string" || id === "" || id.includes("/")) {
    throw new Error(`${type} requires property_id`);
  }

  return id;
}

function rowOffset(cursor: string | null): number {
  if (cursor === null) return 0;

  const offset = Number(cursor);

  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`${type} offset ${JSON.stringify(cursor)} is not a row index`);
  }

  return offset;
}

/** The response does not echo offset, so the next offset is sent + returned, and the walk stops at rowCount. */
function nextOffset(report: SchemaRunReportResponse, start: number): string | null {
  const returned = report.rows?.length ?? 0;
  const total = report.rowCount;
  const advance = start + returned;

  if (returned === 0 || typeof total !== "number" || advance >= total) return null;

  return String(advance);
}

function reportRows(report: SchemaRunReportResponse): ReportRow[] {
  const dimensions = columnNames(report.dimensionHeaders);
  const metrics = columnNames(report.metricHeaders);

  return (report.rows ?? []).map((row) => {
    const record: ReportRow = {};

    for (const [index, name] of dimensions.entries()) {
      record[name] = row.dimensionValues?.[index]?.value ?? null;
    }

    for (const [index, name] of metrics.entries()) {
      record[name] = row.metricValues?.[index]?.value ?? null;
    }

    return record;
  });
}

function columnNames(headers: { name?: string }[] | undefined): string[] {
  return (headers ?? []).map((header) => header.name ?? "");
}
