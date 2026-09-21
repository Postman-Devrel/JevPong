const PRIVATE_KEY =
  /(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|headers|environment|^env$|stack|user[_-]?agent|browser[_-]?id|client[_-]?id)/i;
const MAX_DEPTH = 12;

/** Defense in depth for local inspection/export. Provider responses are also allowlisted. */
export function redactSecrets(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") {
    const safe = value
      .slice(0, 16_384)
      .replace(/Bearer\s+[a-zA-Z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(
        /(?:TYPESAFE_API_KEY|JEV_API_KEY)\s*[=:]\s*[^\s,;"']+/gi,
        "[REDACTED]",
      )
      .replace(/\b(?:sk|ts)_[a-zA-Z0-9_-]{16,}\b/g, "[REDACTED]")
      .replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/g, "[REDACTED]");
    return safe + (value.length > 16_384 ? "[TRUNCATED]" : "");
  }
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (typeof value !== "object") return null;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value))
    return value
      .slice(0, 500)
      .map((item) => redactSecrets(item, seen, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 200)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype")
      continue;
    result[key] = PRIVATE_KEY.test(key)
      ? "[REDACTED]"
      : redactSecrets(entry, seen, depth + 1);
  }
  return result;
}
