import { defineConnector } from "@puppi/sdk";

/** A local directory. There is no credential and no HTTP auth scheme. */
export default defineConnector({
  type: "filesystem",
  docs: "https://puppi.dev/docs/connectors/filesystem/",
  configSchema: { root: "string" },
  secretFields: [],
  auth: { scheme: "none" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
});
