import type { ToolHandler } from "../bridge-tools";
import {
  isUiInteractionMode,
  isUiInteractionTarget,
  UI_INTERACTION_INTRODUCTION_MAX_LENGTH,
} from "@shared/ui-interaction";

export const handleUiInteraction: ToolHandler = async (args) => {
  const sessionId = typeof args._sessionId === "string" ? args._sessionId : "";
  const clientId = typeof args._clientId === "string" ? args._clientId : undefined;
  const origin = args._authorityContext?.origin;

  if (!sessionId || !clientId || (origin !== "interactive" && origin !== "voice")) {
    return { result: "UI interaction requires a session-bound interactive or voice run from an active browser tab.", error: true };
  }
  if (!isUiInteractionTarget(args.target)) {
    return { result: "Unknown UI interaction target.", error: true };
  }
  if (!isUiInteractionMode(args.mode)) {
    return { result: "UI interaction mode must be execute or guide.", error: true };
  }

  // Guide narration is mandatory: a spotlight must never appear without first
  // naming the control and asking the user to click it. Fail recoverably so the
  // agent can supply an introduction and retry rather than silently highlighting.
  const introduction = typeof args.introduction === "string" ? args.introduction.trim() : "";
  if (args.mode === "guide" && !introduction) {
    return {
      result: "Guide mode requires an introduction that names the control and explicitly asks the user to click it. Provide a one or two sentence introduction and call ui again.",
      error: true,
    };
  }

  const { requestUiInteraction } = await import("../ui-interaction-coordinator");
  const result = await requestUiInteraction({
    sessionId,
    clientId,
    target: args.target,
    mode: args.mode,
    introduction: introduction ? introduction.slice(0, UI_INTERACTION_INTRODUCTION_MAX_LENGTH) : undefined,
  });

  return {
    result: JSON.stringify(result),
    error: result.outcome === "unavailable",
  };
};
