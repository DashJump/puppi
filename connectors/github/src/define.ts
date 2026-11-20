import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "github",
  docs: "https://docs.github.com/en/rest/issues/issues#list-repository-issues",
  configSchema: { base_url: "string", api_version: "string" },
  secretFields: ["token"],
  auth: { scheme: "bearer", secret: "token" },
  apiVersions: ["2022-11-28"],
  defaultApiVersion: "2022-11-28",
  defaultBaseUrl: "https://api.github.com",
});
