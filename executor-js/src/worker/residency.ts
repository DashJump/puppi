import type { ExecutorEvent, LogsEvent, ResultEvent, SpanEvent } from "../protocol.js";

export type Residency = "standard" | "strict";

/** What strict removed, and the text that stays on this machine. */
export interface Redaction {
  event: ExecutorEvent;
  fields: string[];
  text: Record<string, string>;
}

/**
 * `strict` drops user-written text before a frame leaves. Verdicts, error
 * classes, span names, durations, and non-string attributes stay. Shim spans
 * are metadata and are left alone. Checkpoints are positions; the trust
 * slice caps them.
 */
export function redact(event: ExecutorEvent, residency: Residency): Redaction {
  if (residency === "standard") return { event, fields: [], text: {} };

  switch (event.event) {
    case "log":
      return {
        event: { event: "log", level: event.level, message: "" },
        fields: ["message"],
        text: { message: event.message },
      };
    case "logs":
      return redactLogs(event);
    case "error":
      return {
        event: { ...event, message: event.class },
        fields: ["message"],
        text: { message: event.message },
      };
    case "span":
      return redactSpan(event);
    case "result":
      return redactResult(event);
    default:
      return { event, fields: [], text: {} };
  }
}

function redactLogs(event: LogsEvent): Redaction {
  const fields: string[] = [];
  const text: Record<string, string> = {};
  const lines = event.lines.map((line, index) => {
    if (line.message === "") return line;

    const field = `lines.${index}.message`;
    fields.push(field);
    text[field] = line.message;
    return { ...line, message: "" };
  });

  return { event: { event: "logs", lines }, fields, text };
}

function redactSpan(event: SpanEvent): Redaction {
  if (event.source !== "user") return { event, fields: [], text: {} };

  const attributes: SpanEvent["attributes"] = {};
  const text: Record<string, string> = {};
  const fields: string[] = [];

  for (const [key, value] of Object.entries(event.attributes)) {
    if (typeof value === "string") {
      text[`attributes.${key}`] = value;
      fields.push(`attributes.${key}`);
    } else {
      attributes[key] = value;
    }
  }

  return { event: { ...event, attributes }, fields, text };
}

function redactResult(event: ResultEvent): Redaction {
  const text: Record<string, string> = {};
  const fields: string[] = [];
  const check_results = event.check_results.map((check, index) => {
    if (typeof check.detail !== "string" || check.detail === "") return check;

    const field = `check_results.${index}.detail`;
    text[field] = check.detail;
    fields.push(field);
    return { ...check, detail: null };
  });

  return { event: { ...event, check_results }, fields, text };
}
