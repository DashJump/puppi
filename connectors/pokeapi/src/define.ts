import { defineConnector } from "@puppi/sdk";

export default defineConnector({
  type: "pokeapi",
  docs: "https://pokeapi.co/docs/v2",
  configSchema: { base_url: "string" },
  secretFields: [],
  auth: { scheme: "none" },
  apiVersions: ["unversioned"],
  defaultApiVersion: "unversioned",
  defaultBaseUrl: "https://pokeapi.co/api/v2",
});
