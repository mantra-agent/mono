/**
 * Unified tool execution pipeline with middleware chain.
 *
 * Both voice and chat converge on this entry point. Voice-specific concerns
 * (session.end interception, park_idea source injection, journal logging,
 * correlation IDs) are middleware functions, not a parallel execution path.
 *
 * The idempotency guard is always-on as the bottom middleware — duplicate
 * calls return cached results with a log warning.
 */
import { createLogger } from "./log";

const log = createLogger("ToolExec");

export interface ToolExecutionContext {
  sessionKey: string;
  sessionId?: string;
  voiceSessionId?: string;
  activity: string;
  runId: string;
  origin?: import("./agent-authority").ToolInvocationOrigin;
  trustedDelegation?: "plan" | "workflow";
}

export interface ToolResult {
  result: string;
  error?: boolean;
  sideEffectOnly?: boolean;
  continuation?: import("./agent-executor").ToolContinuation;
}

export type ToolMiddleware = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  next: () => Promise<ToolResult>,
) => Promise<ToolResult>;

/**
 * Create a tool executor with a middleware chain. Middlewares execute in order,
 * each calling next() to proceed. The terminal handler calls executeTool from
 * bridge-tools.ts.
 *
 * @param middlewares - Array of middleware functions to apply before execution
 * @param ctx - Execution context shared across all tool calls in this run
 * @returns A tool executor function compatible with the SDK's toolExecutor callback
 */
export function createToolExecutor(
  middlewares: ToolMiddleware[],
  ctx: ToolExecutionContext,
): (name: string, args: Record<string, unknown>) => Promise<ToolResult> {
  // Idempotency cache scoped to this executor instance (run lifetime)
  const idempotencyCache = new Map<string, ToolResult>();

  return async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    // Extract or generate a call ID for idempotency
    const callId = (args as Record<string, unknown>)?._toolCallId as string | undefined;
    delete (args as Record<string, unknown>)._toolCallId;

    // Freeze args so no middleware can mutate them (enforces single source of truth)
    const frozenArgs = Object.freeze({ ...args });
    args = frozenArgs;

    // Idempotency check (if we have a call ID)
    if (callId) {
      const cacheKey = `${ctx.runId}:${callId}`;
      const cached = idempotencyCache.get(cacheKey);
      if (cached) {
        log.warn(`[ToolExec] IDEMPOTENT_SKIP tool=${name} key=${cacheKey} — returning cached result`);
        return cached;
      }
    }

    // Build the middleware chain (last middleware calls the terminal handler)
    const chain = [...middlewares];
    let chainIdx = 0;

    const executeNext = async (): Promise<ToolResult> => {
      if (chainIdx < chain.length) {
        const middleware = chain[chainIdx++];
        return middleware(name, args, ctx, executeNext);
      }
      // Terminal handler: call executeTool from bridge-tools
      const { executeTool } = await import("./bridge-tools");
      const start = Date.now();
      const result = await executeTool(name, callId || `exec-${Date.now()}`, args, {
        sessionId: ctx.sessionId || "",
        sessionKey: ctx.sessionKey,
        authority: {
          origin: ctx.origin ?? (ctx.voiceSessionId ? "voice" : "interactive"),
          trustedDelegation: ctx.trustedDelegation,
          activity: ctx.activity,
        },
      });
      const durationMs = Date.now() - start;
      const teLevel = (!result.error && durationMs < 5000) ? log.debug.bind(log) : log.log.bind(log);
      teLevel(`[ToolExec] mode=${ctx.voiceSessionId ? "voice" : "chat"} tool=${name} id=${callId || "none"} → complete ${durationMs}ms error=${!!result.error}`);
      return result;
    };

    const result = await executeNext();

    // Cache the result for idempotency
    if (callId) {
      const cacheKey = `${ctx.runId}:${callId}`;
      idempotencyCache.set(cacheKey, result);
    }

    return result;
  };
}

/**
 * Clear the idempotency cache. Called when a run completes.
 * (Currently the cache is scoped to the executor instance which is
 * garbage-collected when the run ends, so this is a no-op placeholder
 * for future use if we need explicit cleanup.)
 */
export function clearIdempotencyCache(): void {
  // No-op: cache is instance-scoped and GC'd with the executor
}
