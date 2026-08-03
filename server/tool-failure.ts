import type { ToolFailureKind } from "@shared/tool-failure";
export type { ToolFailureKind } from "@shared/tool-failure";

export type ToolFailureCode =
  | "scratch_edit_not_found"
  | "scratch_edit_ambiguous"
  | "scratch_edit_read_required"
  | "scratch_edit_quarantined"
  | "task_update_project_not_found"
  | "task_update_milestone_not_found"
  | "task_update_milestone_requires_project"
  | "task_update_patch_rejected"
  | "task_missing_title"
  | "tool_authority_denied"
  | "build_mod_inactive"
  | "hook_name_conflict"
  | "integration_not_configured"
  | "integration_auth_failed"
  | "orient_persona_required"
  | "orient_no_session"
  | "shell_policy_denied"
  | "tool_schema_invalid";

export interface ToolFailure {
  kind: ToolFailureKind;
  code: ToolFailureCode;
  retryable: boolean;
  detail?: string;
}

export class ToolFailureError extends Error {
  readonly failure: ToolFailure;

  constructor(message: string, failure: ToolFailure) {
    super(message);
    this.name = "ToolFailureError";
    this.failure = failure;
  }
}

function makeFailure(
  kind: ToolFailureKind,
  code: ToolFailureCode,
  retryable: boolean,
  opts?: { detail?: string },
): ToolFailure {
  return {
    kind,
    code,
    retryable,
    ...(opts?.detail ? { detail: opts.detail } : {}),
  };
}

export function inputFailure(code: ToolFailureCode, detail?: string): ToolFailure {
  return makeFailure("input", code, false, detail ? { detail } : undefined);
}

export function permissionFailure(code: ToolFailureCode, detail?: string): ToolFailure {
  return makeFailure("permission", code, false, detail ? { detail } : undefined);
}

/**
 * Categorical authority denials decided before handler execution
 * (dispatch-time authorization / Build Mod gates). Always non-retryable.
 */
export function authorityDenialFailure(
  code: "tool_authority_denied" | "build_mod_inactive",
  detail?: string,
): ToolFailure {
  return makeFailure("permission", code, false, detail ? { detail } : undefined);
}

export function scratchEditFailure(
  code:
    | "scratch_edit_not_found"
    | "scratch_edit_ambiguous"
    | "scratch_edit_read_required"
    | "scratch_edit_quarantined",
  detail?: string,
): ToolFailure {
  return makeFailure("input", code, false, detail ? { detail } : undefined);
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; cause?: { code?: unknown }; message?: unknown };
  if (e.code === "23505") return true;
  if (e.cause && typeof e.cause === "object" && (e.cause as { code?: unknown }).code === "23505") {
    return true;
  }
  const message = typeof e.message === "string" ? e.message : "";
  return /duplicate key|unique constraint|unique violation/i.test(message);
}

export function toolFailureFromError(err: unknown): ToolFailure | null {
  if (err instanceof ToolFailureError) return err.failure;
  if (!err || typeof err !== "object") return null;

  const e = err as { name?: unknown; message?: unknown; status?: unknown; failure?: unknown };
  if (e.failure && typeof e.failure === "object") {
    const f = e.failure as Partial<ToolFailure>;
    if (f.kind && f.code && typeof f.retryable === "boolean") {
      return f as ToolFailure;
    }
  }

  const message = typeof e.message === "string" ? e.message : "";

  if (e.name === "PatchGuardError") {
    return inputFailure("task_update_patch_rejected", message || undefined);
  }

  // Sentry (and similar) HTTP auth walls — credentials wrong or revoked.
  if (
    e.name === "SentryApiError" &&
    typeof e.status === "number" &&
    (e.status === 401 || e.status === 403)
  ) {
    return permissionFailure("integration_auth_failed", message || undefined);
  }

  if (isUniqueViolation(err)) {
    return inputFailure("hook_name_conflict", message || undefined);
  }

  return null;
}

/**
 * True when the failure is categorical and cannot be fixed by retrying
 * the same call with the same arguments in this run.
 */
export function isDeterministicToolFailure(failure: ToolFailure | null | undefined): boolean {
  return Boolean(failure && failure.retryable === false);
}
