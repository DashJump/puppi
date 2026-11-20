import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "sentry",
  docs: "https://docs.sentry.io/api/",
  configSchema: { base_url: "string" },
  secretFields: ["token"],
  auth: { scheme: "bearer", secret: "token" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://sentry.io",
});
