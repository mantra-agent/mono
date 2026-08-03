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
