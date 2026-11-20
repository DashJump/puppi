# @puppi/sdk

## 0.3.0

### Minor Changes

- 4ea475e: `CredentialCheck` is what a connector `check()` returns on `@puppi/sdk`. It replaces the credential `CheckResult`. The custom-check verdict on `@puppi/sdk/protocol` is still `CheckResult`.
  
  `isStandardSchema` is no longer exported. `columnsOf` still accepts a Standard Schema.
