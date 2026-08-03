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
