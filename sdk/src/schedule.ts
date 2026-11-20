import type { Schedule } from "./types.js";

/**
 * Checks a schedule so a bad cron fails `puppi build`.
 * `timezone` is not checked here: this package has no time zone database.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface Field {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** The offset the first name maps to: months start at 1, weekdays at 0. */
  namesFrom?: number;
}

const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, namesFrom: 1 },
  { name: "day of week", min: 0, max: 7, names: WEEKDAYS, namesFrom: 0 },
];

const EVERY = /^(\d+)(m|h|d)$/;

const EVERY_RANGE = {
  m: { max: 59, cron: (n: string) => `*/${n} * * * *`, unit: "minutes" },
  h: { max: 23, cron: (n: string) => `0 */${n} * * *`, unit: "hours" },
  d: { max: 31, cron: (n: string) => `0 0 */${n} * *`, unit: "days" },
};

/**
 * Throws when the schedule could not fire.
 * Returns the schedule unchanged, in the form the manifest carries: an
 * `every` shorthand is kept as written, because the manifest is what the
 * user declared and the engine expands it the same way.
 */
export function validateSchedule(key: string, schedule: Schedule): Schedule {
  const cron = "cron" in schedule ? schedule.cron : expand(key, schedule.every);
  const fields = cron.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(
      `${key}: cron expression "${cron}" has ${fields.length} fields, expected 5 ` +
        `(minute hour day-of-month month day-of-week)`,
    );
  }

  for (const [index, text] of fields.entries()) validateField(key, cron, text, FIELDS[index]!);

  return schedule;
}

function expand(key: string, every: string): string {
  const match = EVERY.exec(every);

  if (!match) {
    throw new Error(`${key}: every must be <n>m, <n>h or <n>d, got "${every}"`);
  }

  const [, count, unit] = match as unknown as [string, string, "m" | "h" | "d"];
  const { max, cron, unit: word } = EVERY_RANGE[unit];
  const n = Number(count);

  if (n < 1 || n > max) {
    throw new Error(`${key}: every ${count} ${word} is outside 1..${max}`);
  }

  return cron(count);
}

function validateField(key: string, cron: string, text: string, field: Field): void {
  for (const item of text.toLowerCase().split(",")) validateItem(key, cron, item, field);
}

/** One comma-separated item: a span, optionally with a `/step`. */
function validateItem(key: string, cron: string, item: string, field: Field): void {
  const [body, step, ...rest] = item.split("/");

  if (rest.length > 0 || !body) {
    throw new Error(`${key}: "${item}" is not a valid ${field.name} in "${cron}"`);
  }

  if (step !== undefined && !(/^\d+$/.test(step) && Number(step) > 0)) {
    throw new Error(`${key}: the step in "${item}" must be a positive integer, in "${cron}"`);
  }

  if (body !== "*") validateSpan(key, cron, body, field);
}

/** A single value, or a range of two. */
function validateSpan(key: string, cron: string, body: string, field: Field): void {
  const [from, to, ...rest] = body.split("-");

  if (rest.length > 0 || from === undefined) {
    throw new Error(`${key}: "${body}" is not a valid ${field.name} in "${cron}"`);
  }

  const start = value(key, cron, from, field);

  if (to !== undefined && value(key, cron, to, field) < start) {
    throw new Error(`${key}: the range "${body}" runs backwards, in "${cron}"`);
  }
}

function value(key: string, cron: string, text: string, field: Field): number {
  const named = field.names?.indexOf(text) ?? -1;

  if (named >= 0) return named + (field.namesFrom ?? 0);

  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;

  if (Number.isNaN(parsed) || parsed < field.min || parsed > field.max) {
    throw new Error(
      `${key}: "${text}" is not a ${field.name} (${field.min}-${field.max}` +
        `${field.names ? ", or a name" : ""}), in "${cron}"`,
    );
  }

  return parsed;
}
