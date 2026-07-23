// Canonical secret-redaction policy for every log sink and reusable
// diagnostic artifact. See server/AGENTS.md ("canonical server log
// serialization boundary") and the SECURITY.md log-redaction delta.
const REDACTED = "[REDACTED]";
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_OBJECT_KEYS = 64;
const DEFAULT_MAX_ARRAY_ITEMS = 64;
const DEFAULT_MAX_STRING_LENGTH = 16_000;
const DEFAULT_MAX_NODES = 2_048;

export interface SensitiveDataRedactionOptions {
  maxDepth?: number;
  maxObjectKeys?: number;
  maxArrayItems?: number;
  maxStringLength?: number;
  maxNodes?: number;
}

// Structured field names are high-confidence evidence, so this policy is a
// deliberate strict SUPERSET of the freeform text patterns in
// redactSensitiveText below. When merging or refactoring either vocabulary,
// diff them as sets first and take the union or justify every drop — silently
// adopting the narrower set is exactly how the `sessionCookie` suffix
// regression shipped in PR #1045 (cured here).
//
// Pagination/sync cursors are operational identifiers, not credentials.
// Redacting them blinds Gmail/Calendar/provider sync debugging for zero
// security gain. Push tokens deliberately stay redacted: they authorize
// delivery to a device.
const NON_SECRET_TOKEN_SUFFIXES = [
  "pagetoken",
  "synctoken",
  "continuationtoken",
  "deltatoken",
  "cursortoken",
  "nexttoken",
  "prevtoken",
];

export function isSensitiveFieldName(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const isNonSecretCursor = NON_SECRET_TOKEN_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
  return normalized === "authorization"
    || normalized === "proxyauthorization"
    || normalized === "password"
    || normalized === "passwd"
    || normalized.includes("secret")
    || normalized.includes("credential")
    || normalized.includes("privatekey")
    || normalized.includes("apikey")
    || normalized.includes("accesstoken")
    || normalized.includes("refreshtoken")
    || normalized.includes("idtoken")
    || normalized.endsWith("cookie")
    || (!isNonSecretCursor && normalized.endsWith("token"));
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|whsec_[A-Za-z0-9_-]{16,})\b/g, REDACTED)
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, `$1${REDACTED}@`)
    .replace(
      /((?:"|')?[A-Za-z0-9_-]*(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|secret|credential|password|passwd|private[-_]?key|cookie)[A-Za-z0-9_-]*(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi,
      `$1"${REDACTED}"`,
    );
}

// Slack past the final cut keeps a secret straddling the truncation boundary
// fully visible to the patterns before the tail is dropped. Sized to exceed
// real-world token lengths (JWTs run 1-2KB).
const TRUNCATION_SLACK_CHARS = 4_096;

/**
 * Truncate BEFORE running the redaction regexes so pathological inputs pay
 * bounded CPU at the hot logging boundary, instead of seven pattern passes
 * over an arbitrarily large string that is about to be cut anyway.
 */
export function redactBoundedText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return redactSensitiveText(value);
  const redacted = redactSensitiveText(value.slice(0, maxLength + TRUNCATION_SLACK_CHARS));
  return `${redacted.slice(0, maxLength)}…[truncated]`;
}

export function redactSensitiveValue(
  value: unknown,
  options: SensitiveDataRedactionOptions = {},
): unknown {
  const limits = {
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxObjectKeys: options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS,
    maxArrayItems: options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS,
    maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
  };
  const seen = new WeakSet<object>();
  let visitedNodes = 0;

  const visit = (item: unknown, depth: number): unknown => {
    visitedNodes += 1;
    if (visitedNodes > limits.maxNodes) return "[Traversal budget exceeded]";
    if (item === null || item === undefined) return item;
    if (typeof item === "string") {
      return redactBoundedText(item, limits.maxStringLength);
    }
    if (typeof item === "number" || typeof item === "boolean") return item;
    if (typeof item === "bigint") return `${item.toString()}n`;
    if (typeof item === "symbol" || typeof item === "function") return `[${typeof item}]`;
    if (typeof item !== "object") return redactSensitiveText(String(item));
    if (depth >= limits.maxDepth) return Array.isArray(item) ? "[Array …maxDepth]" : "[Object …maxDepth]";
    if (seen.has(item)) return "[Circular]";
    seen.add(item);

    if (item instanceof Date) return item.toISOString();
    if (Array.isArray(item)) {
      const output = item
        .slice(0, limits.maxArrayItems)
        .map((entry) => visit(entry, depth + 1));
      if (item.length > limits.maxArrayItems) {
        output.push(`[+${item.length - limits.maxArrayItems} more]`);
      }
      return output;
    }

    const source = item as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    if (item instanceof Error) {
      output.name = redactSensitiveText(item.name);
      output.message = redactSensitiveText(item.message);
      // `stack` is a non-enumerable own property, so the key walk below never
      // sees it. Capture it here — bounded and redacted — or logged Error
      // objects lose their most valuable forensic field.
      if (item.stack) output.stack = redactBoundedText(item.stack, 4_000);
    }
    const keys = Object.keys(source);
    for (const key of keys.slice(0, limits.maxObjectKeys)) {
      if (key in output) continue;
      if (isSensitiveFieldName(key)) {
        output[key] = REDACTED;
        continue;
      }
      try {
        output[key] = visit(source[key], depth + 1);
      } catch {
        output[key] = "[unreadable]";
      }
    }
    if (keys.length > limits.maxObjectKeys) {
      output.__truncated__ = `[+${keys.length - limits.maxObjectKeys} more keys]`;
    }
    return output;
  };

  return visit(value, 0);
}
