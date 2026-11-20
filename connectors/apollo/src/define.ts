import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "apollo",
  docs: "https://docs.apollo.io/reference/people-enrichment",
  configSchema: { base_url: "string" },
  secretFields: ["api_key"],
  auth: { scheme: "api_key_header", header: "x-api-key", secret: "api_key" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://api.apollo.io/api/v1",
});
