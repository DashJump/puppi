import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "podcast-index",
  docs: "https://podcastindex-org.github.io/docs-api/",
  configSchema: { base_url: "string" },
  secretFields: ["api_key"],
  auth: { scheme: "api_key_header", header: "X-Auth-Key", secret: "api_key" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://api.podcastindex.org/api/1.0",
});
