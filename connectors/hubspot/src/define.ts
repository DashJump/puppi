import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "hubspot",
  docs: "https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts/guide",
  configSchema: { base_url: "string", api_version: "string" },
  secretFields: ["access_token"],
  auth: { scheme: "bearer", secret: "access_token" },
  apiVersions: ["2026-09", "v3"],
  defaultApiVersion: "2026-09",
  defaultBaseUrl: "https://api.hubapi.com",
});
