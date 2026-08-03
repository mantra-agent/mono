export type ToolFailureCode =
  | "scratch_edit_not_found"
  | "scratch_edit_ambiguous"
  | "scratch_edit_read_required"
  | "scratch_edit_quarantined";

export interface ToolFailure {
  code: ToolFailureCode;
  kind: "deterministic_conflict";
  operation: "scratch.edit";
  resourceKey: string;
  recovery: "read_then_retry" | "quarantined";
}

export function scratchEditFailure(
  code: "scratch_edit_not_found" | "scratch_edit_ambiguous",
  resolvedPath: string,
): ToolFailure {
  return {
    code,
    kind: "deterministic_conflict",
    operation: "scratch.edit",
    resourceKey: `file:${resolvedPath}`,
    recovery: "read_then_retry",
  };
}
