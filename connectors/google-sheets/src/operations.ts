/** Generated from openapi.json. Do not edit. */

import type { BodyOf, Operation, RequestOf } from "@puppi/sdk";

import type { operations as spec } from "./openapi.js";

export type Api = {
  responses: {
    getSpreadsheet: BodyOf<spec["getSpreadsheet"]>;
    getValues: BodyOf<spec["getValues"]>;
    appendValues: BodyOf<spec["appendValues"]>;
    batchUpdateValues: BodyOf<spec["batchUpdateValues"]>;
    clearValues: BodyOf<spec["clearValues"]>;
  };
  requests: {
    appendValues: RequestOf<spec["appendValues"]>;
    batchUpdateValues: RequestOf<spec["batchUpdateValues"]>;
    clearValues: RequestOf<spec["clearValues"]>;
  };
};

export const operations: Record<keyof Api["responses"], Operation> = {
  getSpreadsheet: {
    method: "get",
    path: "/spreadsheets/{spreadsheetId}",
    query: ["fields"],
  },
  getValues: {
    method: "get",
    path: "/spreadsheets/{spreadsheetId}/values/{range}",
    query: [],
  },
  appendValues: {
    method: "post",
    path: "/spreadsheets/{spreadsheetId}/values/{range}:append",
    query: [
      "valueInputOption",
      "insertDataOption",
      "includeValuesInResponse",
      "responseValueRenderOption",
      "responseDateTimeRenderOption",
    ],
  },
  batchUpdateValues: {
    method: "post",
    path: "/spreadsheets/{spreadsheetId}/values:batchUpdate",
    query: [],
  },
  clearValues: {
    method: "post",
    path: "/spreadsheets/{spreadsheetId}/values/{range}:clear",
    query: [],
  },
};
