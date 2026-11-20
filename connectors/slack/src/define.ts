import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "slack",
  docs: "https://docs.slack.dev/reference/methods/conversations.list/",
  configSchema: { base_url: "string", api_version: "string" },
  secretFields: ["bot_token"],
  auth: { scheme: "bearer", secret: "bot_token" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://slack.com/api",
});
