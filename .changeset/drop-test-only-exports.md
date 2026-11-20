---
"@puppi/sdk": minor
---

`@puppi/sdk` no longer exports `validateSchedule`, `requestStream`, `isRateLimited`, `columnsOf`, `operationsModule`, `registerAdapter`, or `registerGroup`. A schedule or a column list is checked when `source`, `model`, or `destination` declares the asset. `adapter` and `group` register themselves.
