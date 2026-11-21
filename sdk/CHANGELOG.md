# @puppi/sdk

## 0.4.0

### Minor Changes

- c0c898e: `@puppi/sdk` no longer exports `validateSchedule`, `requestStream`, `isRateLimited`, `columnsOf`, `operationsModule`, `registerAdapter`, or `registerGroup`. A schedule or a column list is checked when `source`, `model`, or `destination` declares the asset. `adapter` and `group` register themselves.

## 0.3.0

### Minor Changes

- 4ea475e: `CredentialCheck` is what a connector `check()` returns on `@puppi/sdk`. It replaces the credential `CheckResult`. The custom-check verdict on `@puppi/sdk/protocol` is still `CheckResult`.

  `isStandardSchema` is no longer exported. `columnsOf` still accepts a Standard Schema.
