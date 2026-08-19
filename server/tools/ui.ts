import type { ToolHandler, ToolHandlerResult } from "./contracts";
import {
  isUiInteractionMode,
  isUiInteractionNarrationState,
  isUiInteractionResourceSurface,
  isUiInteractionTarget,
  parseUiInteractionResource,
  UI_INTERACTION_INTRODUCTION_MAX_LENGTH,
  type UiInteractionReason,
} from "@shared/ui-interaction";
import { inputFailure, transientFailure, type ToolFailure } from "../tool-failure";

function uiInput(result: string, detail: string): ToolHandlerResult {
  return { result, error: true, failure: inputFailure("ui_input_invalid", detail) };
}

function failureForUnavailableReason(reason: UiInteractionReason | undefined): ToolFailure {
  switch (reason) {
    case "timed_out":
    case "send_failed":
    case "client_disconnected":
    case "capacity_exceeded":
      return transientFailure("ui_provider_transient", reason);
    case "no_active_client":
    case "ambiguous_active_client":
    case "target_unavailable":
    case "user_cancelled":
    case "superseded":
      return inputFailure("ui_input_invalid", reason);
    default:
      return inputFailure("ui_input_invalid", reason ?? "unavailable");
  }
}

export const handleUiInteraction: ToolHandler = async (args) => {
  const sessionId = typeof args._sessionId === "string" ? args._sessionId : "";
  const clientId = typeof args._clientId === "string" ? args._clientId : undefined;
  const origin = args._authorityContext?.origin;
  const narrationState = isUiInteractionNarrationState(args._uiNarrationState)
    ? args._uiNarrationState
    : "not_applicable";

  if (!sessionId || !clientId || (origin !== "interactive" && origin !== "voice")) {
    return uiInput(
      "UI interaction requires a session-bound interactive or voice run from an active browser tab.",
      "no_active_client",
    );
  }
  if (!isUiInteractionMode(args.mode)) {
    return uiInput("UI interaction mode must be execute or guide.", "invalid_mode");
  }

  const resource = parseUiInteractionResource(args.resource);
  const hasControl = args.target !== undefined;
  const hasResource = args.resource !== undefined;
  if (hasControl === hasResource) {
    return uiInput("Provide exactly one UI interaction subject: target or resource.", "subject_required");
  }
  if (hasControl && !isUiInteractionTarget(args.target)) {
    return uiInput("Unknown UI interaction target.", "unknown_target");
  }
  if (hasResource && (!resource || !isUiInteractionResourceSurface(args.surface))) {
    return uiInput(
      "Resource interactions require one canonical @type:id reference and a supported surface.",
      "invalid_resource",
    );
  }
  if (hasResource && args.mode !== "guide") {
    return uiInput(
      "Resource interactions are guide-only so the user remains in control of the highlighted object.",
      "resource_guide_only",
    );
  }

  // Guide narration is mandatory: a spotlight must never appear without first
  // naming the target and asking the user to act. Fail recoverably so the agent
  // can supply narration and retry rather than silently highlighting.
  const introduction = typeof args.introduction === "string" ? args.introduction.trim() : "";
  if (args.mode === "guide" && !introduction) {
    return uiInput(
      "Guide mode requires an introduction that names the target and explicitly asks the user to act. Provide a one or two sentence introduction and call ui again.",
      "guide_introduction_required",
    );
  }

  const { requestUiInteraction } = await import("../ui-interaction-coordinator");
  const result = await requestUiInteraction({
    sessionId,
    clientId,
    subject: hasResource
      ? { type: "resource", resource: resource!.canonical, surface: args.surface }
      : { type: "control", target: args.target },
    mode: args.mode,
    introduction: introduction ? introduction.slice(0, UI_INTERACTION_INTRODUCTION_MAX_LENGTH) : undefined,
    narrationState,
  });

  if (result.outcome !== "unavailable") {
    return { result: JSON.stringify(result) };
  }
  return {
    result: JSON.stringify(result),
    error: true,
    failure: failureForUnavailableReason(result.reason),
  };
};
