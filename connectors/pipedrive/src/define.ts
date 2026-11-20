import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "pipedrive",
  docs: "https://developers.pipedrive.com/docs/api/v1/Deals",
  configSchema: { company_domain: "string", base_url: "string", api_version: "string" },
  secretFields: ["api_token"],
  auth: { scheme: "api_key_header", header: "x-api-token", secret: "api_token" },
  apiVersions: ["v2"],
  defaultApiVersion: "v2",
});
