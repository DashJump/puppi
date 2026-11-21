import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "nager-date",
  docs: "https://nagerholidays.com/api",
  configSchema: { base_url: "string" },
  secretFields: [],
  auth: { scheme: "none" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  // Every operation path in the spec already starts with `/api/v4`.
  defaultBaseUrl: "https://nagerholidays.com",
});
