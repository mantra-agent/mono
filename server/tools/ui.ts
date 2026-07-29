import type { ToolHandler } from "../bridge-tools";
import {
  isUiInteractionMode,
  isUiInteractionNarrationState,
  isUiInteractionResourceSurface,
  isUiInteractionTarget,
  parseUiInteractionResource,
  UI_INTERACTION_INTRODUCTION_MAX_LENGTH,
} from "@shared/ui-interaction";

export const handleUiInteraction: ToolHandler = async (args) => {
  const sessionId = typeof args._sessionId === "string" ? args._sessionId : "";
  const clientId = typeof args._clientId === "string" ? args._clientId : undefined;
  const origin = args._authorityContext?.origin;
  const narrationState = isUiInteractionNarrationState(args._uiNarrationState)
    ? args._uiNarrationState
    : "not_applicable";

  if (!sessionId || !clientId || (origin !== "interactive" && origin !== "voice")) {
    return { result: "UI interaction requires a session-bound interactive or voice run from an active browser tab.", error: true };
  }
  if (!isUiInteractionMode(args.mode)) {
    return { result: "UI interaction mode must be execute or guide.", error: true };
  }

  const resource = parseUiInteractionResource(args.resource);
  const hasControl = args.target !== undefined;
  const hasResource = args.resource !== undefined;
  if (hasControl === hasResource) {
    return { result: "Provide exactly one UI interaction subject: target or resource.", error: true };
  }
  if (hasControl && !isUiInteractionTarget(args.target)) {
    return { result: "Unknown UI interaction target.", error: true };
  }
  if (hasResource && (!resource || !isUiInteractionResourceSurface(args.surface))) {
    return { result: "Resource interactions require one canonical @type:id reference and a supported surface.", error: true };
  }
  if (hasResource && args.mode !== "guide") {
    return { result: "Resource interactions are guide-only so the user remains in control of the highlighted object.", error: true };
  }

  // Guide narration is mandatory: a spotlight must never appear without first
  // naming the target and asking the user to act. Fail recoverably so the agent
  // can supply narration and retry rather than silently highlighting.
  const introduction = typeof args.introduction === "string" ? args.introduction.trim() : "";
  if (args.mode === "guide" && !introduction) {
    return {
      result: "Guide mode requires an introduction that names the target and explicitly asks the user to act. Provide a one or two sentence introduction and call ui again.",
      error: true,
    };
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

  return {
    result: JSON.stringify(result),
    error: result.outcome === "unavailable",
  };
};
