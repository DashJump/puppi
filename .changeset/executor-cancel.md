---
"@puppi/executor-js": minor
---

A cancelling attempt writes `{"abort":true}` and waits 30 seconds. HTTP `409 {"error":"cancelled"}` takes that grace. `409 {"error":"stale_fence"}` stops immediately.
