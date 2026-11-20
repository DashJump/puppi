import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "shopify",
  docs: "https://shopify.dev/docs/api/admin-rest/latest/resources/customer",
  configSchema: { shop: "string", base_url: "string", api_version: "string" },
  secretFields: ["access_token"],
  auth: {
    scheme: "api_key_header",
    header: "x-shopify-access-token",
    secret: "access_token",
  },
  apiVersions: ["2026-07", "2026-10"],
  defaultApiVersion: "2026-10",
});
