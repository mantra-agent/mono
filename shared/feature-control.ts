/**
 * Feature pipeline control — remote of Features-row Play / Fast Forward / Pause / Stop.
 *
 * Mode stays sessionStorage in the originating browser tab (Spec Fast Forward).
 * Launch stays runPipelineLaunch; stop stays session abort. No Feature column,
 * no second sequencer, no stage/status writes from these controls.
 */

export const FEATURE_CONTROL_ACTS = ["play", "fast_forward", "pause", "stop"] as const;
export type FeatureControlAct = (typeof FEATURE_CONTROL_ACTS)[number];

export const FEATURE_CONTROL_OUTCOMES = ["completed", "unavailable"] as const;
export type FeatureControlOutcome = (typeof FEATURE_CONTROL_OUTCOMES)[number];

export const FEATURE_CONTROL_REASONS = [
  "no_active_client",
  "client_disconnected",
  "timed_out",
  "send_failed",
  "capacity_exceeded",
  "feature_not_found",
  "ineligible_stage",
  "gated_play",
  "launch_pending",
  "session_in_progress",
  "no_active_session",
  "mode_already_on",
  "mode_already_off",
  "launch_failed",
  "stop_failed",
  "target_unavailable",
] as const;
export type FeatureControlReason = (typeof FEATURE_CONTROL_REASONS)[number];

export interface FeatureControlCommand {
  type: "feature.control.command";
  commandId: string;
  featureId: string;
  act: FeatureControlAct;
  expiresAt: number;
}

export interface FeatureControlResult {
  type: "feature.control.result";
  commandId: string;
  featureId: string;
  act: FeatureControlAct;
  outcome: FeatureControlOutcome;
  reason?: FeatureControlReason;
  /** Present on completed play / fast_forward when a session was started. */
  sessionId?: string;
  /** Fast-forward mode after the act (tab sessionStorage). */
  fastForwardOn?: boolean;
}

export function isFeatureControlAct(value: unknown): value is FeatureControlAct {
  return typeof value === "string" && (FEATURE_CONTROL_ACTS as readonly string[]).includes(value);
}

export function isFeatureControlOutcome(value: unknown): value is FeatureControlOutcome {
  return typeof value === "string" && (FEATURE_CONTROL_OUTCOMES as readonly string[]).includes(value);
}

export function isFeatureControlReason(value: unknown): value is FeatureControlReason {
  return typeof value === "string" && (FEATURE_CONTROL_REASONS as readonly string[]).includes(value);
}

export function isFeatureControlCommand(value: unknown): value is FeatureControlCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<FeatureControlCommand>;
  return (
    command.type === "feature.control.command"
    && typeof command.commandId === "string"
    && command.commandId.length > 0
    && typeof command.featureId === "string"
    && command.featureId.length > 0
    && isFeatureControlAct(command.act)
    && typeof command.expiresAt === "number"
    && Number.isFinite(command.expiresAt)
  );
}

export function isFeatureControlResult(value: unknown): value is FeatureControlResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<FeatureControlResult>;
  return (
    result.type === "feature.control.result"
    && typeof result.commandId === "string"
    && result.commandId.length > 0
    && typeof result.featureId === "string"
    && result.featureId.length > 0
    && isFeatureControlAct(result.act)
    && isFeatureControlOutcome(result.outcome)
    && (result.reason === undefined || isFeatureControlReason(result.reason))
    && (result.sessionId === undefined || typeof result.sessionId === "string")
    && (result.fastForwardOn === undefined || typeof result.fastForwardOn === "boolean")
  );
}
