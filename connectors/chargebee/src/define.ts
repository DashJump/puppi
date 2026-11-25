import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "chargebee",
  docs: "https://apidocs.chargebee.com/docs/api/customers#list_customers",
  configSchema: { site: "string", base_url: "string", api_version: "string" },
  secretFields: ["api_key"],
  auth: { scheme: "basic", username: "api_key" },
  apiVersions: ["v2"],
  defaultApiVersion: "v2",
});
