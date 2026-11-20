import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "open-meteo",
  docs: "https://open-meteo.com/en/docs",
  configSchema: { base_url: "string", geocoding_url: "string", archive_url: "string" },
  secretFields: [],
  auth: { scheme: "none" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://api.open-meteo.com",
});
