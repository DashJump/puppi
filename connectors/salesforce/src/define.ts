import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "salesforce",
  docs: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_query.htm",
  configSchema: { base_url: "string", api_version: "string" },
  secretFields: ["access_token"],
  auth: { scheme: "bearer", secret: "access_token" },
  apiVersions: ["v59.0", "v60.0"],
  defaultApiVersion: "v59.0",
});
