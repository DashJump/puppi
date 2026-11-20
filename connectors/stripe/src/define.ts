import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "stripe",
  docs: "https://docs.stripe.com/api/customers/list",
  configSchema: { base_url: "string", api_version: "string" },
  secretFields: ["api_key"],
  auth: { scheme: "bearer", secret: "api_key" },
  apiVersions: ["2024-06-20"],
  defaultApiVersion: "2024-06-20",
  defaultBaseUrl: "https://api.stripe.com",
});
