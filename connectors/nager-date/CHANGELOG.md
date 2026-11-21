# @puppi/adapter-nager-date

## 0.2.0

### Minor Changes

- 4123e5b: `@puppi/adapter-nager-date` calls Nager.Date API v4. `Holiday` no longer has `localName`, `fixed`, `global`, `counties`, `launchYear`, or `types`. `LongWeekend`, `nextWorldwide`, and `longWeekends` are removed. `next` returns an empty list when the country has no holiday in the next 365 days.

## 0.1.1

### Patch Changes

- Updated dependencies [c0c898e]
  - @puppi/sdk@0.4.0
