import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "notion",
  docs: "https://developers.notion.com/reference/query-a-data-source",
  configSchema: { base_url: "string", api_version: "string" },
  secretFields: ["token"],
  auth: { scheme: "bearer", secret: "token" },
  apiVersions: ["2026-03-11"],
  defaultApiVersion: "2026-03-11",
  defaultBaseUrl: "https://api.notion.com",
});
