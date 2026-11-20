import { defineConfig } from "@puppi/sdk";

import { Client as ClearbitClient } from "./src/clearbit.js";
import * as rates from "./src/rates.js";
import { Client as WarehouseClient } from "./src/warehouse.js";

export default defineConfig({
  entry: "src/pipeline.ts",
  out: "dist",
  defaultStorage: "warehouse",
  connections: {
    warehouse: {
      type: "warehouse-stub",
      Client: WarehouseClient,
      clientModule: "./src/warehouse.js",
      config_schema: { database: "string" },
      secret_fields: ["password"],
    },
    enrichment: {
      type: "clearbit",
      configSchema: { base_url: "string" },
      secretFields: ["api_key"],
      clientModule: "./src/clearbit.js",
      Client: ClearbitClient,
    },
    rates,
  },
});
