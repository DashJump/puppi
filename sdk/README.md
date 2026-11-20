# @puppi/sdk

`@puppi/sdk` is what a pipeline imports: `defineConfig`, `source`, `model`, and the `Ctx` type.

```bash
npm install @puppi/sdk
```

```ts
import { defineConfig, model, source } from "@puppi/sdk";
import type { Ctx } from "@puppi/sdk";
```

`puppi init` writes the `defineConfig` import into `puppi.config.ts` and the `source` / `model` import into `src/pipeline.ts`.

`puppi-write-operations` reads an OpenAPI document and writes `src/operations.ts`. The `generate` script from `puppi connector new` calls that bin.

Run only pipeline code you trust; the worker executes that code with access to its configured connections and secrets.

User docs: <https://puppi.dev/docs>
