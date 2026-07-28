export const UI_INTERACTION_TARGETS = [
  "navigation.memoryGraph.open",
] as const;

export type UiInteractionTarget = typeof UI_INTERACTION_TARGETS[number];

export const UI_INTERACTION_MODES = ["execute", "guide"] as const;
export type UiInteractionMode = typeof UI_INTERACTION_MODES[number];

export const UI_INTERACTION_OUTCOMES = ["completed", "cancelled", "unavailable"] as const;
export type UiInteractionOutcome = typeof UI_INTERACTION_OUTCOMES[number];

export const UI_INTERACTION_REASONS = [
  "user_cancelled",
  "target_unavailable",
  "no_active_client",
  "ambiguous_active_client",
  "client_disconnected",
  "send_failed",
  "timed_out",
  "superseded",
  "capacity_exceeded",
] as const;

export type UiInteractionReason = typeof UI_INTERACTION_REASONS[number];

export interface UiInteractionCommand {
  type: "ui.interaction.command";
  commandId: string;
  target: UiInteractionTarget;
  mode: UiInteractionMode;
  expiresAt: number;
}

export interface UiInteractionResult {
  type: "ui.interaction.result";
  commandId: string;
  outcome: UiInteractionOutcome;
  reason?: UiInteractionReason;
}

export interface UiInteractionTerminalResult {
  target: UiInteractionTarget;
  mode: UiInteractionMode;
  outcome: UiInteractionOutcome;
  reason?: UiInteractionReason;
}

export function isUiInteractionTarget(value: unknown): value is UiInteractionTarget {
  return typeof value === "string" && (UI_INTERACTION_TARGETS as readonly string[]).includes(value);
}

export function isUiInteractionMode(value: unknown): value is UiInteractionMode {
  return typeof value === "string" && (UI_INTERACTION_MODES as readonly string[]).includes(value);
}

export function isUiInteractionOutcome(value: unknown): value is UiInteractionOutcome {
  return typeof value === "string" && (UI_INTERACTION_OUTCOMES as readonly string[]).includes(value);
}

export function isUiInteractionReason(value: unknown): value is UiInteractionReason {
  return typeof value === "string" && (UI_INTERACTION_REASONS as readonly string[]).includes(value);
}

export function isUiInteractionCommand(value: unknown): value is UiInteractionCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<UiInteractionCommand>;
  return command.type === "ui.interaction.command"
    && typeof command.commandId === "string"
    && command.commandId.length > 0
    && command.commandId.length <= 120
    && isUiInteractionTarget(command.target)
    && isUiInteractionMode(command.mode)
    && typeof command.expiresAt === "number"
    && Number.isFinite(command.expiresAt);
}

export function isUiInteractionResult(value: unknown): value is UiInteractionResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<UiInteractionResult>;
  return result.type === "ui.interaction.result"
    && typeof result.commandId === "string"
    && result.commandId.length > 0
    && result.commandId.length <= 120
    && isUiInteractionOutcome(result.outcome)
    && (result.reason === undefined || isUiInteractionReason(result.reason));
}
