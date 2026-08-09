import type { ToolContinuation, ToolExecutorResult } from "../agent-executor";
import type { AgentAuthorityContext } from "../agent-authority";
import type { ToolFailure } from "../tool-failure";
import type { UiInteractionNarrationState } from "@shared/ui-interaction";

export interface ToolInvocationContext {
  sessionKey: string;
  sessionId: string;
  clientId?: string;
  uiNarrationState?: UiInteractionNarrationState;
  orientationPersonaPolicy?: "replace" | "preserve_existing";
  authority?: AgentAuthorityContext;
}

export interface ToolExecutionResult extends ToolExecutorResult {
  durationMs: number;
}

export interface ToolHandlerResult {
  result: string;
  error?: boolean;
  failure?: ToolFailure;
  data?: Record<string, unknown>;
  continuation?: ToolContinuation;
  normalizedArguments?: Record<string, unknown>;
}

export type ToolHandler = (
  args: Record<string, any>,
) => Promise<ToolHandlerResult>;
