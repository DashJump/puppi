import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "world-bank",
  docs: "https://datahelpdesk.worldbank.org/knowledgebase/articles/889392",
  configSchema: { base_url: "string" },
  secretFields: [],
  auth: { scheme: "none" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://api.worldbank.org/v2",
});
