import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "nager-date",
  docs: "https://nagerholidays.com/api",
  configSchema: { base_url: "string" },
  secretFields: [],
  auth: { scheme: "none" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://date.nager.at/api/v3",
});
