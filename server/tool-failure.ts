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
  | "task_update_internal"
  | "task_missing_title"
  | "task_milestone_required"
  // Tasks contract rejects (caller-correctable input)
  | "task_input_invalid"
  | "business_plan_internal"
  | "business_input_invalid"
  | "business_internal"
  // Decisions contract rejects (caller-correctable input)
  | "decision_input_invalid"
  // Question contract rejects (caller-correctable input)
  | "question_input_invalid"
  // Templates contract rejects (caller-correctable catalog/input miss)
  | "template_unavailable"
  | "templates_input_invalid"
  // Library contract rejects (caller-correctable input)
  | "library_input_invalid"
  // Gmail / email_cache contract rejects (caller-correctable input)
  | "gmail_input_invalid"
  | "tool_authority_denied"
  | "build_mod_inactive"
  | "hook_name_conflict"
  | "integration_not_configured"
  | "integration_auth_failed"
  | "orient_persona_required"
  | "orient_no_session"
  // Session tool contract rejects (caller-correctable input)
  | "session_input_invalid"
  // Work tool contract rejects (caller-correctable input)
  | "work_input_invalid"
  | "shell_policy_denied"
  | "python_execution_rejected"
  | "python_execution_timeout"
  | "python_output_limit_exceeded"
  | "tool_schema_invalid"
  | "tool_unregistered"
  | "tool_registered_handler_missing"
  // Plan contract rejects
  | "plan_input_invalid"
  | "plan_principal_required"
  // Files contract/provider rejects
  | "files_input_invalid"
  | "files_access_denied"
  | "files_provider_transient"
  // Core PDF tool rejects
  | "pdf_input_invalid"
  | "pdf_access_denied"
  | "pdf_provider_transient"
  | "pdf_extract_failed"
  // Progressive tool-schema loading rejects
  | "tools_input_invalid"
  | "tools_authority_denied"
  // Web fetch/search rejects
  | "web_input_invalid"
  | "web_fetch_http_error"
  | "web_fetch_timeout"
  | "web_fetch_transient"
  // System tool rejects / defects
  | "system_input_invalid"
  | "system_principal_required"
  | "system_schema_missing"
  | "system_internal_error"
  // Git contract rejects (caller input / wrong target — amber)
  | "git_platform_environment_required"
  | "git_clone_routing_forbidden"
  | "git_source_binding_unavailable"
  | "git_directory_required"
  | "git_directory_not_found"
  | "git_directory_ambiguous"
  | "git_session_ownership"
  | "git_workspace_root_forbidden"
  | "git_invalid_action"
  // Railway contract rejects
  | "railway_missing_action"
  | "railway_missing_platform_environment"
  | "railway_action_not_allowed"
  // Code / GitNexus contract rejects
  | "code_missing_action"
  | "code_unknown_action"
  | "code_missing_query"
  | "git_auth_denied"
  | "git_ref_not_found"
  | "git_state_conflict"
  | "git_network"
  | "scratch_path_denied"
  | "scratch_not_found"
  // Meetings join / lifecycle rejects
  | "meeting_input_invalid"
  | "meeting_provider_transient"
  | "meeting_join_failed"
  // Slack outbound tool rejects
  | "slack_input_invalid"
  | "slack_person_unaddressed"
  | "slack_not_mapped"
  | "slack_channel_unconfigured"
  | "slack_channel_mismatch"
  | "slack_person_required"
  | "slack_person_not_found"
  | "slack_body_empty"
  | "slack_body_too_long"
  | "slack_idempotency_required"
  | "slack_idempotency_conflict"
  | "slack_idempotency_invalid"
  | "slack_rate_limited"
  | "slack_quota"
  | "slack_provider_error";

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

/**
 * Authority / credential walls the caller cannot restore inside this run.
 * Do not use for missing optional integration readiness (`integration_not_configured`),
 * working-set / origin policy misses (`tools_authority_denied`, `tool_authority_denied`),
 * command-shape allowlist rejects (`shell_policy_denied`), or scratch path-shape /
 * session-clone boundary rejects (`scratch_path_denied`) — those are `inputFailure`
 * so the model can pivot without run-terminal quarantine.
 */
export function permissionFailure(code: ToolFailureCode, detail?: string): ToolFailure {
  return makeFailure("permission", code, false, detail ? { detail } : undefined);
}

/**
 * Retryable operational failures — the same call may succeed on a later attempt
 * once a transient condition (network, remote availability) clears.
 */
export function transientFailure(code: ToolFailureCode, detail?: string): ToolFailure {
  return makeFailure("transient", code, true, detail ? { detail } : undefined);
}

/**
 * True internal defects — schema gaps, missing symbols, invariant breaks.
 * Classified so dashboards separate them from untyped surprises, but still
 * non-retryable and not caller-correctable.
 */
export function internalFailure(code: ToolFailureCode, detail?: string): ToolFailure {
  return makeFailure("internal", code, false, detail ? { detail } : undefined);
}

