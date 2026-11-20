/**
 * `@puppi/adapter-google-sheets`: reads ranges and writes records on the
 * Google Sheets API. Auth is a bearer access token. The API version is a
 * prefix of the base URL (`/<version>`), from `api_version` or the default
 * in `define.ts`.
 */

import {
  read,
  write,
  type CredentialCheck,
  type ClientOptions,
  OpenApiClient,
  openApiClientOptions,
  trimSlash,
} from "@puppi/sdk";

import connector from "./define.js";
import type {
  SchemaAppendValuesResponse,
  SchemaBatchUpdateValuesResponse,
  SchemaClearValuesResponse,
} from "./openapi.js";
import { type Api, operations } from "./operations.js";

export default connector;

const type = connector.type;
const auth = connector.auth;
const defaultBaseUrl = connector.defaultBaseUrl;

/**
 * RAW stores the text `rows()` reads back. USER_ENTERED would parse dates
 * and formulas, so a later read would not see the same strings.
 */
const RAW = "RAW";

/** One data row. Keys are the header cells. A cell the row did not include is null. */
export type Row = Record<string, string | null>;

export class Client extends OpenApiClient<Api> {
  private readonly spreadsheetId: string | undefined;

  constructor(
    config: Record<string, unknown>,
    secrets: Record<string, string> = {},
    options: ClientOptions = {},
  ) {
    const [defaults, openApi] = openApiClientOptions(connector, config, secrets, operations, {
      baseUrl: (version) => baseUrl(config, version),
    });

    super({ ...config, base_url: defaults.baseUrl }, options, defaults, openApi);

    const id = config["spreadsheet_id"];

    this.spreadsheetId = typeof id === "string" && id !== "" ? id : undefined;
  }

  /** `GET /<version>/spreadsheets/{spreadsheetId}?fields=spreadsheetId` proves `access_token`. */
  override check(): Promise<CredentialCheck> {
    return this.prove(`/spreadsheets/${this.spreadsheet()}?fields=spreadsheetId`, auth.secret);
  }

  /** One `values.get` body. The range is a path parameter; this does not pre-encode it. */
  @read
  values(range: string) {
    return this.read("getValues", {
      path: { spreadsheetId: this.spreadsheet(), range },
    });
  }

  /**
   * Header row, then one object per later row. A repeated header is `name`,
   * then `name_2`. A missing cell is null. Empty rows at the end are dropped.
   */
  @read
  async rows(range: string): Promise<Row[]> {
    const body = await this.values(range);

    return sheetRows(body.values ?? []);
  }

  /**
   * Appends `rows` after the table in `range`. The first row of `range` is
   * the header, with the same `name_2` names as `rows()`. Calling this again
   * appends the same records a second time.
   */
  @write
  async appendRows(range: string, rows: readonly Row[]): Promise<SchemaAppendValuesResponse> {
    const sheet = await this.values(range);
    const values = recordValues(sheet.values ?? [], rows, range);

    return this.read("appendValues", {
      path: { spreadsheetId: this.spreadsheet(), range },
      query: { valueInputOption: RAW },
      body: { majorDimension: "ROWS", values },
    });
  }

  /**
   * Replaces the rows under the header in `range`. A shorter list blanks the
   * leftover rows from that read. A longer list extends the sheet. The header
   * row is left as it was.
   */
  @write
  async updateRows(range: string, rows: readonly Row[]): Promise<SchemaBatchUpdateValuesResponse> {
    const sheet = await this.values(range);
    const table = sheet.values ?? [];
    const grid = recordValues(table, rows, range);
    const values = padRows(grid, table[0]?.length ?? 0, dataRows(table));

    // values.update is PUT. This client only dispatches GET and POST, so one
    // range goes through values.batchUpdate.
    return this.read("batchUpdateValues", {
      path: { spreadsheetId: this.spreadsheet() },
      body: {
        valueInputOption: RAW,
        data: [{ range: bodyRange(range, sheet.range), majorDimension: "ROWS", values }],
      },
    });
  }

  /** Clears values in `range` and leaves formatting. A header inside `range` is cleared too. */
  @write
  clearValues(range: string): Promise<SchemaClearValuesResponse> {
    return this.read("clearValues", {
      path: { spreadsheetId: this.spreadsheet(), range },
      body: {},
    });
  }

