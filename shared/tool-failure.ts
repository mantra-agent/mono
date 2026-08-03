/**
 * Shared tool-failure kind discriminant.
 * Server owns full ToolFailure; client only needs the kind for presentation.
 *
 * Presentation contract:
 * - classified kinds (input|permission|transient|internal) → amber
 * - missing / unknown kind → red (unclassified surprise)
 */
export type ToolFailureKind = "input" | "permission" | "transient" | "internal";

export const CLASSIFIED_TOOL_FAILURE_KINDS = [
  "input",
  "permission",
  "transient",
  "internal",
] as const satisfies readonly ToolFailureKind[];

/** True when a failureKind is a known/avoidable classified kind (amber). */
export function isClassifiedToolFailureKind(
  kind: string | null | undefined,
): kind is ToolFailureKind {
  return (
    kind === "input" ||
    kind === "permission" ||
    kind === "transient" ||
    kind === "internal"
  );
}
