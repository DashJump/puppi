export function statusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;

  const status = (error as { status?: unknown }).status;

  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

export function chain(error: unknown): unknown[] {
  const nodes: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== null && current !== undefined && !seen.has(current)) {
    nodes.push(current);

    if (typeof current !== "object") break;

    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }

  return nodes;
}

export function text(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;

  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;

    if (typeof message === "string") return message;
  }

  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }

  return "";
}
