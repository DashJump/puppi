import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "posthog",
  docs: "https://posthog.com/docs/api",
  configSchema: { base_url: "string", project_id: "string" },
  secretFields: ["api_key"],
  auth: { scheme: "bearer", secret: "api_key" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://us.posthog.com",
});