  private spreadsheet(): string {
    if (this.spreadsheetId === undefined) throw new Error(`${type} requires spreadsheet_id`);

    return this.spreadsheetId;
  }
}

/** Sheets host plus `/<version>`. `base_url` replaces the host. */
function baseUrl(config: Record<string, unknown>, version: string): string {
  const override = config["base_url"];
  const host = typeof override === "string" && override !== "" ? override : defaultBaseUrl;

  if (typeof host !== "string" || host === "") throw new Error("google-sheets requires base_url");

  return `${trimSlash(host)}/${version}`;
}

/** Header cells, with a repeated name written `name`, then `name_2`. */
function headerNames(row: readonly string[]): string[] {
  const seen = new Map<string, number>();

  return row.map((header) => {
    const count = (seen.get(header) ?? 0) + 1;

    seen.set(header, count);

    return count === 1 ? header : `${header}_${count}`;
  });
}

function blank(row: readonly string[]): boolean {
  return row.every((cell) => cell === "");
}

/** Objects from a values body. The first row is headers. Empty rows at the end are dropped. */
function sheetRows(values: readonly (readonly string[])[]): Row[] {
  const end = usedEnd(values);
  const headerRow = values[0];

  if (!headerRow || end <= 1) return [];

  const headers = headerNames(headerRow);

  return values.slice(1, end).map((cells) => {
    const row: Row = {};

    for (const [index, header] of headers.entries()) {
      row[header] = cells[index] ?? null;
    }

    return row;
  });
}

function dataRows(values: readonly (readonly string[])[]): number {
  return Math.max(0, usedEnd(values) - 1);
}

function usedEnd(values: readonly (readonly string[])[]): number {
  let end = values.length;

  while (end > 1 && blank(values[end - 1] ?? [])) end -= 1;

  return end;
}

/**
 * A null or missing cell is `""`. Sheets skips null and would leave the
 * previous value.
 */
function recordValues(
  values: readonly (readonly string[])[],
  rows: readonly Row[],
  range: string,
): string[][] {
  const header = values[0];

  if (!header || header.length === 0) {
    throw new Error(`google-sheets range ${JSON.stringify(range)} has no header row`);
  }

  const names = headerNames(header);
  const known = new Set(names);

  return rows.map((row) => {
    for (const key of Object.keys(row)) {
      if (!known.has(key)) {
        throw new Error(`google-sheets column ${JSON.stringify(key)} is not a header`);
      }
    }

    return names.map((name) => row[name] ?? "");
  });
}

function padRows(grid: string[][], width: number, rows: number): string[][] {
  if (grid.length >= rows) return grid;

  const blankRow = (): string[] => Array.from({ length: width }, () => "");

  return [...grid, ...Array.from({ length: rows - grid.length }, blankRow)];
}

/**
 * The row after the header. A column-only ref (`A:C`) starts at row 1, the
 * header `rows()` reads. A range with no cell uses the range Sheets returned.
 */
function bodyRange(requested: string, returned: string | undefined): string {
  const start = dataStart(requested) ?? (returned === undefined ? undefined : dataStart(returned));

  if (start === undefined) {
    throw new Error(`google-sheets range ${JSON.stringify(requested)} has no A1 cell`);
  }

  return start;
}

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)?$/;

function dataStart(a1: string): string | undefined {
  const { sheet, cells } = splitA1(a1);
  const match = CELL.exec(cells.split(":")[0] ?? "");

  if (!match) return undefined;

  const [, colAbs, col, rowAbs, row] = match;
  const next = `${colAbs ?? ""}${col ?? ""}${rowAbs ?? ""}${Number(row ?? "1") + 1}`;

  return sheet === undefined ? next : `${sheet}!${next}`;
}

function splitA1(a1: string): { sheet: string | undefined; cells: string } {
  if (a1.startsWith("'")) {
    for (let i = 1; i < a1.length; i += 1) {
      if (a1[i] === "'" && a1[i + 1] === "'") {
        i += 1;
        continue;
      }

      if (a1[i] !== "'") continue;

      const rest = a1.slice(i + 1);

      if (rest.startsWith("!")) return { sheet: a1.slice(0, i + 1), cells: rest.slice(1) };

      break;
    }
  }

  const bang = a1.indexOf("!");

  if (bang === -1) return { sheet: undefined, cells: a1 };

  return { sheet: a1.slice(0, bang), cells: a1.slice(bang + 1) };
}
