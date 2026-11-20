/**
 * A command or flag the user almost typed.
 *
 * Distance 2 is a typo (`buid`, `--engin-url`). Anything further is a
 * different word, and suggesting it would hide the real mistake again.
 * An exact match is distance 0, which is how `puppi run build` finds `build`.
 */

export function suggest(word: string, candidates: readonly string[]): string | undefined {
  const lowered = word.toLowerCase();
  let best: { name: string; distance: number; prefix: number } | undefined;

  for (const candidate of candidates) {
    const other = candidate.toLowerCase();
    const distance = editDistance(lowered, other);

    if (distance > 2) continue;

    const prefix = sharedPrefix(lowered, other);
    const closer =
      best === undefined ||
      distance < best.distance ||
      (distance === best.distance && prefix > best.prefix) ||
      (distance === best.distance && prefix === best.prefix && candidate.length < best.name.length);

    if (closer) best = { name: candidate, distance, prefix };
  }

  return best?.name;
}

function sharedPrefix(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;

  while (index < length && left[index] === right[index]) index += 1;

  return index;
}

function editDistance(left: string, right: string): number {
  const width = right.length + 1;
  let previous = Array.from({ length: width }, (_, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];

    for (let column = 1; column < width; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const insert = (current[column - 1] ?? 0) + 1;
      const remove = (previous[column] ?? 0) + 1;
      const replace = (previous[column - 1] ?? 0) + cost;

      current.push(Math.min(insert, remove, replace));
    }

    previous = current;
  }

  return previous[width - 1] ?? 0;
}
