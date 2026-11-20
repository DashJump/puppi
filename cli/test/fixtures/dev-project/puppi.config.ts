import { defineConfig } from "@puppi/sdk";

import { Client } from "./src/warehouse.js";

export default defineConfig({
  entry: "src/pipeline.ts",
  out: "dist",
  connections: {
    warehouse: {
      type: "warehouse-stub",
      Client,
      clientModule: "./src/warehouse.js",
    },
  },
});
