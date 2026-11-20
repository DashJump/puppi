import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "facebook-marketing",
  docs: "https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/campaigns",
  configSchema: { ad_account_id: "string", base_url: "string", api_version: "string" },
  secretFields: ["access_token"],
  auth: { scheme: "bearer", secret: "access_token" },
  apiVersions: ["v25.0", "v26.0"],
  defaultApiVersion: "v26.0",
  defaultBaseUrl: "https://graph.facebook.com",
});
