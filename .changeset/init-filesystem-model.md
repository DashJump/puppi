---
"@puppi/cli": patch
---

The project `puppi init` writes no longer calls `ctx.query()`, so its first run succeeds on filesystem storage.
