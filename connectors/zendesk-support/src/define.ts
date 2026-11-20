import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "zendesk-support",
  docs: "https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/#list-tickets",
  configSchema: { subdomain: "string", base_url: "string", email: "string", api_version: "string" },
  secretFields: ["api_token"],
  auth: { scheme: "basic", username: "email", secret: "api_token", usernameSuffix: "/token" },
  apiVersions: ["v2"],
  defaultApiVersion: "v2",
});
