---
"@puppi/adapter-nager-date": minor
---

`@puppi/adapter-nager-date` calls Nager.Date API v4. `Holiday` no longer has `localName`, `fixed`, `global`, `counties`, `launchYear`, or `types`. `LongWeekend`, `nextWorldwide`, and `longWeekends` are removed. `next` returns an empty list when the country has no holiday in the next 365 days.
