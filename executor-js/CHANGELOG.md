# @puppi/executor-js

## 0.2.0

### Minor Changes

- 0b4aea4: A cancelling attempt writes `{"abort":true}` and waits 30 seconds. HTTP `409 {"error":"cancelled"}` takes that grace. `409 {"error":"stale_fence"}` stops immediately.

## 0.1.2

### Patch Changes

- c0c898e: An expired page token restarts the append walk without copying rows already staged. Resealing a stored page token keeps that page and appends only new rows.
- Updated dependencies [c0c898e]
  - @puppi/sdk@0.4.0
  - @puppi/adapter-storage@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [4ea475e]
  - @puppi/sdk@0.3.0
  - @puppi/adapter-storage@0.1.1
