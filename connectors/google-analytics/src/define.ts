import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "google-analytics",
  docs: "https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties",
  configSchema: { property_id: "string", base_url: "string", api_version: "string" },
  secretFields: ["access_token"],
  auth: { scheme: "bearer", secret: "access_token" },
  apiVersions: ["v1beta"],
  defaultApiVersion: "v1beta",
  defaultBaseUrl: "https://analyticsdata.googleapis.com",
});
