import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "hubspot",
  docs: "https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide",
  configSchema: { base_url: "string", api_version: "string" },
  secretFields: ["access_token"],
  auth: { scheme: "bearer", secret: "access_token" },
  apiVersions: ["v3"],
  defaultApiVersion: "v3",
  defaultBaseUrl: "https://api.hubapi.com",
});
