import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "google-sheets",
  docs: "https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values",
  configSchema: { spreadsheet_id: "string", base_url: "string", api_version: "string" },
  secretFields: ["access_token"],
  auth: { scheme: "bearer", secret: "access_token" },
  apiVersions: ["v4"],
  defaultApiVersion: "v4",
  defaultBaseUrl: "https://sheets.googleapis.com",
});
