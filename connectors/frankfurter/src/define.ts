import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "frankfurter",
  docs: "https://frankfurter.dev/",
  configSchema: { base_url: "string" },
  secretFields: [],
  auth: { scheme: "none" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://api.frankfurter.dev/v1",
});
