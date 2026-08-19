/**
 * Shared tool-failure kind discriminant.
 * Server owns full ToolFailure; client only needs the kind for presentation.
 *
 * Presentation contract:
 * - classified kinds (input|permission|transient|internal) render amber
 * - missing/unknown failureKind renders red (true surprise)
 */
export type ToolFailureKind = "input" | "permission" | "transient" | "internal";

const CLASSIFIED_KINDS = new Set<string>([
  "input",
  "permission",
  "transient",
  "internal",
]);

/** True when failureKind is one of the known avoidable/classified kinds. */
export function isClassifiedToolFailureKind(
  failureKind?: string | null,
): failureKind is ToolFailureKind {
  return typeof failureKind === "string" && CLASSIFIED_KINDS.has(failureKind);
}

/**
 * Read failureKind from the shapes tools actually emit.
 * Canonical handler outcome: `{ failure: { kind } }`.
 * Flattened/event shape: `{ failureKind }`.
 * Thrown ToolFailureError: `{ failure: { kind } }`.
 * Legacy nested error objects are accepted for backward compatibility.
 */
export function extractToolFailureKind(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  if (typeof record.failureKind === "string") return record.failureKind;

  const failure = record.failure;
  if (failure && typeof failure === "object") {
    const kind = (failure as { kind?: unknown }).kind;
    if (typeof kind === "string") return kind;
  }

  const error = record.error;
  if (error && typeof error === "object") {
    return extractToolFailureKind(error);
  }

  return null;
}

/**
 * Last-resort classification for a failed tool outcome that no explicit
 * classifier claimed. Phrase-matches a tight allow-list of avoidable-failure
 * signals in the failure text so predictable, caller-correctable failures
 * render amber instead of red.
 *
 * Contract:
 * - Runs ONLY when a failure already lacks a failureKind. It never overrides
 *   an explicit classifier (single source of truth stays the handler).
 * - Genuinely unrecognized failures return null and stay red — a true surprise
 *   worth investigating (fail loudly).
 * - Ordering is deliberate: permission and transient signals are matched before
 *   the broad input signal, because auth/network failures often also contain
 *   generic "invalid"/"not found" wording.
 */
export function inferFailureKind(text: unknown): ToolFailureKind | null {
  if (typeof text !== "string" || !text) return null;
  const t = text.toLowerCase();

  // Permission — authority walls, forbidden actions, revoked/denied access.
  if (
    /\b(?:access denied|permission denied|denied|forbidden|unauthorized|not allowed|not permitted|authentication failed|no_active_client)\b/.test(
      t,
    )
  ) {
    return "permission";
  }

  // Transient — network, availability, rate, timeout. A later retry may succeed.
  if (
    /\b(?:timed out|timeout|unavailable|rate limit|rate-limited|too many requests|network is unreachable|could not resolve host|connection (?:reset|refused|timed out)|temporarily|502|503|504|429)\b/.test(
      t,
    )
  ) {
    return "transient";
  }

  // Internal — true defects that are not caller-correctable.
  if (/\bis not a function\b|\bcannot read propert|\bundefined is not|\bnull is not an object\b/.test(t)) {
    return "internal";
  }

  // Input — caller-correctable argument/target problems.
  if (
    /\b(?:missing|required|invalid|must be|needs to be|not found|does not exist|doesn't exist|no such|unknown (?:id|action|tool)|already exists|malformed|out of range|old_string|title must|session-bound interactive|active browser tab)\b/.test(
      t,
    )
  ) {
    return "input";
  }

  return null;
}
