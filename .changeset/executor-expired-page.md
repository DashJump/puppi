---
"@puppi/executor-js": patch
---

An expired page token restarts the append walk without copying rows already staged. Resealing a stored page token keeps that page and appends only new rows.
