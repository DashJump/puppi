import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "square",
  docs: "https://developer.squareup.com/reference/square",
  configSchema: { base_url: "string", api_version: "string" },
  secretFields: ["access_token"],
  auth: { scheme: "bearer", secret: "access_token" },
  apiVersions: ["2026-09-16"],
  defaultApiVersion: "2026-09-16",
  defaultBaseUrl: "https://connect.squareup.com",
});
