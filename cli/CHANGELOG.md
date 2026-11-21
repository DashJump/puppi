# @puppi/cli

## 0.2.2

### Patch Changes

- b2f2679: The project `puppi init` writes no longer calls `ctx.query()`, so its first run succeeds on filesystem storage.

## 0.2.1

### Patch Changes

- Updated dependencies [c0c898e]
- Updated dependencies [c0c898e]
  - @puppi/sdk@0.4.0
  - @puppi/executor-js@0.1.2

## 0.2.0

### Minor Changes

- f1ebac3: `@puppi/cli` publishes `.` only. The `./api`, `./bindings`, `./print`, and `./engine` subpaths are gone. `buildProject` and `BuildOutput` are no longer exported. The `puppi` bin still calls `main`.

### Patch Changes

- Updated dependencies [4ea475e]
  - @puppi/sdk@0.3.0
  - @puppi/executor-js@0.1.1
