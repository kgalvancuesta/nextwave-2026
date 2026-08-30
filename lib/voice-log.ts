import "server-only";

type VoiceLogLevel = "info" | "warn" | "error";

const SECRET_KEYS = /^(authorization|api[-_]?key|secret|token|signature|cookie|set-cookie)$/i;

/**
 * Structured voice diagnostics with correlation-friendly fields. Raw audio,
 * credentials, signatures, and cookies are never emitted. Transcript text is
 * intentionally retained: this logger exists to make live call behavior
 * reviewable while the SQLite transcript remains the durable record.
 */
export function voiceLog(level: VoiceLogLevel, event: string, detail: Record<string, unknown> = {}): void {
  const sanitizedDetail = sanitize(detail) as Record<string, unknown>;
  const entry = {
    timestamp: new Date().toISOString(),
    scope: "voice",
    event,
    ...sanitizedDetail,
  };
  console[level](`[voice] ${JSON.stringify(entry)}`);
}

export function voiceError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function sanitize(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEYS.test(key)) return "[REDACTED]";
  if (depth > 6) return "[MAX_DEPTH]";
  if (typeof value === "string") return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, key, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
    childKey,
    childKey === "audio" ? "[AUDIO_OMITTED]" : sanitize(childValue, childKey, depth + 1),
  ]));
}
