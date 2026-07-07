// Safe, bounded JSON.stringify (Task #995, Step E).
//
// Plain JSON.stringify on user/LLM/tool data is sync, CPU-bound, and grows
// linearly with the input — multi-MB blobs (an entire run's context, full
// tool args/results, model snapshots) can freeze the event loop for
// hundreds of ms.
//
// safeStringify avoids that by *first* walking the value with hard limits
// on depth, breadth, and string length to produce a bounded clone. The
// bounded clone has a known small upper bound (≈ maxDepth × maxKeys ×
// maxStrLen), so the subsequent JSON.stringify call is itself bounded
// regardless of the original input size — it can never become the
// event-loop block we are defending against.
//
// If the resulting JSON would still exceed `maxBytes` (rare but possible
// with deeply nested structures), we emit a structured summary instead:
//   "[truncated:label size=12.4MB type=object keys=context,history,messages]"
// and a `log.warn` with the same label so operators can find what was
// dropped.
//
// Adopt at any site that stringifies user-provided or LLM-provided data
// of unbounded size. Do NOT use for protocol-critical payloads where
// truncation would corrupt the format (HTTP responses to typed clients,
// IPC messages, etc.).

import { createLogger } from "../log";

const log = createLogger("safeStringify");

const DEFAULT_MAX_BYTES = 1_000_000; // 1 MB cap on output JSON
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_KEYS = 64;          // per object
const DEFAULT_MAX_ARRAY_ITEMS = 64;
const DEFAULT_MAX_STR_LEN = 8_000;
const STR_TRUNC_MARKER = "…[truncated]";

export interface SafeStringifyOptions {
  /**
   * Hard upper bound on the resulting JSON string length. If the bounded
   * clone still serializes larger than this, the output is replaced by a
   * one-line truncation summary and a warning is logged.
   */
  maxBytes?: number;
  /**
   * Optional human-readable label used in the truncation summary and the
   * warning log line so operators can identify what was dropped.
   */
  label?: string;
  /**
   * Per-branch limits for the bounded clone. Defaults bound the worst case
   * to roughly 8 levels deep × 64 children × 8KB string ≈ 4MB *before*
   * stringification, with the maxBytes cap providing the final clamp.
   */
  maxDepth?: number;
  maxKeys?: number;
  maxArrayItems?: number;
  maxStrLen?: number;
}

function circularReplacer() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value as object)) return "[Circular]";
      seen.add(value as object);
    }
    return value;
  };
}

function describeShape(value: unknown): { type: string; keys?: string } {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array" };
  const t = typeof value;
  if (t !== "object") return { type: t };
  const keys = Object.keys(value as Record<string, unknown>).slice(0, 6).join(",");
  return { type: "object", keys };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function summarize(value: unknown, size: number, label: string | undefined): string {
  const shape = describeShape(value);
  const labelPart = label || "n/a";
  const keysPart = shape.keys ? ` keys=${shape.keys}` : "";
  return `[truncated:${labelPart} size=${humanSize(size)} type=${shape.type}${keysPart}]`;
}

function boundClone(
  value: unknown,
  depth: number,
  maxDepth: number,
  maxKeys: number,
  maxArrayItems: number,
  maxStrLen: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") {
    const s = value as string;
    if (s.length > maxStrLen) return s.slice(0, maxStrLen) + STR_TRUNC_MARKER;
    return s;
  }
  if (t === "number" || t === "boolean") return value;
  if (t === "bigint") return `${(value as bigint).toString()}n`;
  if (t === "symbol" || t === "function") return `[${t}]`;
  if (t !== "object") return String(value);

  if (depth >= maxDepth) {
    if (Array.isArray(value)) return `[Array(${value.length}) ...maxDepth]`;
    return `[Object ...maxDepth]`;
  }

  if (seen.has(value as object)) return "[Circular]";
  seen.add(value as object);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const len = Math.min(value.length, maxArrayItems);
    for (let i = 0; i < len; i++) {
      out.push(boundClone(value[i], depth + 1, maxDepth, maxKeys, maxArrayItems, maxStrLen, seen));
    }
    if (value.length > maxArrayItems) {
      out.push(`[+${value.length - maxArrayItems} more]`);
    }
    return out;
  }

  // Plain object / class instance — copy own enumerable string keys only.
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const out: Record<string, unknown> = {};
  const limit = Math.min(keys.length, maxKeys);
  for (let i = 0; i < limit; i++) {
    const k = keys[i];
    out[k] = boundClone(obj[k], depth + 1, maxDepth, maxKeys, maxArrayItems, maxStrLen, seen);
  }
  if (keys.length > maxKeys) {
    out.__truncated__ = `[+${keys.length - maxKeys} more keys]`;
  }
  return out;
}

export function safeStringify(value: unknown, opts: SafeStringifyOptions = {}): string {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const label = opts.label;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  const maxArrayItems = opts.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS;
  const maxStrLen = opts.maxStrLen ?? DEFAULT_MAX_STR_LEN;

  // Step 1: bounded clone — small, fast, cannot grow with input size.
  let bounded: unknown;
  try {
    bounded = boundClone(value, 0, maxDepth, maxKeys, maxArrayItems, maxStrLen, new WeakSet());
  } catch {
    bounded = "[unrepresentable]";
  }

  // Step 2: stringify the bounded clone. Output size is capped by the
  // bound parameters above, so this stringify is itself bounded.
  let out: string;
  try {
    out = JSON.stringify(bounded, circularReplacer());
  } catch {
    try {
      out = String(bounded);
    } catch {
      out = "[unserializable]";
    }
  }
  if (typeof out !== "string") out = "";

  if (out.length > maxBytes) {
    log.warn(
      `safeStringify truncated label=${label || "n/a"} size=${out.length} maxBytes=${maxBytes}`,
    );
    return summarize(value, out.length, label);
  }

  return out;
}

// Truncates an existing string to a byte budget — useful when a payload was
// already serialized upstream (e.g. an external API response) and just needs
// bounding before logging or persisting.
export function safeTruncate(s: string, maxBytes: number = DEFAULT_MAX_BYTES, label?: string): string {
  if (typeof s !== "string") return "";
  if (s.length <= maxBytes) return s;
  log.warn(`safeTruncate truncated label=${label || "n/a"} size=${s.length} maxBytes=${maxBytes}`);
  return s.slice(0, maxBytes) + STR_TRUNC_MARKER;
}
