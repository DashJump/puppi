/**
 * Append pages are siblings of the output ref. The key is the resume slot
 * (`page`, or the `processPages` page index), not a hash of the whole
 * checkpoint, so a retry of that slot overwrites the sibling even when
 * another field changed. The key is 128 bits, wide enough that distinct
 * slots do not collide inside one materialization.
 */

import { createHash } from "node:crypto";

export const PAGE_MARK = "__page_";

const PAGE_KEY = /^[0-9a-f]{32}$/;
const PROCESS_PAGES = "__puppi_process_pages";

export function isPageKey(key: string): boolean {
  return PAGE_KEY.test(key);
}

/**
 * Sibling key for this checkpoint. `existing` is the index already stored;
 * the same slot reuses its key so the page object is overwritten.
 */
export function pageKeyFor(existing: readonly string[], state: Record<string, unknown>): string {
  const key = createHash("sha256").update(pageSlot(state)).digest("hex").slice(0, 32);

  return existing.find((item) => item === key) ?? key;
}

/** The resume token this checkpoint names: the walk slot, not the whole map. */
export function pageSlot(state: Record<string, unknown>): string {
  const nested = state[PROCESS_PAGES];

  if (isPlainObject(nested) && "page" in nested) return `process:${canonical(nested["page"])}`;
  if ("page" in state) return `page:${canonical(state["page"])}`;

  return `state:${canonical(state)}`;
}

function canonical(value: unknown): string {
  return JSON.stringify(normalize(value));
}

/** Same distinctions as JSON.stringify: dates become ISO strings, bigints decimal. */
function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);

  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(value).sort()) {
      const item = value[key];

      if (item !== undefined) sorted[key] = normalize(item);
    }

    return sorted;
  }

  if (value !== null && typeof value === "object") {
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;

    if (typeof toJSON === "function") return normalize(toJSON.call(value));

    return {};
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  const proto: unknown = Object.getPrototypeOf(value);

  return proto === Object.prototype || proto === null;
}
