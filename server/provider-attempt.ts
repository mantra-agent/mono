import { storage } from "./storage";
import { createLogger } from "./log";

const log = createLogger("provider-attempt");

export interface ProviderAttemptTracker {
  current: {
    apiCallId: number;
    startTime: number;
    provider: string;
    model: string;
    profile: string;
    sessionKey: string;
    sessionId?: string;
    runId?: string;
    metadata: Record<string, unknown>;
  } | null;
}

interface BeginProviderAttemptInput {
  tracker: ProviderAttemptTracker;
  provider: string;
  model: string;
  profile: string;
  attempt: number;
  metadata?: {
    activity?: string;
    source?: string;
    runId?: string;
    sessionId?: string;
    sessionKey?: string;
    requestId?: string;
  };
}

export function createProviderAttemptTracker(): ProviderAttemptTracker {
  return { current: null };
}

async function settleSupersededAttempt(tracker: ProviderAttemptTracker): Promise<void> {
  const current = tracker.current;
  if (!current) return;
  tracker.current = null;
  try {
    const { logApiCall } = await import("./cost-tracker");
    await logApiCall({
      apiCallId: current.apiCallId,
      startTime: current.startTime,
      profile: current.profile,
      provider: current.provider,
      model: current.model,
      sessionId: current.sessionId,
      runId: current.runId,
      sessionKey: current.sessionKey,
      metadata: {
        ...current.metadata,
        status: "error",
        error: { kind: "retry_superseded", message: "Provider attempt was superseded by a retry" },
      },
    });
  } catch (error) {
    log.warn(`failed to settle superseded api_call apiCallId=${current.apiCallId} provider=${current.provider} model=${current.model} error=${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function beginProviderAttempt(input: BeginProviderAttemptInput): Promise<number | null> {
  await settleSupersededAttempt(input.tracker);
  const startTime = Date.now();
  const sessionKey = input.metadata?.sessionKey
    || input.metadata?.sessionId
    || input.metadata?.runId
    || input.metadata?.source
    || "system";
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    activity: input.metadata?.activity ?? null,
    source: input.metadata?.source ?? "unknown",
    status: "dispatched",
    providerAttempt: input.attempt,
    usageSemantics: "unknown",
    tokenAccounting: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      usageSemantics: "unknown",
    },
  };

  try {
    const call = await storage.createApiCall({
      provider: input.provider,
      model: input.model,
      profile: input.profile,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costInput: 0,
      costOutput: 0,
      costTotal: 0,
      sessionKey,
      sessionId: input.metadata?.sessionId ? Number.parseInt(input.metadata.sessionId, 10) || null : null,
      durationMs: null,
      stopReason: null,
      metadata,
    });
    log.debug(`provider attempt created apiCallId=${call.id} provider=${input.provider} model=${input.model} attempt=${input.attempt} sessionIdentity=${input.metadata?.sessionId ? "session" : input.metadata?.sessionKey ? "session_key" : input.metadata?.runId ? "run" : "source"}`);
    input.tracker.current = {
      apiCallId: call.id,
      startTime,
      provider: input.provider,
      model: input.model,
      profile: input.profile,
      sessionKey,
      sessionId: input.metadata?.sessionId,
      runId: input.metadata?.runId,
      metadata,
    };
    return call.id;
  } catch (error) {
    log.warn(`provider attempt audit insert failed provider=${input.provider} model=${input.model} attempt=${input.attempt} error=${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
