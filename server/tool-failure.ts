export type ToolFailureKind = "input" | "permission" | "transient" | "internal";

export type ToolFailureCode =
  | "scratch_edit_not_found"
  | "scratch_edit_ambiguous"
  | "scratch_edit_read_required"
  | "scratch_edit_quarantined"
  | "task_update_project_id_invalid"
  | "task_update_milestone_id_invalid"
  | "task_update_patch_rejected"
  | "tool_authority_denied"
  | "build_mod_inactive"
  | "shell_policy_denied";

export interface ToolFailure {
  kind: ToolFailureKind;
  code: ToolFailureCode;
  retryable: boolean;
  recovery?: "read_then_retry_once" | "finalize_only";
  resourceKey?: string;
  targetPath?: string;
  observedDigest?: string;
  expectedMatches?: number;
  observedMatches?: number;
  readRequired?: boolean;
}

export class ToolFailureError extends Error {
  constructor(message: string, readonly failure: ToolFailure) {
    super(message);
    this.name = "ToolFailureError";
  }
}

export function scratchEditFailure(
  code: ToolFailureCode,
  resolved: { relativePath: string },
  extra: Partial<ToolFailure> = {},
): ToolFailure {
  return {
    kind: "input",
    code,
    retryable: false,
    recovery: "read_then_retry_once",
    resourceKey: `scratch:${resolved.relativePath}`,
    targetPath: resolved.relativePath,
    ...extra,
  };
}

/**
 * Categorical authority/entitlement denial — a wall no argument variant can satisfy in-run
 * (dispatch-time authority denied, Build Mod inactive, shell allowlist/denylist). Modeled as a
 * non-retryable `permission` failure so it flows through `isDeterministicToolFailure` into the
 * run-scoped recovery ledger, which quarantines it and ends the turn cleanly instead of letting
 * the model thrash variants of the same wall until the watchdog kills it. The denial reason stays
 * in the tool result text so the next turn can adapt; within the run, retry is futile.
 */
export function authorityDenialFailure(
  code: "tool_authority_denied" | "build_mod_inactive" | "shell_policy_denied",
  extra: Partial<ToolFailure> = {},
): ToolFailure {
  return {
    kind: "permission",
    code,
    retryable: false,
    ...extra,
  };
}

export function isDeterministicToolFailure(failure: ToolFailure | undefined): failure is ToolFailure {
  return !!failure && !failure.retryable && (failure.kind === "input" || failure.kind === "permission");
}

export function toolFailureFromError(error: unknown): ToolFailure | undefined {
  return error instanceof ToolFailureError ? error.failure : undefined;
}
