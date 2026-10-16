import type { Env } from "./types";
import { id, now } from "./http";
const SENSITIVE_DETAIL_KEY =
  /token|secret|cookie|password|authorization|api[_-]?key|url/i;
const SENSITIVE_FIELD_KEY =
  /token|secret|cookie|password|authorization|api[_-]?key/i;
const LOG_SCAN_LIMIT = 16 * 1024;
function redactText(message: string): string {
  return (
    message
      // Decode individual JSON keys even when JSON is embedded in an error
      // prefix. Bound key matching; values may end at a truncated line/input.
      .replace(
        /("(?:\\.|[^"\\\r\n]){1,256}")([ \t]*:[ \t]*)("(?:\\.|[^"\\\r\n])*(?:"|\\?(?=[\r\n]|$)))/g,
        (match, key: string, separator: string) => {
          try {
            return SENSITIVE_FIELD_KEY.test(JSON.parse(key))
              ? `${key}${separator}"[redacted]"`
              : match;
          } catch {
            return match;
          }
        },
      )
      .replace(
        /((?:password|secret|token|authorization|cookie|api[_-]?key)[\w-]{0,128}["']?\s*[=:]\s*)("(?:\\.|[^"\\\r\n])*(?:"|\\?(?=[\r\n]|$))|'(?:\\.|[^'\\\r\n])*(?:'|\\?(?=[\r\n]|$)))/gi,
        (_match, prefix: string, value: string) =>
          `${prefix}${value[0]}[redacted]${value[0]}`,
      )
      // Header values can contain spaces (Basic) or several semicolon-separated cookies.
      .replace(
        /((?:authorization|cookie)\s*[=:][ \t]*)[^\r\n]+/gi,
        "$1[redacted]",
      )
      .replace(
        /((?:password|secret|token|authorization|cookie|api[_-]?key)[\w-]{0,128}["']?\s*[=:]\s*)(?!["'])[^\s,;}]+/gi,
        "$1[redacted]",
      )
      .replace(/(?:Bearer\s+)[^\s"',;]+/gi, "Bearer [redacted]")
      .replace(/https?:\/\/[^\s]+/gi, (match) => {
        try {
          const u = new URL(match);
          return `${u.origin}${u.pathname}`;
        } catch {
          return "[url]";
        }
      })
      .slice(0, 1500)
  );
}
export function redact(message: string): string {
  const bounded = message.slice(0, LOG_SCAN_LIMIT);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded);
  } catch {
    return redactText(bounded);
  }
  if (!parsed || typeof parsed !== "object") return redactText(bounded);
  try {
    // Parse first so escaped keys and sensitive object/array values cannot
    // bypass field filtering. Strings still receive URL/header sanitization.
    return JSON.stringify(parsed, (key, value) =>
      SENSITIVE_FIELD_KEY.test(key)
        ? "[redacted]"
        : typeof value === "string"
          ? redactText(value)
          : value,
    ).slice(0, 1500);
  } catch {
    // Deep structures may parse but exceed the serializer's stack. Do not
    // fall back to raw text after decoded sensitive fields were recognized.
    return "[structured diagnostic omitted]";
  }
}
export async function log(
  env: Env,
  entry: {
    level?: string;
    stage: string;
    message: string;
    requestId?: string;
    videoId?: string;
    taskId?: string;
    details?: Record<string, unknown>;
  },
) {
  const safeDetails = entry.details
    ? JSON.stringify(entry.details, (key, value) =>
        SENSITIVE_DETAIL_KEY.test(key)
          ? "[redacted]"
          : typeof value === "string"
            ? redact(value)
            : value,
      )
    : null;
  await env.DB.prepare(
    "INSERT INTO logs(id,request_id,video_id,task_id,level,stage,message,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id(),
      entry.requestId ?? null,
      entry.videoId ?? null,
      entry.taskId ?? null,
      entry.level ?? "info",
      entry.stage,
      redact(entry.message),
      safeDetails,
      now(),
    )
    .run();
}
