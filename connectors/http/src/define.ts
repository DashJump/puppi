import { defineConnector } from "@puppi/sdk";

/** The client sends `bearer_token` and `api_key` itself. */
export default defineConnector({
  type: "http",
  docs: "https://puppi.dev/docs/connectors/http/",
  configSchema: {
    base_url: "string",
    headers: "json",
    api_key_header: "string",
    api_key_query: "string",
  },
  secretFields: ["bearer_token", "api_key"],
  auth: { scheme: "client" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
});
