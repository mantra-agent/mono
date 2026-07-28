import type { ToolHandler } from "../bridge-tools";
import { isUiInteractionMode, isUiInteractionTarget } from "@shared/ui-interaction";

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

  const { requestUiInteraction } = await import("../ui-interaction-coordinator");
  const result = await requestUiInteraction({
    sessionId,
    clientId,
    target: args.target,
    mode: args.mode,
  });

  return {
    result: JSON.stringify(result),
    error: result.outcome === "unavailable",
  };
};
