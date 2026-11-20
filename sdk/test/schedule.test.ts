import { beforeEach, describe, expect, it } from "vitest";

import type { Schedule } from "../src/index.js";
import { reset, sdk } from "./support/registry.js";

beforeEach(async () => {
  await reset();
});

function scheduled(schedule: Schedule) {
  return sdk.source({
    key: "raw/a",
    mode: "full_refresh",
    schedule,
    run: async () => {},
  });
}

describe("a declared schedule", () => {
  it("lands on the declaration as written, so the manifest carries what the user wrote", () => {
    scheduled({ cron: "*/15 * * * *", timezone: "Europe/Berlin" });

    expect(sdk.collect().assets["raw/a"]?.schedule).toEqual({
      cron: "*/15 * * * *",
      timezone: "Europe/Berlin",
    });
  });

  it("keeps the every shorthand, which the engine expands", () => {
    scheduled({ every: "15m" });

    expect(sdk.collect().assets["raw/a"]?.schedule).toEqual({ every: "15m" });
  });

  it("is absent when none is declared, so an unscheduled asset is unchanged", () => {
    sdk.source({
      key: "raw/a",
      mode: "full_refresh",
      run: async () => {},
    });

    expect(sdk.collect().assets["raw/a"]).not.toHaveProperty("schedule");
  });
});

describe("validation", () => {
  it("accepts the five-field grammar", () => {
    for (const [index, cron] of [
      "* * * * *",
      "*/15 * * * *",
      "0 9 * * mon-fri",
      "30 1,13 1 */2 *",
      "0 0 1 jan sun",
      "0 0 * * 7",
    ].entries()) {
      expect(() =>
        sdk.source({
          key: `raw/cron-${index}`,
          mode: "full_refresh",
          schedule: { cron },
          run: async () => {},
        }),
      ).not.toThrow();
    }
  });

  it("rejects a typo at declaration, not at deploy", () => {
    // `puppi build` fails here, next to the asset, rather than at deploy.
    expect(() => scheduled({ cron: "*/15 * * *" })).toThrow(/has 4 fields, expected 5/);
    expect(() => scheduled({ cron: "60 * * * *" })).toThrow(/not a minute/);
    expect(() => scheduled({ cron: "0 0 * * funday" })).toThrow(/not a day of week/);
    expect(() => scheduled({ cron: "0 9-5 * * *" })).toThrow(/runs backwards/);
    expect(() => scheduled({ cron: "*/0 * * * *" })).toThrow(/positive integer/);
    expect(() => scheduled({ every: "15 minutes" })).toThrow(/every must be/);
    expect(() => scheduled({ every: "90m" })).toThrow(/outside 1\.\.59/);
  });

  it("names the asset in the message, since a build reports many at once", () => {
    expect(() => scheduled({ cron: "nope" })).toThrow(/^raw\/a:/);
  });

  it("leaves the time zone to the engine, which has a database to check it against", () => {
    // This package has no time zone database, so a name is accepted here.
    expect(() => scheduled({ cron: "0 9 * * *", timezone: "Mars/Olympus" })).not.toThrow();
  });
});