/**
 * Categorical authority denials decided before handler execution
 * (dispatch-time authorization / Build Mod gates). Always non-retryable.
 * These are origin/working-set misses the model can work around with a
 * different tool or action — not credential walls — so they stay input.
 */
export function authorityDenialFailure(
  code: "tool_authority_denied" | "build_mod_inactive",
  detail?: string,
): ToolFailure {
  return makeFailure("input", code, false, detail ? { detail } : undefined);
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

  // Sentry issue-search syntax rejects (Boolean OR/AND, parse errors) are
  // caller-correctable input — never integration auth or internal defects.
  if (e.name === "SentryApiError") {
    const code = (err as { code?: unknown }).code;
    const details = (err as { details?: unknown }).details;
    const detailText =
      typeof details === "string"
        ? details
        : details == null
          ? ""
          : JSON.stringify(details);
    if (
      code === "invalid_search_query"
      || (typeof e.status === "number"
        && e.status === 400
        && /Boolean statements|Error parsing search query|invalid search query/i.test(
          `${message}\n${detailText}`,
        ))
    ) {
      return inputFailure("system_input_invalid", "sentry_invalid_search_query");
    }
  }

  if (isUniqueViolation(err)) {
    return inputFailure("hook_name_conflict", message || undefined);
  }

  return null;
}

/**
 * Classify a failed GitHub REST API response by HTTP status. PR create/merge/
 * delete calls fail on auth (401/403), rate or availability limits (408/429/5xx),
 * and validation or state conflicts (404/422 and other 4xx). Detail strings carry
 * only the status code, never response bodies, to avoid leaking tokens.
 */
export function classifyGitHubApiStatus(status: number): ToolFailure | null {
  if (status === 401 || status === 403) return permissionFailure("git_auth_denied", `github_api_${status}`);
  if (status === 408 || status === 429 || status >= 500) return transientFailure("git_network", `github_api_${status}`);
  if (status >= 400) return inputFailure("git_state_conflict", `github_api_${status}`);
  return null;
}

/**
 * Classify a failed git subprocess (execFile rejection) by its stderr/message.
 *
 * Git subprocess failures are caught and flattened at the git tool handler's
 * own catch block, so the raw error never reaches toolFailureFromError. This
 * recognizes the known, expected git failure classes so they render amber.
 * Genuinely unrecognized git failures return null and stay red — a true
 * surprise worth investigating. Detail strings are generic (never raw stderr)
 * to avoid leaking credentials into telemetry.
 */
export function classifyGitError(err: unknown): ToolFailure | null {
  if (err instanceof ToolFailureError) return err.failure;
  const e = (err ?? {}) as {
    stderr?: unknown;
    message?: unknown;
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
  };
  const haystack = [
    typeof e.stderr === "string" ? e.stderr : "",
    typeof e.message === "string" ? e.message : "",
    typeof e.code === "string" ? e.code : "",
  ]
    .join("\n")
    .trim();

  // Process budget — execFile timeout/SIGTERM. Progress stderr like
  // "Cloning into..." is not auth evidence.
  if (
    e.killed === true ||
    e.code === "ETIMEDOUT" ||
    (typeof e.signal === "string" && /^(?:SIGTERM|SIGKILL)$/i.test(e.signal)) ||
    /ETIMEDOUT|command timed out|killed \(timeout\)/i.test(haystack)
  ) {
    return transientFailure("git_network", "git process timeout/killed");
  }

  if (!haystack) return null;

  // Auth / permission walls — credentials wrong, revoked, or prompts disabled.
  if (
    /authentication failed|could not read (?:username|password)|permission denied|invalid username or password|support for password authentication|terminal prompts disabled|returned error: 403|access denied/i.test(
      haystack,
    )
  ) {
    return permissionFailure("git_auth_denied", "git authentication/permission denied");
  }

  // Network / transient — DNS, connectivity, server 5xx, interrupted transfer.
  if (
    /could not resolve host|couldn't connect|failed to connect|connection (?:timed out|reset|refused)|operation timed out|network is unreachable|early eof|rpc failed|the requested url returned error: 5\d\d|unable to access/i.test(
      haystack,
    )
  ) {
    return transientFailure("git_network", "git network/connectivity failure");
  }

  // Invalid caller-selected refs are deterministic input failures, not tool defects.
  if (
    /bad object\b|bad revision\b|not a valid (?:ref|object)|unknown revision|did not match any file|pathspec .* did not match|couldn't find remote ref|needed a single revision/i.test(
      haystack,
    )
  ) {
    return inputFailure("git_ref_not_found", "git ref not found");
  }

  // Repo-state conflicts — the operation cannot proceed given current state.
  if (
    /nothing to commit|no changes added to commit|nothing added to commit|updates were rejected|non-fast-forward|failed to push some refs|automatic merge failed|merge conflict|\bconflict\b|already exists|not a git repository/i.test(
      haystack,
    )
  ) {
    return inputFailure("git_state_conflict", "git repository state conflict");
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
