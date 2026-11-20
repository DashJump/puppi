import { defineConnector } from "@puppi/sdk";

/** The client applies `password`, `url`, or `ca` itself. */
export default defineConnector({
  type: "postgres",
  docs: "https://www.postgresql.org/docs/current/libpq-connect.html",
  configSchema: {
    host: "string",
    port: "integer",
    database: "string",
    user: "string",
    ssl: "boolean",
  },
  secretFields: ["password", "url", "ca"],
  auth: { scheme: "client" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
});
