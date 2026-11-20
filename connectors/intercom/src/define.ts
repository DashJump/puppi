import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "intercom",
  docs: "https://developers.intercom.com/docs/references/rest-api/api.intercom.io",
  configSchema: { base_url: "string", api_version: "string" },
  secretFields: ["access_token"],
  auth: { scheme: "bearer", secret: "access_token" },
  apiVersions: ["2.17"],
  defaultApiVersion: "2.17",
  defaultBaseUrl: "https://api.intercom.io",
});
