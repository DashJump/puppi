import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "usgs",
  docs: "https://earthquake.usgs.gov/fdsnws/event/1/",
  configSchema: { base_url: "string" },
  secretFields: [],
  auth: { scheme: "none" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://earthquake.usgs.gov/fdsnws/event/1",
});
