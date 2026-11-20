import { readFileSync } from "node:fs";

import { assertConformant, runSourceConformance } from "@puppi/conformance";
import { sample } from "openapi-sampler";
import { describe, expect, it } from "vite-plus/test";

import * as connector from "../src/index.js";
import { operations } from "../src/operations.js";

const config = { base_url: "https://sheets.googleapis.test", spreadsheet_id: "abc" };

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as {
  components: { schemas: Record<string, object> };
};

/** A response body from the pinned schema, with the fields this case cares about. */
function body(schema: object, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const sampled = sample(schema, { enablePatterns: true }, spec);

  return { ...(sampled as Record<string, unknown>), ...overrides };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fake(payload: unknown) {
  return scripted(() => payload);
}

function scripted(respond: (call: Call) => unknown) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: input instanceof Request ? input.url : String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };

    calls.push(call);

    return new Response(JSON.stringify(respond(call)), { status: 200 });
  }) as typeof fetch;

  const client = new connector.Client(config, { access_token: "ya29.test" }, { fetch: fetchImpl });

  return { calls, client };
}

describe("google sheets connector", () => {
  it("is a conformant source", async () => {
    assertConformant(
      await runSourceConformance({
        connector,
        operations,
        root: new URL("..", import.meta.url),
        config,
      }),
    );
  });

  it("proves the spreadsheet id", async () => {
    const { calls, client } = fake(
      body(spec.components.schemas["spreadsheet"]!, { spreadsheetId: "abc" }),
    );

    expect(await client.check()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(
      "https://sheets.googleapis.test/v4/spreadsheets/abc?fields=spreadsheetId",
    );
    expect(operations["getSpreadsheet"]?.path).toBe("/spreadsheets/{spreadsheetId}");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer ya29.test");
  });

  it("requests the encoded range and sends the bearer token", async () => {
    const range = "Sheet 1!A1:C";
    const { calls, client } = fake(
      body(spec.components.schemas["valueRange"]!, {
        range,
        majorDimension: "ROWS",
        values: [["name"], ["Ada"]],
      }),
    );

    await client.values(range);

    expect(calls[0]?.url).toBe(
      "https://sheets.googleapis.test/v4/spreadsheets/abc/values/Sheet%201!A1%3AC",
    );
    expect(operations["getValues"]?.path).toBe("/spreadsheets/{spreadsheetId}/values/{range}");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer ya29.test");
    expect(calls[0]?.url).not.toContain("ya29.test");
  });

  it("flattens a header row and a short data row", async () => {
    const { calls, client } = fake(
      body(spec.components.schemas["valueRange"]!, {
        range: "Sheet1!A1:D4",
        majorDimension: "ROWS",
        values: [["name", "city", "name", "name"], ["Ada", "London"], [], ["", ""]],
      }),
    );

    expect(await client.rows("Sheet1!A1:D4")).toEqual([
      { name: "Ada", city: "London", name_2: null, name_3: null },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("requires spreadsheet_id when a method needs it", async () => {
    const client = new connector.Client(
      { base_url: "https://sheets.googleapis.test" },
      { access_token: "ya29.test" },
      {
        fetch: async () => new Response("{}", { status: 200 }),
      },
    );

    expect(() => client.values("A1")).toThrow("google-sheets requires spreadsheet_id");
  });

  it("appends records under the header and stores null as an empty cell", async () => {
    const range = "Sheet1!A1:C";
    const appended = body(spec.components.schemas["appendValuesResponse"]!, {
      spreadsheetId: "abc",
      tableRange: "Sheet1!A1:C1",
      updates: {
        spreadsheetId: "abc",
        updatedRange: "Sheet1!A2:C2",
        updatedRows: 1,
        updatedCells: 3,
      },
    });
    const { calls, client } = scripted((call) =>
      call.method === "GET"
        ? body(spec.components.schemas["valueRange"]!, {
            range,
            majorDimension: "ROWS",
            values: [["name", "city", "name"]],
          })
        : appended,
    );

    expect(
      await client.appendRows(range, [{ name: "Ada", city: null, name_2: "Lovelace" }]),
    ).toEqual(appended);
    expect(calls[0]?.url).toBe(
      "https://sheets.googleapis.test/v4/spreadsheets/abc/values/Sheet1!A1%3AC",
    );
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe(
      "https://sheets.googleapis.test/v4/spreadsheets/abc/values/Sheet1!A1%3AC:append?valueInputOption=RAW",
    );
    expect(calls[1]?.url).not.toContain("insertDataOption");
    expect(calls[1]?.url).not.toContain("ya29.test");
    expect(calls[1]?.headers["authorization"]).toBe("Bearer ya29.test");
    expect(calls[1]?.body).toEqual({
      majorDimension: "ROWS",
      values: [["Ada", "", "Lovelace"]],
    });
  });

  it("overwrites the rows under the header and blanks a shorter tail", async () => {
    const range = "'Q3 plan'!B5:D9";
    const updated = body(spec.components.schemas["batchUpdateValuesResponse"]!, {
      spreadsheetId: "abc",
      totalUpdatedRows: 2,
      totalUpdatedCells: 6,
    });
    const { calls, client } = scripted((call) =>
      call.method === "GET"
        ? body(spec.components.schemas["valueRange"]!, {
            range,
            majorDimension: "ROWS",
            values: [
              ["name", "city", "name"],
              ["Ada", "London", "Lovelace"],
              ["Grace", "NYC", "Hopper"],
            ],
          })
        : updated,
    );

    expect(await client.updateRows(range, [{ name: "Ada", name_2: "Byron" }])).toEqual(updated);
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toBe(
      "https://sheets.googleapis.test/v4/spreadsheets/abc/values:batchUpdate",
    );
    expect(calls[1]?.headers["authorization"]).toBe("Bearer ya29.test");
    expect(calls[1]?.body).toEqual({
      valueInputOption: "RAW",
      data: [
        {
          range: "'Q3 plan'!B6",
          majorDimension: "ROWS",
          values: [
            ["Ada", "", "Byron"],
            ["", "", ""],
          ],
        },
      ],
    });
  });

  it("treats row 1 as the header of a column-only range", async () => {
    const updated = body(spec.components.schemas["batchUpdateValuesResponse"]!, {
      spreadsheetId: "abc",
      totalUpdatedRows: 1,
    });
    const { calls, client } = scripted((call) =>
      call.method === "GET"
        ? body(spec.components.schemas["valueRange"]!, {
            range: "Sheet1!A1:B2",
            values: [
              ["name", "city"],
              ["Ada", "London"],
            ],
          })
        : updated,
    );

    await client.updateRows("Sheet1!A:B", [{ name: "Grace" }]);

    expect(calls[1]?.body).toEqual({
      valueInputOption: "RAW",
      data: [{ range: "Sheet1!A2", majorDimension: "ROWS", values: [["Grace", ""]] }],
    });
  });

  it("starts an overwrite at the row after the header when the range is a sheet name", async () => {
    const updated = body(spec.components.schemas["batchUpdateValuesResponse"]!, {
      spreadsheetId: "abc",
      totalUpdatedRows: 1,
    });
    const { calls, client } = scripted((call) =>
      call.method === "GET"
        ? body(spec.components.schemas["valueRange"]!, {
            range: "Sheet1!A1:B2",
            values: [["name"], ["Ada"]],
          })
        : updated,
    );

    await client.updateRows("Sheet1", [{ name: "Grace" }]);

    expect(calls[1]?.body).toEqual({
      valueInputOption: "RAW",
      data: [{ range: "Sheet1!A2", majorDimension: "ROWS", values: [["Grace"]] }],
    });
  });

  it("clears a range and sends an empty body", async () => {
    const range = "Sheet 1!A1:C";
    const cleared = body(spec.components.schemas["clearValuesResponse"]!, {
      spreadsheetId: "abc",
      clearedRange: "Sheet 1!A1:C10",
    });
    const { calls, client } = scripted(() => cleared);

    expect(await client.clearValues(range)).toEqual(cleared);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(
      "https://sheets.googleapis.test/v4/spreadsheets/abc/values/Sheet%201!A1%3AC:clear",
    );
    expect(calls[0]?.headers["authorization"]).toBe("Bearer ya29.test");
    expect(calls[0]?.url).not.toContain("ya29.test");
    expect(calls[0]?.body).toEqual({});
  });

  it("refuses a column the header does not have, and does not write", async () => {
    const { calls, client } = scripted(() =>
      body(spec.components.schemas["valueRange"]!, {
        values: [["name", "city"]],
      }),
    );

    await expect(client.appendRows("Sheet1!A1:B", [{ rank: "1" }])).rejects.toThrow(
      'google-sheets column "rank" is not a header',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });

  it("marks append, update, and clear as writes", () => {
    const direction = Symbol.for("puppi.direction");
    const proto = connector.Client.prototype as unknown as Record<string, unknown>;
    const marked = (name: string) =>
      (proto[name] as { [key: symbol]: unknown } | undefined)?.[direction];

    expect(marked("appendRows")).toBe("write");
    expect(marked("updateRows")).toBe("write");
    expect(marked("clearValues")).toBe("write");
    expect(marked("rows")).toBe("read");
  });

  it("refuses a write when the range has no header row", async () => {
    const { calls, client } = scripted(() =>
      body(spec.components.schemas["valueRange"]!, { values: [] }),
    );

    await expect(client.updateRows("Sheet1!A1:B", [{ name: "Ada" }])).rejects.toThrow(
      'google-sheets range "Sheet1!A1:B" has no header row',
    );
    expect(calls).toHaveLength(1);
  });
});
