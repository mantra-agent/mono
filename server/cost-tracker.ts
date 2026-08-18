import { storage } from "./storage";
import type { ChatCompletionResult } from "./model-client";
import { getModelCostPerMillion } from "./model-registry";
import { createLogger } from "./log";
import { pool } from "./db";

const log = createLogger("CostTracker");

let dailyTotalCost = 0;
let dailyCallCount = 0;
let dailyDate = new Date().toISOString().split("T")[0];
let dailyInitialized = false;
let dailyInitPromise: Promise<void> | null = null;

async function initializeDailyFromDb(dateStr: string): Promise<void> {
  try {
    const principal = (await import("./principal-context")).getCurrentPrincipal();
    const scopeSql = principal?.actorType === "user" && principal.userId && principal.accountId
      ? "scope = 'user' AND owner_user_id = $2 AND account_id = $3"
      : principal?.actorType === "system"
        ? "scope = 'system'"
        : null;
    if (!scopeSql) throw new Error("Explicit user or system principal required for daily inference totals");
    const result = await pool.query(
      `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(cost_total), 0) AS total_cost
       FROM api_calls WHERE DATE(timestamp) = $1 AND ${scopeSql}`,
      principal?.actorType === "user" ? [dateStr, principal.userId, principal.accountId] : [dateStr]
    );
    const row = result.rows[0];
    dailyCallCount = row?.cnt || 0;
    dailyTotalCost = parseFloat(row?.total_cost) || 0;
    dailyDate = dateStr;
    dailyInitialized = true;
    log.log(`daily totals initialized from DB date=${dateStr} calls=${dailyCallCount} cost=$${dailyTotalCost.toFixed(4)}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`failed to initialize daily totals from DB: ${msg}`);
    dailyInitialized = true;
  }
}


function providerUsageSemantics(provider: string, metadata?: Record<string, unknown>): "per_call" | "cumulative_provider_session" | "unknown" {
  const tokenAccounting = metadata?.tokenAccounting;
  const providerReportedUsage = tokenAccounting && typeof tokenAccounting === "object"
    ? (tokenAccounting as Record<string, unknown>).providerReportedUsage
    : undefined;

  if (metadata?.usageSemantics === "per_call" || metadata?.usageSemantics === "cumulative_provider_session") {
    return metadata.usageSemantics;
  }

  if (provider === "claude-cli") {
    // Claude CLI assistant.usage counters are cumulative within the provider session,
    // not demonstrably per request. Only an explicit producer-provided per_call
    // semantic above can opt a future CLI source into comparable aggregation.
    return providerReportedUsage === "assistant.usage" ? "cumulative_provider_session" : "unknown";
  }

  if (provider === "anthropic" || provider === "openai" || provider === "openai-subscription" || provider === "grok-subscription" || provider === "local") {
    return "per_call";
  }

  return "unknown";
}

async function ensureDailyInitialized(): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  if (dailyInitialized && today === dailyDate) return;

  if (today !== dailyDate) {
    if (dailyInitialized) {
      log.log(`daily reset previous date=${dailyDate} calls=${dailyCallCount} cost=$${dailyTotalCost.toFixed(4)}`);
    }
    dailyInitialized = false;
    dailyInitPromise = null;
  }

  if (!dailyInitPromise) {
    dailyInitPromise = initializeDailyFromDb(today);
  }
  await dailyInitPromise;
}

export async function logApiCall(params: {
  apiCallId?: number;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  requestContent?: string;
  responseContent?: string;
  stopReason?: string;
  startTime: number;
  profile?: string;
  model?: string;
  provider?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    visibleOutputTokens?: number;
  };
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<void> {
  // Honor the abort signal at the entry — if the run has already been aborted by
  // the time we get here, we drop the insert rather than orphan a DB connection
  // beyond the run's drain window. Inserts that have already been issued ride out
  // their own pg statement_timeout.
  if (params.signal?.aborted && !params.apiCallId) {
    return;
  }
  try {
    await ensureDailyInitialized();

    const model = params.model || "unknown";
    const provider = params.provider || "unknown";
    const inputTokens = params.usage?.inputTokens ?? params.usage?.promptTokens ?? 0;
    const outputTokens = params.usage?.outputTokens ?? params.usage?.completionTokens ?? 0;
    const cacheReadTokens = params.usage?.cacheReadTokens ?? 0;
    const cacheWriteTokens = params.usage?.cacheWriteTokens ?? 0;
    const totalTokens = params.usage?.totalTokens || (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens);
    const usageSemantics = providerUsageSemantics(provider, params.metadata);

    const costPerM = getModelCostPerMillion(model);
    const costInput = (inputTokens / 1_000_000) * costPerM.input
      + (cacheReadTokens / 1_000_000) * costPerM.cacheRead
      + (cacheWriteTokens / 1_000_000) * costPerM.cacheWrite;
    const costOutput = (outputTokens / 1_000_000) * costPerM.output;
    const costTotal = costInput + costOutput;

    const durationMs = Date.now() - params.startTime;

    dailyTotalCost += costTotal;
    dailyCallCount++;

    log.log(`logApiCall provider=${provider} model=${model} profile=${params.profile || "unknown"} inputTokens=${inputTokens} outputTokens=${outputTokens} cacheReadTokens=${cacheReadTokens} cacheWriteTokens=${cacheWriteTokens} totalTokens=${totalTokens} cost=$${costTotal.toFixed(6)} duration=${durationMs}ms dailyTotal=$${dailyTotalCost.toFixed(4)} dailyCalls=${dailyCallCount}`);

    const persistedCall = {
      provider,
      model,
      profile: params.profile || "unknown",
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costInput,
      costOutput,
      costTotal,
      sessionKey: params.sessionKey || "system",
      sessionId: params.sessionId ? parseInt(params.sessionId, 10) || null : null,
      requestContent: (params.requestContent || "")?.slice(0, 50000),
      responseContent: params.responseContent?.slice(0, 50000),
      durationMs,
      stopReason: params.stopReason ?? null,
      metadata: {
        ...(params.metadata ?? {}),
        tokenAccounting: {
          ...(typeof params.metadata?.tokenAccounting === "object" && params.metadata?.tokenAccounting !== null
            ? params.metadata.tokenAccounting as Record<string, unknown>
            : {}),
          inputTokens: params.usage ? inputTokens : null,
          outputTokens: params.usage ? outputTokens : null,
          totalTokens: params.usage ? totalTokens : null,
          cacheReadTokens: params.usage ? cacheReadTokens : null,
          cacheWriteTokens: params.usage ? cacheWriteTokens : null,
          reasoningTokens: params.usage?.reasoningTokens ?? null,
          visibleOutputTokens: params.usage?.visibleOutputTokens ?? null,
          usageSemantics,
        },
        usageSemantics,
      },
    };
    let settledAccountId: string | null = null;
    if (params.apiCallId) {
      const settled = await storage.settleApiCall(params.apiCallId, persistedCall);
      if (!settled) {
        log.warn(`api_call settlement unavailable apiCallId=${params.apiCallId} provider=${provider} model=${model}`);
      } else {
        settledAccountId = settled.accountId ?? null;
      }
    } else {
      const created = await storage.createApiCall(persistedCall);
      settledAccountId = created.accountId ?? null;
    }
    if (settledAccountId) {
      const { settleAccountUsageEnvelope } = await import("./account-usage-envelope");
      await settleAccountUsageEnvelope(settledAccountId);
    }
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    log.error(
      `logApiCall failed model=${params.model || "unknown"} provider=${params.provider || "unknown"} profile=${params.profile || "unknown"} runId=${params.runId || "none"} error=${errorMessage}` +
      (errorStack ? `\n${errorStack}` : "")
    );
  }
}

export function trackEmbedding(params: {
  tokenCount: number;
  startTime: number;
  profile?: string;
  batchSize?: number;
  texts?: string[];
}) {
  log.log(`trackEmbedding tokens=${params.tokenCount} batchSize=${params.batchSize || 1} profile=${params.profile || "embedding"}`);
  let requestContent: string;
  if (params.texts && params.texts.length > 0) {
    requestContent = JSON.stringify(params.texts).slice(0, 50000);
  } else {
    requestContent = `Embedding batch of ${params.batchSize || 1} texts`;
  }
  logApiCall({
    startTime: params.startTime,
    profile: params.profile || "embedding",
    model: "all-MiniLM-L6-v2",
    provider: "local",
    usage: { inputTokens: params.tokenCount, outputTokens: 0, totalTokens: params.tokenCount },
    requestContent,
  }).then(
    () => undefined,
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`trackEmbedding logApiCall failed profile=${params.profile || "embedding"}: ${msg}`);
    },
  );
}

