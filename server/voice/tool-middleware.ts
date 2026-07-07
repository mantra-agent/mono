/**
 * Voice-specific tool execution middleware.
 *
 * Extracted from executeVoiceTool() in voice-llm.ts. These middleware functions
 * handle voice-specific concerns that wrap the standard tool execution:
 *
 * - Session.end interception (teardown audio immediately)
 * - Park_idea source injection (force source="voice")
 * - Journal logging (tool_call / tool_result entries)
 * - Correlation IDs (per-turn voice-{sessionId}-t{turn}-{idx})
 * - Park_idea failure handling (deterministic UI signal + memory persistence)
 */
import { createLogger } from "../log";
import { eventBus } from "../event-bus";
import type { ToolMiddleware, ToolResult, ToolExecutionContext } from "../tool-execution";

const log = createLogger("VoiceToolMW");

/** Shared voice session reference for middleware to access */
export interface VoiceToolContext {
  voiceSessionId: string;
  chatSessionId: string | null;
  chatSessionKey: string | null;
  originTurn?: number;
  /** Mutable counter incremented per tool call within a turn */
  toolCallIndex: number;
  /** Callback to mark session as ending */
  onSessionEnd?: (reason: string) => void;
  /** Callback to invalidate cached system prompt */
  onPromptInvalidate?: () => void;
  /** Callback to write journal entries */
  onJournal?: (type: string, extra: Record<string, unknown>) => void;
  /** Callback to publish voice events */
  onVoiceEvent?: (event: string, payload: Record<string, unknown>) => void;
  /** Callback to push tool call to session's toolCalls array (may be async for lock acquisition) */
  onToolCallComplete?: (name: string, args: Record<string, unknown>, result: string, callId: string) => void | Promise<void>;
}

/**
 * Create a voice session interceptor middleware.
 * Intercepts session(end) to trigger audio teardown immediately.
 */
export function createVoiceSessionInterceptor(voiceCtx: VoiceToolContext): ToolMiddleware {
  return async (name, args, _ctx, next) => {
    if (name === "session" && args?.action === "end") {
      const reason = (args.summary as string) || "user requested";
      log.log(`session(end) intercepted session=${voiceCtx.voiceSessionId} reason="${reason}"`);
      voiceCtx.onSessionEnd?.(reason);
      eventBus.publish({
        category: "voice",
        event: "session_end",
        payload: {
          sessionId: voiceCtx.voiceSessionId,
          chatSessionId: voiceCtx.chatSessionId,
          reason,
        },
      });
      // Fall through to execute the tool normally
    }
    return next();
  };
}

// park_idea middleware removed — intentions system deprecated

/**
 * Create a voice journal logger middleware.
 * Logs tool_call and tool_result journal entries with correlation IDs.
 */
export function createVoiceJournalLogger(voiceCtx: VoiceToolContext): ToolMiddleware {
  return async (name, args, _ctx, next) => {
    const turnIdx = voiceCtx.toolCallIndex++;
    const turnTag = voiceCtx.originTurn !== undefined
      ? `-t${voiceCtx.originTurn}-${turnIdx}`
      : `-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const callId = `voice-${voiceCtx.voiceSessionId}${turnTag}`;

    log.log(`turn ${voiceCtx.originTurn ?? "?"} tool_call dispatch name=${name} callId=${callId} session=${voiceCtx.voiceSessionId}`);

    voiceCtx.onJournal?.("tool_call", {
      toolName: name,
      toolCallId: callId,
      arguments: args,
      detail: voiceCtx.originTurn !== undefined ? `turn=${voiceCtx.originTurn} idx=${turnIdx}` : undefined,
    });

    eventBus.publish({
      category: "voice",
      event: "voice_tool_start",
      payload: {
        sessionId: voiceCtx.voiceSessionId,
        chatSessionId: voiceCtx.chatSessionId,
        callId,
        toolName: name,
        arguments: args,
        turn: voiceCtx.originTurn,
        turnIdx,
      },
    });

    const result = await next();

    // Post-execution logging
    const resultStr = result.result || "";
    const preview = resultStr.slice(0, 300).replace(/\n/g, "\\n");
    log.log(`turn ${voiceCtx.originTurn ?? "?"} tool_call complete name=${name} callId=${callId} error=${!!result.error} resultLen=${resultStr.length} session=${voiceCtx.voiceSessionId}`);

    voiceCtx.onJournal?.("tool_result", {
      toolName: name,
      toolCallId: callId,
      result: resultStr.slice(0, 2000),
      error: result.error ? "tool error" : undefined,
      detail: voiceCtx.originTurn !== undefined ? `turn=${voiceCtx.originTurn} idx=${turnIdx}` : undefined,
    });

    eventBus.publish({
      category: "voice",
      event: "voice_tool_done",
      payload: {
        sessionId: voiceCtx.voiceSessionId,
        chatSessionId: voiceCtx.chatSessionId,
        callId,
        toolName: name,
        result: resultStr.slice(0, 2000),
        error: result.error || false,
        turn: voiceCtx.originTurn,
        turnIdx,
      },
    });

    // Invalidate prompt cache after any tool execution
    voiceCtx.onPromptInvalidate?.();

    // Push to session toolCalls (awaited — callback may acquire a session lock)
    await voiceCtx.onToolCallComplete?.(name, args, resultStr, callId);

    return result;
  };
}

// park_idea failure handler removed — intentions system deprecated

/**
 * Create the full voice middleware stack in the correct order.
 */
export function createVoiceMiddlewareStack(voiceCtx: VoiceToolContext): ToolMiddleware[] {
  return [
    createVoiceSessionInterceptor(voiceCtx),
    createVoiceJournalLogger(voiceCtx),
  ];
}
