# @puppi/adapter-filesystem

`@puppi/adapter-filesystem` stores each table materialization as one Parquet file under a local directory. The binding config field is `root`. There is no secret.

```ts
import * as filesystem from "@puppi/adapter-filesystem";
import { defineConfig } from "@puppi/sdk";

export default defineConfig({
  connections: { lake: filesystem },
});
```

Reference: <https://puppi.dev/docs/connectors/filesystem/>
