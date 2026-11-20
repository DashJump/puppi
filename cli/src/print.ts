/**
 * Terminal output. `show` writes a command's result. A command may still
 * write progress while it waits; that output is not the result.
 */

export function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function heading(title: string, why?: string): void {
  out();
  out(`━━ ${title}`);
  if (why) for (const line of why.split("\n")) out(`   ${line}`);
  out();
}

export function note(line: string): void {
  out(`   ${line}`);
}

/** A command's result under `--json`. */
function json(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

/**
 * Writes a command's result. `--json` prints the object; otherwise `render`
 * writes the human layout. Warnings stay on stderr, from the command itself,
 * so they show up in both modes.
 */
export function show(data: unknown, asJson: boolean, render?: (data: unknown) => void): void {
  if (asJson) {
    json(data);
    return;
  }

  render?.(data);
}

/** Rows as columns, left-aligned, header underlined. Cells longer than `max` are cut. */
export function table(
  columns: string[],
  rows: (string | number | null | undefined)[][],
  max = 48,
): void {
  const cells = rows.map((row) =>
    row.map((cell) => clip(cell === null || cell === undefined ? "" : String(cell), max)),
  );
  const widths = columns.map((column, i) =>
    Math.max(column.length, ...cells.map((row) => row[i]?.length ?? 0)),
  );
  const line = (row: string[]): string =>
    `   ${row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ")}`.trimEnd();

  out(line(columns));
  out(line(widths.map((width) => "─".repeat(width))));
  for (const row of cells) out(line(row));
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ");

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The gap between two timestamps, blank when either end is missing. */
export function seconds(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return "";

  return `${((Date.parse(to) - Date.parse(from)) / 1000).toFixed(1)}s`;
}

/** The first 8 characters of a uuid: enough to recognise, short enough for a column. */
export function short(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : "";
}

/** `1 asset`, and `0 assets` / `2 assets`. */
export function counted(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/**
 * Seconds of an engine timestamp, for text, with the zone written out.
 * These clocks are UTC. A value with no zone reads as a local time, so `Z`
 * is written back. An offset that arrived with the value is kept.
 */
export function zoned(iso: string | null | undefined): string {
  if (!iso) return "";

  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(iso);

  if (!match?.[1]) return iso;

  return `${match[1]}${match[2] ?? "Z"}`;
}
