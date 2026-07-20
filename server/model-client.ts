import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { ACTIVITY_FRAMING, ACTIVITY_CHAT, type ActivityId } from "./job-profiles";
import { resolveModelCandidates, appendFailedAttempt, type ModelRoutingDecision } from "./model-routing";
import { getMaxOutputTokens, getModel, supportsSelectableEffort } from "./model-registry";
import type { OpenAITierModelConfig } from "@shared/model-connectors";
import { resolveOpenAIReasoningEffort, type OpenAIReasoningEffort } from "./thinking-config";
import { withTimeout, STREAM_FINAL_MESSAGE_TIMEOUT_MS } from "./timeout";
import { createLogger } from "./log";
import { getSecretSync, onSecretChange } from "./secrets-store";
import type { ToolDefinition } from "@shared/models/tools";
import type {
  ModelProviderFailureInfo,
  ProviderStreamProgressInfo,
  ProviderTraceInfo,
  ProviderTransportErrorInfo,
} from "@shared/models/chat";
import { createNamedSystemPrincipal } from "./principal";
import { runWithPrincipal } from "./principal-context";
import { resolveSessionModelTierOverride } from "./session-model-tier-override";
import { safeStringify } from "./utils/safe-stringify";

let _openaiClient: OpenAI | null = null;
let _anthropicClient: Anthropic | null = null;

onSecretChange((name) => {
  if (name === "OPENAI_API_KEY") {
    _openaiClient = null;
  }
  if (name === "ANTHROPIC_API_KEY") {
    _anthropicClient = null;
  }
});

function getOpenAIClient(apiKeyOverride?: string): OpenAI {
  if (apiKeyOverride) return new OpenAI({ apiKey: apiKeyOverride });
  if (!_openaiClient) {
    const apiKey = getSecretSync("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("OpenAI API key not configured — add one in Settings → Secrets");
    }
    _openaiClient = new OpenAI({ apiKey });
  }
  return _openaiClient;
}

const OPENAI_SUBSCRIPTION_ACCOUNT_ID = "openai-subscription-primary";
const OPENAI_SUBSCRIPTION_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_SUBSCRIPTION_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_SUBSCRIPTION_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";


interface OpenAISubscriptionTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expiry_date?: number;
  email?: string;
}

function isOpenAISubscriptionTokens(v: unknown): v is OpenAISubscriptionTokens {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).access_token === "string";
}

async function getOpenAISubscriptionAccessToken(): Promise<string> {
  return runWithPrincipal(createNamedSystemPrincipal("model-client"), async () => {
    const { getAccountTokens, updateAccount } = await import("./connected-accounts");
    const rawTokens = await getAccountTokens(OPENAI_SUBSCRIPTION_ACCOUNT_ID);
    if (!isOpenAISubscriptionTokens(rawTokens)) {
      throw new Error("OpenAI Subscription not connected. Please connect your ChatGPT account in Settings → Connections.");
    }

    const tokens: OpenAISubscriptionTokens = rawTokens;

    // Check if token needs refresh. OpenAI Subscription is a system integration:
    // all users can use it for model execution, but only system/admin paths may
    // read or rotate its OAuth tokens.
    const isExpired = typeof tokens.expiry_date === "number" && Date.now() >= tokens.expiry_date - 60_000;
    if (isExpired && tokens.refresh_token) {
      log.debug("openai-subscription: refreshing access token");
      try {
        const params = new URLSearchParams({
          client_id: OPENAI_SUBSCRIPTION_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        });
        const response = await fetch(OPENAI_SUBSCRIPTION_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        if (response.ok) {
          const newTokens = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number };
          const updated: OpenAISubscriptionTokens = {
            ...tokens,
            access_token: newTokens.access_token,
            refresh_token: newTokens.refresh_token || tokens.refresh_token,
            expiry_date: newTokens.expires_in ? Date.now() + newTokens.expires_in * 1000 : undefined,
          };
          await updateAccount(OPENAI_SUBSCRIPTION_ACCOUNT_ID, { tokens: updated });
          log.debug("openai-subscription: token refreshed successfully");
          return updated.access_token;
        } else {
          log.warn("openai-subscription: token refresh failed, using existing token");
        }
      } catch (err: any) {
        log.warn(`openai-subscription: token refresh error: ${err.message}`);
      }
    }

    return tokens.access_token;
  });
}


type CodexContentBlock =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

type CodexInputItem =
  | { role: string; content: string | Array<CodexContentBlock> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface CodexResponsesRequest {
  model: string;
  instructions: string;
  input: Array<CodexInputItem>;
  store: boolean;
  temperature?: number;
  reasoning?: { effort?: OpenAIReasoningEffort; summary?: "detailed" | "concise" | "auto"; mode?: "standard" | "pro" };
  text?: { verbosity?: "low" | "medium" | "high"; format?: Record<string, unknown> };
  tools?: Array<
    | { type: "function"; name: string; description: string; parameters: Record<string, unknown> }
    | { type: "image_generation"; quality?: string; size?: string; background?: string; output_format?: string }
  >;
  tool_choice?: { type: string } | "auto" | "none";
  stream?: boolean;
}

interface CodexResponsesChunk {
  type: string;
  sequence_number?: number;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  delta?: string | { arguments?: string };
  code?: string;
  message?: string;
  param?: string | null;
  output?: Array<{ type: string; id?: string; content?: Array<{ type: string; text?: string }> }>;
  item?: { type?: string; id?: string; name?: string; call_id?: string; arguments?: string };
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
  response?: {
    id?: string;
    status?: string;
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
    error?: { code?: string; message?: string; type?: string };
    incomplete_details?: { reason?: string } | null;
  };
  error?: { code?: string; message?: string; type?: string };
}

interface ToolResultBlock {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ToolUseBlock {
  type: "tool_use";
  id?: string;
  call_id?: string;
  name?: string;
  input?: unknown;
}

interface TextBlock {
  type: "text";
  text?: string;
}

type AssistantContentBlock = ToolUseBlock | TextBlock | { type: string };

function isToolUseBlock(block: AssistantContentBlock): block is ToolUseBlock {
  return block.type === "tool_use";
}

function isTextBlock(block: AssistantContentBlock): block is TextBlock {
  return block.type === "text";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function buildCodexInput(messages: Array<{ role: string; content: unknown; toolCallId?: string; name?: string }>): { instructions: string; input: CodexResponsesRequest["input"] } {
  let instructions = "";
  const input: CodexResponsesRequest["input"] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      instructions += (instructions ? "\n" : "") + content;
    } else if (m.role === "tool" || m.role === "tool_result") {
      if (Array.isArray(m.content)) {
        for (const rawBlock of m.content) {
          const block: ToolResultBlock = isRecord(rawBlock) ? rawBlock as ToolResultBlock : {};
          const callId = (typeof block.tool_use_id === "string" ? block.tool_use_id : undefined) || m.toolCallId;
          if (!callId) {
            log.warn("buildCodexInput: skipping tool_result block with missing call_id");
            continue;
          }
          const output = block.content !== undefined
            ? (typeof block.content === "string" ? block.content : JSON.stringify(block.content))
            : JSON.stringify(rawBlock);
          input.push({ type: "function_call_output", call_id: callId, output });
        }
      } else {
        const callId = m.toolCallId;
        if (!callId) {
          log.warn("buildCodexInput: skipping tool_result message with missing toolCallId");
          continue;
        }
        const output = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        input.push({ type: "function_call_output", call_id: callId, output });
      }
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const rawBlock of m.content) {
        const block: AssistantContentBlock = isRecord(rawBlock)
          ? rawBlock as AssistantContentBlock
          : { type: "" };
        if (isToolUseBlock(block)) {
          const callId = block.id || block.call_id;
          const name = block.name;
          if (!callId || !name) {
            log.warn("buildCodexInput: skipping tool_use block with missing id or name");
            continue;
          }
          input.push({
            type: "function_call",
            call_id: callId,
            name,
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
          });
        } else if (isTextBlock(block) && block.text) {
          input.push({ role: "assistant", content: block.text });
        }
      }
    } else if (Array.isArray(m.content)) {
      const blocks: CodexContentBlock[] = [];
      for (const block of m.content) {
        if (isRecord(block) && block.type === "image_url" && isRecord(block.image_url) && typeof (block.image_url as Record<string, unknown>).url === "string") {
          blocks.push({ type: "input_image", image_url: (block.image_url as Record<string, unknown>).url as string });
        } else if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          blocks.push({ type: "input_text", text: block.text });
        } else if (isRecord(block) && typeof block.text === "string") {
          blocks.push({ type: "input_text", text: block.text });
        }
      }
      if (blocks.length > 0) {
        input.push({ role: m.role, content: blocks });
      } else {
        input.push({ role: m.role, content: JSON.stringify(m.content) });
      }
    } else {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      input.push({ role: m.role, content });
    }
  }
  if (!instructions) {
    instructions = "You are a helpful assistant.";
  }
  return { instructions, input };
}

function getAnthropicClient(apiKeyOverride?: string): Anthropic {
  if (apiKeyOverride) return new Anthropic({ apiKey: apiKeyOverride });
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({
      apiKey: getSecretSync("ANTHROPIC_API_KEY"),
    });
  }
  return _anthropicClient;
}

function parseModelString(modelString: string): { provider: string; model: string } {
  const parts = modelString.split("/");
  if (parts.length >= 2) {
    return { provider: parts[0], model: parts.slice(1).join("/") };
  }
  return { provider: "openai", model: modelString };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<{ type: string; [key: string]: any }>;
}

export interface ChatCompletionOptions {
  activity?: ActivityId;
  model?: string;
  /** Diagnostic/system-only semantic tier override. Normal routing derives the tier from the active persona. */
  semanticTierOverride?: import("@shared/model-connectors").SemanticTier;
  /**
   * Pre-resolved routing decision. Use this when a caller has already routed by
   * activity/tier and is merely handing the resolved model to the provider
   * boundary. Passing `model` alone means a true explicit model override.
   */
  routingDecision?: ModelRoutingDecision;
  overrideReason?: string;
  metadata?: InferenceMetadata;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  /**
   * Hard latency budget the caller enforces (typically via an AbortSignal).
   * Routing skips connectors whose provider has a structural floor latency
   * above this budget, so a doomed first attempt cannot consume the whole
   * window and starve failover. Falls back to the full candidate pool when
   * no connector fits the budget.
   */
  latencyBudgetMs?: number;
  signal?: AbortSignal;
  tools?: ToolDefinition[];
  /**
   * Resolved tier thinking config. When provided, effort-capable OpenAI models
   * (registry selectableEffort) receive a mapped reasoning effort. Omitted =
   * provider default behavior (no effort sent).
   */
  thinking?: import("./thinking-config").ResolvedThinking;
  /** Dedicated one-shot Claude CLI lane. Only named latency-critical calls may opt in. */
  warmPoolLane?: "orientation";
}

export type InferenceStatus = "success" | "error" | "aborted" | "partial";

export interface InferenceMetadata {
  activity?: ActivityId;
  source: string;
  runId?: string;
  sessionId?: string;
  /** String session key for grouping api_calls (e.g. "dashboard:abc123", "timer:xyz").
   *  When provided, recordInference uses this as the session_key instead of deriving
   *  one from sessionId/runId/source. This ensures the boundary recording captures
   *  the correct session grouping without requiring a second logApiCall from the caller. */
  sessionKey?: string;
  skillId?: string;
  userId?: string;
  toolName?: string;
  planId?: string;
  stepId?: string;
  requestId?: string;
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  provider: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; visibleOutputTokens?: number };
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }>;
  metadata?: Record<string, unknown>;
}

const log = createLogger("ModelClient");

function buildRequestContent(messages: Array<{ role: string; content: unknown }>): string | undefined {
  try {
    return JSON.stringify(messages.map(m => ({ role: m.role, content: m.content }))).slice(0, 50000);
  } catch {
    return undefined;
  }
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  const e = err as { name?: string; code?: string } | null;
  return !!signal?.aborted || e?.name === "AbortError" || e?.code === "ERR_CANCELED";
}

function serializeModelError(err: unknown): Record<string, unknown> {
  const e = err as {
    name?: string;
    message?: string;
    code?: string;
    kind?: string;
    retryable?: boolean;
    status?: number;
    attempts?: number;
    phase?: string;
    bodySnippet?: string;
    clientRequestId?: string;
    providerRequestId?: string;
    providerFailure?: ModelProviderFailure;
  } | null;
  return {
    name: e?.name || "Error",
    message: e?.message || String(err),
    code: e?.code,
    kind: e?.kind,
    retryable: e?.retryable,
    status: e?.status,
    attempts: e?.attempts,
    phase: e?.phase,
    bodySnippet: sanitizeProviderDiagnostic(e?.bodySnippet),
    clientRequestId: e?.clientRequestId,
    providerRequestId: e?.providerRequestId,
    providerFailure: e?.providerFailure,
  };
}

function auditRouting(routing: ModelRoutingDecision): Omit<ModelRoutingDecision, "credential" | "fallbackCandidates"> & { requestedTier: string; resolvedModel: string; connectorProvider: string } {
  const { credential: _credential, fallbackCandidates: _fallbackCandidates, ...safe } = routing;
  return {
    ...safe,
    requestedTier: routing.tier,
    resolvedModel: routing.modelString,
    connectorProvider: routing.provider,
  };
}

async function recordInference(params: {
  startTime: number;
  routing: ModelRoutingDecision;
  metadata?: InferenceMetadata;
  status: InferenceStatus;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    visibleOutputTokens?: number;
  };
  requestContent?: string;
  responseContent?: string;
  error?: Record<string, unknown>;
  latency?: { providerTtftMs?: number | null; firstSdkEventMs?: number | null; firstThinkingMs?: number | null };
  signal?: AbortSignal;
}): Promise<void> {
  try {
    const { logApiCall } = await import("./cost-tracker");
    const meta = params.metadata;
    await logApiCall({
      startTime: params.startTime,
      profile: params.routing.tier,
      provider: params.routing.provider,
      model: params.routing.model,
      usage: params.usage,
      sessionId: meta?.sessionId,
      runId: meta?.runId,
      sessionKey: meta?.sessionKey || meta?.sessionId || meta?.runId || meta?.source || "system",
      requestContent: params.requestContent,
      responseContent: params.responseContent,
      signal: params.signal,
      metadata: {
        ...(meta || {}),
        activity: meta?.activity || params.routing.activity,
        source: meta?.source || "unknown",
        workloadSource: (meta as Record<string, unknown> | undefined)?.workloadSource || meta?.source || params.routing.activity || "unknown",
        routingSource: params.routing.source,
        tier: params.routing.tier,
        resolvedTier: params.routing.tier,
        resolvedModel: params.routing.modelString,
        resolvedProvider: params.routing.provider,
        connectorId: params.routing.connectorId,
        connectorLabel: params.routing.connectorLabel,
        connectorOrder: params.routing.connectorOrder,
        status: params.status,
        routing: auditRouting(params.routing),
        error: params.error,
        latency: params.latency,
        trackedAtBoundary: true,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`boundary inference tracking failed provider=${params.routing.provider} model=${params.routing.model} status=${params.status}: ${msg}`);
  }
}

function enrichModelError(err: unknown, routing: ModelRoutingDecision, metadata?: InferenceMetadata): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  (base as Error & { code?: string; routing?: ModelRoutingDecision; inferenceMetadata?: InferenceMetadata }).routing = routing;
  (base as Error & { code?: string; routing?: ModelRoutingDecision; inferenceMetadata?: InferenceMetadata }).inferenceMetadata = metadata;
  if (!(base as Error & { code?: string }).code) {
    const msg = base.message.toLowerCase();
    (base as Error & { code?: string }).code = msg.includes("rate limit") || msg.includes("quota") ? "PROVIDER_QUOTA" : "MODEL_PROVIDER_ERROR";
  }
  return base;
}

/**
 * Structural minimum latency per provider. claude-cli runs a subprocess whose
 * spin-up alone exceeds sub-2s budgets, so it can never satisfy a
 * tight-latency call regardless of model speed.
 */
const PROVIDER_FLOOR_LATENCY_MS: Record<string, number> = { "claude-cli": 4000 };

/**
 * Filter routing candidates to those whose provider floor latency fits the
 * caller's budget. Degrades gracefully to the full pool when nothing fits,
 * which matches pre-budget behavior instead of failing routing outright.
 */
function latencyEligibleCandidates(
  candidates: ModelRoutingDecision[],
  latencyBudgetMs: number | undefined,
): ModelRoutingDecision[] {
  if (!latencyBudgetMs) return candidates;
  const eligible = candidates.filter(
    (candidate) => (PROVIDER_FLOOR_LATENCY_MS[candidate.provider] ?? 0) <= latencyBudgetMs,
  );
  if (!eligible.length) {
    log.warn(`no connector fits latencyBudgetMs=${latencyBudgetMs}; using full candidate pool providers=${candidates.map((candidate) => candidate.provider).join(",")}`);
    return candidates;
  }
  if (eligible.length < candidates.length) {
    const skipped = candidates.filter((candidate) => !eligible.includes(candidate));
    log.debug(`skipped latency-ineligible connectors budgetMs=${latencyBudgetMs} skipped=${skipped.map((candidate) => `${candidate.provider}/${candidate.model}`).join(",")}`);
  }
  return eligible;
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const activity = options.activity || options.metadata?.activity || ACTIVITY_FRAMING;
  const sessionTierOverride = !options.model && !options.routingDecision && !options.semanticTierOverride
    ? await resolveSessionModelTierOverride(options.metadata)
    : null;
  const candidates = latencyEligibleCandidates(
    options.routingDecision
      ? [options.routingDecision, ...(options.routingDecision.fallbackCandidates || [])]
      : await resolveModelCandidates(activity, {
          model: options.model,
          overrideReason: options.overrideReason || (sessionTierOverride ? "session model tier override" : undefined),
          semanticTierOverride: options.semanticTierOverride || sessionTierOverride || undefined,
          sessionId: options.metadata?.sessionId,
        }),
    options.latencyBudgetMs,
  );
  let failures = candidates[0]?.attempts ?? [];
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index++) {
    const routing = { ...candidates[index], attempts: failures.length ? failures : candidates[index].attempts };
    try {
      return await executeChatCompletion({ ...options, routingDecision: routing }, routing);
    } catch (error) {
      lastError = error;
      if (isAbortError(error, options.signal)) throw error;
      failures = appendFailedAttempt(routing, error);
      const next = candidates[index + 1];
      if (next) log.warn(`model connector fallback connector=${routing.connectorId} tier=${routing.tier} model=${routing.model} nextConnector=${next.connectorId} nextModel=${next.model} failure=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError;
}

async function executeChatCompletion(options: ChatCompletionOptions, routing: ModelRoutingDecision): Promise<ChatCompletionResult> {
  const activity = options.activity || options.metadata?.activity || ACTIVITY_FRAMING;
  const { provider, model } = routing;
  const msgCount = options.messages.length;
  const start = Date.now();
  const requestContent = buildRequestContent(options.messages);
  let result: ChatCompletionResult | undefined;

  if (!options.metadata) log.warn(`chatCompletion missing metadata provider=${provider} model=${model} activity=${activity}`);
  log.debug(`chatCompletion provider=${provider} model=${model} activity=${routing.activity} tier=${routing.tier} source=${routing.source} configHash=${routing.configHash} messages=${msgCount} maxTokens=${options.maxTokens ?? "default"} jsonMode=${!!options.jsonMode}`);

  try {
    result = provider === "anthropic"
      ? await anthropicCompletion(model, { ...options, routingDecision: routing })
      : provider === "claude-cli"
        ? await claudeCliCompletion(model, { ...options, routingDecision: routing })
        : provider === "openai-subscription"
          ? await openaiSubscriptionCompletion(model, options)
          : await openaiCompletion(model, { ...options, routingDecision: routing });

    result = { ...result, metadata: { ...(result.metadata || {}), routing: auditRouting(routing), trackedAtBoundary: true } };
    const elapsed = Date.now() - start;
    const usage = result.usage;
    log.debug(`chatCompletion done in ${elapsed}ms provider=${provider} model=${model} activity=${routing.activity} tier=${routing.tier} configHash=${routing.configHash} prompt=${usage?.promptTokens ?? "?"} completion=${usage?.completionTokens ?? "?"} total=${usage?.totalTokens ?? "?"}`);
    await recordInference({ startTime: start, routing, metadata: options.metadata, status: "success", usage, requestContent, responseContent: result.content, signal: options.signal });
    return result;
  } catch (err: any) {
    const elapsed = Date.now() - start;
    const status: InferenceStatus = isAbortError(err, options.signal) ? "aborted" : "error";
    routing.attempts = appendFailedAttempt(routing, err);
    const errorMetadata = serializeModelError(err);
    log.error(`chatCompletion ${status.toUpperCase()} in ${elapsed}ms provider=${provider} model=${model} activity=${routing.activity} tier=${routing.tier} configHash=${routing.configHash}: ${err.message}`);
    const providerUsage = err instanceof ModelProviderError && err.providerFailure.usage
      ? {
          inputTokens: err.providerFailure.usage.inputTokens,
          outputTokens: err.providerFailure.usage.outputTokens,
          totalTokens: err.providerFailure.usage.totalTokens,
          cacheReadTokens: err.providerFailure.usage.cacheReadTokens,
          reasoningTokens: err.providerFailure.usage.reasoningTokens,
        }
      : undefined;
    await recordInference({ startTime: start, routing, metadata: options.metadata, status, usage: result?.usage || providerUsage, requestContent, responseContent: result?.content, error: errorMetadata, signal: options.signal });
    throw enrichModelError(err, routing, options.metadata);
  }
}

function usesMaxCompletionTokens(model: string): boolean {
  return model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4") || model.startsWith("gpt-5");
}


function resolvedOpenAIConfig(options: Pick<ChatCompletionOptions, "routingDecision">): OpenAITierModelConfig | undefined {
  return options.routingDecision?.provider === "openai" || options.routingDecision?.provider === "openai-subscription"
    ? options.routingDecision.modelConfig as OpenAITierModelConfig | undefined
    : undefined;
}

function connectorMaxOutputTokens(config: OpenAITierModelConfig | undefined, runtimeMaxTokens?: number): number | undefined {
  if (runtimeMaxTokens !== undefined) return config?.maxOutputTokens !== undefined ? Math.min(runtimeMaxTokens, config.maxOutputTokens) : runtimeMaxTokens;
  return config?.maxOutputTokens;
}

function connectorReasoningEffort(config: OpenAITierModelConfig | undefined, model: string, thinking: ChatCompletionOptions["thinking"], surface: "responses" | "codex"): OpenAIReasoningEffort | undefined {
  if (config?.reasoningEffort) return config.reasoningEffort as OpenAIReasoningEffort;
  return supportsSelectableEffort(model) ? resolveOpenAIReasoningEffort(thinking, surface) : undefined;
}

function buildOpenAIReasoningConfig(config: OpenAITierModelConfig | undefined, model: string, thinking: ChatCompletionOptions["thinking"], surface: "responses" | "codex"): Record<string, unknown> | undefined {
  const reasoning: Record<string, unknown> = {};
  const effort = connectorReasoningEffort(config, model, thinking, surface);
  if (effort) reasoning.effort = effort;
  if (surface === "responses" && config?.reasoningMode) reasoning.mode = config.reasoningMode;
  if (config?.reasoningSummary && config.reasoningSummary !== "none") reasoning.summary = config.reasoningSummary;
  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

function applyOpenAIConnectorConfig(params: Record<string, any>, config: OpenAITierModelConfig | undefined, model: string, options: ChatCompletionOptions, surface: "responses" | "codex"): void {
  const maxOutput = connectorMaxOutputTokens(config, options.maxTokens);
  if (surface === "responses" && maxOutput !== undefined) params.max_output_tokens = maxOutput;
  const reasoning = buildOpenAIReasoningConfig(config, model, options.thinking, surface);
  if (reasoning) params.reasoning = reasoning;
  if (surface === "responses" && config?.verbosity) {
    params.text = { ...(params.text || {}), verbosity: config.verbosity };
  }
  if (surface === "responses" && config?.serviceTier && config.serviceTier !== "auto") {
    params.service_tier = config.serviceTier;
  }
}

async function openaiCompletion(model: string, options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  // Effort-capable models (GPT-5.6 family) use the Responses API so the tier
  // thinking config can map onto a reasoning effort.
  const connectorConfig = resolvedOpenAIConfig(options);
  if (supportsSelectableEffort(model) || connectorConfig?.reasoningMode || connectorConfig?.reasoningSummary || connectorConfig?.verbosity || connectorConfig?.serviceTier) {
    return openaiResponsesCompletion(model, options);
  }

  const client = getOpenAIClient(options.routingDecision?.credential);

  const params: any = {
    model,
    messages: options.messages.map(m => ({
      role: m.role,
      content: m.content,
    })),
  };

  const chatMaxTokens = connectorMaxOutputTokens(connectorConfig, options.maxTokens);
  if (chatMaxTokens) {
    if (usesMaxCompletionTokens(model)) {
      params.max_completion_tokens = chatMaxTokens;
    } else {
      params.max_tokens = chatMaxTokens;
    }
  }
  if (options.temperature !== undefined) params.temperature = options.temperature;
  if (options.jsonMode) params.response_format = { type: "json_object" };

  const clientRequestId = randomUUID();
  try {
    const responsePromise = client.chat.completions.create(params, {
      signal: options.signal,
      maxRetries: 0,
      headers: { "X-Client-Request-Id": clientRequestId },
    });
    const { data: response } = await responsePromise.withResponse();
    const content = response.choices[0]?.message?.content || "";

    return {
      content,
      model,
      provider: "openai",
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  } catch (err: unknown) {
    if (isAbortError(err, options.signal)) throw err;
    throw modelProviderErrorFromAttempt(
      openaiSdkAttemptError(err, clientRequestId),
      1,
      { provider: "openai", model, metadata: options.metadata },
    );
  }
}

/**
 * Direct OpenAI Responses API completion — used for models with a selectable
 * reasoning effort (registry `selectableEffort`). Reuses the Responses-format
 * message and tool converters shared with the Codex subscription path.
 */
async function openaiResponsesCompletion(model: string, options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const client = getOpenAIClient(options.routingDecision?.credential);
  const { instructions, input } = buildCodexInput(options.messages);

  const params: Record<string, any> = {
    model,
    instructions,
    input,
    store: false,
  };
  const connectorConfig = resolvedOpenAIConfig(options);
  applyOpenAIConnectorConfig(params, connectorConfig, model, options, "responses");
  if (options.jsonMode) params.text = { ...(params.text || {}), format: { type: "json_object" } };
  if (options.tools && options.tools.length > 0) {
    params.tools = convertToolsToCodexResponses(options.tools);
  }

  const clientRequestId = randomUUID();
  try {
    const responsePromise = client.responses.create(params as any, {
      signal: options.signal,
      maxRetries: 0,
      headers: { "X-Client-Request-Id": clientRequestId },
    });
    const { data: response, request_id: providerRequestId } = await responsePromise.withResponse();
    if (response.status === "failed") {
      throw modelProviderErrorFromAttempt(
        responsesProviderFailure(
          { type: "response.failed", response } as CodexResponsesChunk,
          { clientRequestId, providerRequestId: providerRequestId || undefined },
        ),
        1,
        { provider: "openai", model, metadata: options.metadata },
      );
    }
    const content = typeof response.output_text === "string" ? response.output_text : "";

    return {
      content,
      model,
      provider: "openai",
      usage: response.usage ? {
        promptTokens: response.usage.input_tokens || 0,
        completionTokens: response.usage.output_tokens || 0,
        totalTokens: response.usage.total_tokens || 0,
      } : undefined,
    };
  } catch (err: unknown) {
    if (isAbortError(err, options.signal) || err instanceof ModelProviderError) throw err;
    throw modelProviderErrorFromAttempt(
      openaiSdkAttemptError(err, clientRequestId),
      1,
      { provider: "openai", model, metadata: options.metadata },
    );
  }
}

/**
 * Retry schedule for transient Codex 5xx / network failures.
 * OpenAI's Codex Responses endpoint occasionally returns brief 500s; the
 * Anthropic provider already retries `overloaded_error` with the same shape.
 */
const CODEX_RETRY_DELAYS_MS = [1000, 2000, 4000];
const CODEX_COMPLETION_MAX_ATTEMPTS = CODEX_RETRY_DELAYS_MS.length + 1;
const CODEX_STREAM_MAX_ATTEMPTS = 2;
const CODEX_TIME_TO_FIRST_EVENT_MS = 20_000;

class CodexAbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

export type ModelProviderFailureKind =
  | "transport"
  | "http_retryable"
  | "http_permanent"
  | "rate_limited"
  | "time_to_first_event"
  | "stream_interrupted"
  | "provider_failed"
  | "protocol_invalid";

export type ModelProviderFailurePhase = "fetch" | "first_event" | "stream" | "protocol";

export interface ModelProviderFailure extends ModelProviderFailureInfo {
  kind: ModelProviderFailureKind;
  provider: "openai-subscription" | "openai";
  phase: ModelProviderFailurePhase;
}


const MAX_PROVIDER_DIAGNOSTIC_CHARS = 2_000;

function sanitizeProviderDiagnostic(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:access_token|refresh_token|authorization|api[_-]?key)["']?\s*[:=]\s*)["']?[^"'\s,}]+["']?/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, MAX_PROVIDER_DIAGNOSTIC_CHARS);
}

function providerTransportErrorInfo(error: unknown, depth = 0, seen = new Set<object>()): ProviderTransportErrorInfo | undefined {
  if (error === undefined || error === null || depth > 3) return undefined;
  if (typeof error !== "object") {
    return { message: sanitizeProviderDiagnostic(String(error)) };
  }
  if (seen.has(error)) return { message: "[Circular error cause]" };
  seen.add(error);

  const record = error as Record<string, unknown>;
  const socketRecord = record.socket && typeof record.socket === "object"
    ? record.socket as Record<string, unknown>
    : undefined;
  const numericSocketField = (key: string): number | undefined => {
    const value = socketRecord?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };
  const stringSocketField = (key: string): string | undefined => {
    const value = socketRecord?.[key];
    return typeof value === "string" ? sanitizeProviderDiagnostic(value)?.slice(0, 256) : undefined;
  };
  const socket = socketRecord ? {
    localAddress: stringSocketField("localAddress"),
    localPort: numericSocketField("localPort"),
    remoteAddress: stringSocketField("remoteAddress"),
    remotePort: numericSocketField("remotePort"),
    remoteFamily: stringSocketField("remoteFamily"),
    timeout: numericSocketField("timeout"),
    bytesWritten: numericSocketField("bytesWritten"),
    bytesRead: numericSocketField("bytesRead"),
  } : undefined;
  const boundedSocket = socket && Object.values(socket).some((value) => value !== undefined) ? socket : undefined;
  const errno = record.errno;

  return {
    name: typeof record.name === "string" ? sanitizeProviderDiagnostic(record.name)?.slice(0, 128) : undefined,
    message: typeof record.message === "string" ? sanitizeProviderDiagnostic(record.message) : undefined,
    code: typeof record.code === "string" || typeof record.code === "number"
      ? sanitizeProviderDiagnostic(String(record.code))?.slice(0, 128)
      : undefined,
    errno: typeof errno === "string" || typeof errno === "number" ? errno : undefined,
    syscall: typeof record.syscall === "string" ? sanitizeProviderDiagnostic(record.syscall)?.slice(0, 128) : undefined,
    socket: boundedSocket,
    cause: providerTransportErrorInfo(record.cause, depth + 1, seen),
  };
}

function providerTraceInfo(headers: Headers): ProviderTraceInfo | undefined {
  const read = (name: string): string | undefined => sanitizeProviderDiagnostic(headers.get(name) || undefined)?.slice(0, 256);
  const trace: ProviderTraceInfo = {
    responseDate: read("date"),
    cfRay: read("cf-ray"),
    cfCacheStatus: read("cf-cache-status"),
    server: read("server"),
    via: read("via"),
    openaiProcessingMs: read("openai-processing-ms"),
    envoyUpstreamServiceTime: read("x-envoy-upstream-service-time"),
  };
  return Object.values(trace).some((value) => value !== undefined) ? trace : undefined;
}

interface CodexStreamProgressState {
  headersMs?: number;
  firstEventAt?: number;
  lastEventAt?: number;
  eventCount: number;
  bytesReceived: number;
  lastEventType?: string;
  lastSequenceNumber?: number;
}

function observeCodexProviderEvent(state: CodexStreamProgressState, chunk: CodexResponsesChunk): number {
  const observedAt = Date.now();
  if (state.firstEventAt === undefined) state.firstEventAt = observedAt;
  state.lastEventAt = observedAt;
  state.eventCount++;
  state.lastEventType = chunk.type;
  if (typeof chunk.sequence_number === "number") state.lastSequenceNumber = chunk.sequence_number;
  return observedAt;
}

function codexStreamProgressInfo(
  scope: CodexAttemptScope,
  state: CodexStreamProgressState,
  terminalEventSeen: boolean,
): ProviderStreamProgressInfo {
  const observedAt = Date.now();
  const abortReason = scope.signal.aborted
    ? providerTransportErrorInfo(scope.signal.reason)?.message || sanitizeProviderDiagnostic(String(scope.signal.reason))
    : undefined;
  return {
    startedAt: new Date(scope.startedAt).toISOString(),
    observedAt: new Date(observedAt).toISOString(),
    elapsedMs: observedAt - scope.startedAt,
    headersMs: state.headersMs,
    firstEventMs: state.firstEventAt === undefined ? undefined : state.firstEventAt - scope.startedAt,
    firstEventAt: state.firstEventAt === undefined ? undefined : new Date(state.firstEventAt).toISOString(),
    lastEventMs: state.lastEventAt === undefined ? undefined : state.lastEventAt - scope.startedAt,
    lastEventAt: state.lastEventAt === undefined ? undefined : new Date(state.lastEventAt).toISOString(),
    eventCount: state.eventCount,
    bytesReceived: state.bytesReceived,
    lastEventType: sanitizeProviderDiagnostic(state.lastEventType)?.slice(0, 256),
    lastSequenceNumber: state.lastSequenceNumber,
    terminalEventSeen,
    localAbort: scope.signal.aborted,
    localAbortReason: abortReason,
    timeToFirstEventTimedOut: scope.timedOut(),
  };
}

function codexFailureDiagnostics(
  scope: CodexAttemptScope,
  state: CodexStreamProgressState,
  terminalEventSeen: boolean,
  response?: Response,
  transportError?: unknown,
): Partial<ModelProviderFailure> {
  return {
    transportError: providerTransportErrorInfo(transportError),
    providerTrace: response ? providerTraceInfo(response.headers) : undefined,
    streamProgress: codexStreamProgressInfo(scope, state, terminalEventSeen),
  };
}

function providerFailureReference(failure: Pick<ModelProviderFailure, "providerRequestId" | "responseId" | "clientRequestId">): string | undefined {
  return failure.providerRequestId || failure.responseId || failure.clientRequestId;
}

function buildProviderUserMessage(failure: Omit<ModelProviderFailure, "userMessage">): string {
  const providerName = failure.provider === "openai-subscription" ? "OpenAI Codex" : "OpenAI";
  const reference = providerFailureReference(failure);
  const referenceSuffix = reference ? ` Reference: ${reference}.` : "";
  const providerMessage = sanitizeProviderDiagnostic(failure.providerMessage);
  const reportedSuffix = providerMessage && providerMessage !== "response.failed"
    ? ` OpenAI reported: ${providerMessage}`
    : "";

  if (failure.kind === "rate_limited" || failure.status === 429) {
    return `${providerName} rate limit reached.${reportedSuffix || " Please wait and retry."}${referenceSuffix}`;
  }
  if (failure.providerCode === "authentication_error" || failure.status === 401) {
    return `${providerName} rejected the connection credentials.${reportedSuffix}${referenceSuffix}`;
  }
  if (failure.providerCode === "permission_error" || failure.status === 403) {
    return `${providerName} rejected this request for insufficient permission.${reportedSuffix}${referenceSuffix}`;
  }
  if (failure.providerCode === "context_length_exceeded") {
    return `${providerName} rejected the request because it exceeded the model context window.${reportedSuffix}${referenceSuffix}`;
  }
  if (failure.providerCode === "model_not_found") {
    return `${providerName} could not find the configured model.${reportedSuffix}${referenceSuffix}`;
  }
  if (failure.kind === "time_to_first_event") {
    return `${providerName} did not begin responding within ${Math.round(CODEX_TIME_TO_FIRST_EVENT_MS / 1000)} seconds.${referenceSuffix}`;
  }
  if (failure.kind === "stream_interrupted") {
    if (failure.streamProgress && !failure.streamProgress.localAbort) {
      const responseStarted = failure.streamProgress.eventCount > 0 ? " after OpenAI began responding" : "";
      return `The network connection to ${providerName} closed unexpectedly${responseStarted}. Mantra did not cancel the request. You can continue safely.${reportedSuffix}${referenceSuffix}`;
    }
    return `The ${providerName} stream ended before the response completed.${reportedSuffix}${referenceSuffix}`;
  }
  if (failure.kind === "transport") {
    return `Mantra could not reach ${providerName}.${reportedSuffix}${referenceSuffix}`;
  }
  if (failure.kind === "protocol_invalid") {
    return `${providerName} returned an invalid streaming response.${reportedSuffix}${referenceSuffix}`;
  }
  if (failure.kind === "http_retryable" || failure.kind === "http_permanent") {
    return `${providerName} returned HTTP ${failure.status}.${reportedSuffix}${referenceSuffix}`;
  }
  const codeSuffix = failure.providerCode ? ` (${failure.providerCode})` : "";
  return `${providerName} failed this request${codeSuffix}.${reportedSuffix || " Retry the request."}${referenceSuffix}`;
}

export class ModelProviderError extends Error {
  readonly code = "MODEL_PROVIDER_ERROR";
  readonly providerFailure: ModelProviderFailure;
  readonly kind: ModelProviderFailureKind;
  readonly retryable: boolean;
  readonly status: number;
  readonly attempts: number;
  readonly phase: ModelProviderFailurePhase;
  readonly bodySnippet?: string;
  readonly clientRequestId?: string;
  readonly providerRequestId?: string;

  constructor(providerFailure: ModelProviderFailure, bodySnippet?: string) {
    super(providerFailure.userMessage);
    this.name = "ModelProviderError";
    this.providerFailure = providerFailure;
    this.kind = providerFailure.kind;
    this.retryable = providerFailure.retryable;
    this.status = providerFailure.status;
    this.attempts = providerFailure.attempts;
    this.phase = providerFailure.phase;
    this.bodySnippet = sanitizeProviderDiagnostic(bodySnippet);
    this.clientRequestId = providerFailure.clientRequestId;
    this.providerRequestId = providerFailure.providerRequestId;
  }
}

class ModelProviderAttemptError extends Error {
  kind: ModelProviderFailureKind;
  retryable: boolean;
  status: number;
  bodySnippet: string;
  clientRequestId: string;
  providerRequestId?: string;
  phase: ModelProviderFailurePhase;
  diagnostics?: Partial<ModelProviderFailure>;

  constructor(params: {
    kind: ModelProviderFailureKind;
    retryable: boolean;
    message: string;
    status?: number;
    bodySnippet?: string;
    clientRequestId: string;
    providerRequestId?: string;
    phase: ModelProviderFailurePhase;
    diagnostics?: Partial<ModelProviderFailure>;
  }) {
    super(params.message);
    this.name = "ModelProviderAttemptError";
    this.kind = params.kind;
    this.retryable = params.retryable;
    this.status = params.status ?? 0;
    this.bodySnippet = sanitizeProviderDiagnostic(params.bodySnippet ?? params.message) || params.message;
    this.clientRequestId = params.clientRequestId;
    this.providerRequestId = params.providerRequestId;
    this.phase = params.phase;
    this.diagnostics = params.diagnostics;
  }
}

interface CodexAttemptScope {
  signal: AbortSignal;
  clientRequestId: string;
  startedAt: number;
  markFirstEvent(): void;
  timedOut(): boolean;
  cleanup(): void;
}

function createCodexAttemptScope(parentSignal?: AbortSignal): CodexAttemptScope {
  const controller = new AbortController();
  const clientRequestId = randomUUID();
  const startedAt = Date.now();
  let timeoutTriggered = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  deadline = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new Error(`Codex time to first event exceeded ${CODEX_TIME_TO_FIRST_EVENT_MS}ms`));
  }, CODEX_TIME_TO_FIRST_EVENT_MS);

  const clearDeadline = () => {
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
  };

  return {
    signal: controller.signal,
    clientRequestId,
    startedAt,
    markFirstEvent: clearDeadline,
    timedOut: () => timeoutTriggered,
    cleanup: () => {
      clearDeadline();
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

async function codexBackoffSleep(attempt: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new CodexAbortedError();
  const delayMs = CODEX_RETRY_DELAYS_MS[attempt - 1];
  const aborted = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), delayMs);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(true); }, { once: true });
  });
  if (aborted || signal?.aborted) throw new CodexAbortedError();
}

/**
 * Issue exactly one bounded POST to the Codex responses endpoint.
 * The caller owns retry policy so one logical attempt cannot multiply into
 * nested retries. The deadline remains active until the first provider event.
 */
async function fetchCodexAttempt(
  fetchOptions: RequestInit,
  scope: CodexAttemptScope,
  model: string,
  context: string,
  attempt: number,
  maxAttempts: number,
): Promise<Response> {
  const headers = new Headers(fetchOptions.headers);
  headers.set("X-Client-Request-Id", scope.clientRequestId);
  log.debug(
    `codex ${context} request attempt=${attempt + 1}/${maxAttempts} model=${model} ` +
    `clientRequestId=${scope.clientRequestId}`,
  );

  let response: Response;
  try {
    response = await fetch(OPENAI_SUBSCRIPTION_CODEX_RESPONSES_URL, {
      ...fetchOptions,
      headers,
      signal: scope.signal,
    });
  } catch (err: any) {
    if (scope.timedOut()) {
      throw new ModelProviderAttemptError({
        kind: "time_to_first_event",
        retryable: true,
        message: `time_to_first_event_timeout:${CODEX_TIME_TO_FIRST_EVENT_MS}ms`,
        bodySnippet: err?.message || "request timed out before response headers",
        clientRequestId: scope.clientRequestId,
        phase: "fetch",
        diagnostics: codexFailureDiagnostics(scope, { eventCount: 0, bytesReceived: 0 }, false, undefined, err),
      });
    }
    if (err.name === "AbortError" || err.code === "ERR_CANCELED" || scope.signal.aborted) throw err;
    throw new ModelProviderAttemptError({
      kind: "transport",
      retryable: true,
      message: err?.message || String(err),
      clientRequestId: scope.clientRequestId,
      phase: "fetch",
      diagnostics: codexFailureDiagnostics(scope, { eventCount: 0, bytesReceived: 0 }, false, undefined, err),
    });
  }

  const providerRequestId = response.headers.get("x-request-id") || undefined;
  log.debug(
    `codex ${context} response attempt=${attempt + 1}/${maxAttempts} model=${model} ` +
    `status=${response.status} headersMs=${Date.now() - scope.startedAt} ` +
    `clientRequestId=${scope.clientRequestId} providerRequestId=${providerRequestId ?? "none"}`,
  );

  return response;
}

function isRetryableCodexStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || (status >= 500 && status < 600);
}

function parseProviderErrorBody(body: string): {
  providerCode?: string;
  providerType?: string;
  providerMessage?: string;
  providerParam?: string | null;
} {
  const sanitizedBody = sanitizeProviderDiagnostic(body);
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string; type?: string; message?: string; param?: string | null };
      code?: string;
      type?: string;
      message?: string;
      param?: string | null;
    };
    const detail = parsed.error || parsed;
    return {
      providerCode: sanitizeProviderDiagnostic(detail.code),
      providerType: sanitizeProviderDiagnostic(detail.type),
      providerMessage: sanitizeProviderDiagnostic(detail.message) || sanitizedBody,
      providerParam: detail.param === null ? null : sanitizeProviderDiagnostic(detail.param),
    };
  } catch {
    // Unstructured bodies stay in the bounded internal bodySnippet. Only a
    // provider-declared message is safe and stable enough to show users.
    return {};
  }
}

function codexHttpAttemptError(response: Response, bodySnippet: string, scope: CodexAttemptScope): ModelProviderAttemptError {
  const retryable = isRetryableCodexStatus(response.status);
  const detail = parseProviderErrorBody(bodySnippet);
  return new ModelProviderAttemptError({
    kind: response.status === 429 ? "rate_limited" : retryable ? "http_retryable" : "http_permanent",
    retryable,
    message: detail.providerMessage || `HTTP ${response.status}`,
    status: response.status,
    bodySnippet,
    clientRequestId: scope.clientRequestId,
    providerRequestId: response.headers.get("x-request-id") || undefined,
    phase: "fetch",
    diagnostics: {
      ...codexFailureDiagnostics(
        scope,
        { headersMs: Date.now() - scope.startedAt, eventCount: 0, bytesReceived: 0 },
        false,
        response,
      ),
      ...detail,
      eventType: "http_response",
    },
  });
}

function responsesProviderFailure(
  chunk: CodexResponsesChunk,
  context: {
    clientRequestId: string;
    providerRequestId?: string;
    status?: number;
    diagnostics?: Partial<ModelProviderFailure>;
  },
): ModelProviderAttemptError {
  const topLevelError = chunk.type === "error"
    ? { code: chunk.code, message: chunk.message, type: "error" }
    : undefined;
  const detail = chunk.response?.error || chunk.error || topLevelError;
  const providerCode = detail?.code || chunk.code;
  const providerType = detail?.type || (chunk.type === "error" ? "error" : undefined);
  const providerMessage = sanitizeProviderDiagnostic(detail?.message || chunk.message || chunk.type) || chunk.type;
  const permanentCodes = new Set(["invalid_request_error", "authentication_error", "permission_error", "context_length_exceeded", "model_not_found"]);
  const usageData = chunk.usage || chunk.response?.usage;
  const providerParam = sanitizeProviderDiagnostic(chunk.param ?? undefined);

  return new ModelProviderAttemptError({
    kind: providerCode === "rate_limit_exceeded" ? "rate_limited" : "provider_failed",
    retryable: !providerCode || !permanentCodes.has(providerCode),
    status: context.status ?? 0,
    message: providerMessage,
    bodySnippet: providerCode ? `${providerCode}: ${providerMessage}` : providerMessage,
    clientRequestId: context.clientRequestId,
    providerRequestId: context.providerRequestId,
    phase: "protocol",
    diagnostics: {
      ...context.diagnostics,
      providerCode,
      providerType,
      providerMessage,
      providerParam: chunk.param === null ? null : providerParam,
      eventType: chunk.type,
      responseId: sanitizeProviderDiagnostic(chunk.response?.id),
      responseStatus: sanitizeProviderDiagnostic(chunk.response?.status),
      sequenceNumber: chunk.sequence_number,
      incompleteReason: sanitizeProviderDiagnostic(chunk.response?.incomplete_details?.reason),
      providerEventFields: Object.keys(chunk).sort(),
      providerResponseFields: chunk.response ? Object.keys(chunk.response).sort() : undefined,
      usage: usageData ? {
        inputTokens: usageData.input_tokens || 0,
        outputTokens: usageData.output_tokens || 0,
        totalTokens: usageData.total_tokens || 0,
        cacheReadTokens: usageData.input_tokens_details?.cached_tokens ?? 0,
        reasoningTokens: usageData.output_tokens_details?.reasoning_tokens ?? 0,
      } : undefined,
    },
  });
}

function openaiSdkAttemptError(err: unknown, clientRequestId: string): ModelProviderAttemptError {
  const sdkError = err as {
    status?: number;
    code?: string | null;
    type?: string;
    param?: string | null;
    requestID?: string | null;
    message?: string;
    error?: { message?: string; code?: string; type?: string; param?: string | null };
  };
  const status = typeof sdkError?.status === "number" ? sdkError.status : 0;
  const detail = sdkError?.error || sdkError;
  const providerMessage = sanitizeProviderDiagnostic(detail?.message || sdkError?.message);
  const providerCode = sanitizeProviderDiagnostic(detail?.code || sdkError?.code || undefined);
  const providerType = sanitizeProviderDiagnostic(detail?.type || sdkError?.type);
  const providerParam = detail?.param === null || sdkError?.param === null
    ? null
    : sanitizeProviderDiagnostic(detail?.param || sdkError?.param || undefined);
  const retryable = status > 0 ? isRetryableCodexStatus(status) : true;
  const bodySnippet = safeStringify(sdkError?.error || { message: sdkError?.message }, {
    maxBytes: MAX_PROVIDER_DIAGNOSTIC_CHARS,
    maxStrLen: MAX_PROVIDER_DIAGNOSTIC_CHARS,
    label: "model-client.openaiSdkError",
  });

  return new ModelProviderAttemptError({
    kind: status === 429 ? "rate_limited" : status > 0 ? (retryable ? "http_retryable" : "http_permanent") : "transport",
    retryable,
    status,
    message: providerMessage || (status > 0 ? `HTTP ${status}` : "OpenAI SDK transport error"),
    bodySnippet,
    clientRequestId,
    providerRequestId: sanitizeProviderDiagnostic(sdkError?.requestID || undefined),
    phase: status > 0 ? "fetch" : "stream",
    diagnostics: {
      providerCode,
      providerType,
      providerMessage,
      providerParam,
      eventType: "sdk_error",
    },
  });
}

function modelProviderErrorFromAttempt(
  err: ModelProviderAttemptError,
  attempts: number,
  context?: {
    provider?: ModelProviderFailure["provider"];
    model?: string;
    metadata?: InferenceMetadata;
  },
): ModelProviderError {
  const diagnostic = err.diagnostics || {};
  const base: Omit<ModelProviderFailure, "userMessage"> = {
    ...diagnostic,
    kind: err.kind,
    provider: context?.provider || "openai-subscription",
    model: context?.model,
    runId: context?.metadata?.runId,
    sessionId: context?.metadata?.sessionId,
    phase: err.phase,
    retryable: err.retryable,
    status: err.status,
    attempts,
    clientRequestId: err.clientRequestId,
    providerRequestId: err.providerRequestId,
  };
  const providerFailure: ModelProviderFailure = {
    ...base,
    userMessage: buildProviderUserMessage(base),
  };
  log.error(`model.provider_failure ${safeStringify({
    ...providerFailure,
    bodySnippet: sanitizeProviderDiagnostic(err.bodySnippet),
  }, {
    maxBytes: 16 * 1024,
    maxStrLen: MAX_PROVIDER_DIAGNOSTIC_CHARS,
    label: "model-client.providerFailure",
  })}`);
  return new ModelProviderError(providerFailure, err.bodySnippet);
}

async function openaiSubscriptionCompletion(model: string, options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const accessToken = await getOpenAISubscriptionAccessToken();
  const modelInfo = getModel(model);
  const codexModel = modelInfo?.codexModelId ?? model;
  const { instructions, input } = buildCodexInput(options.messages);
  const body: CodexResponsesRequest = { model: codexModel, instructions, input, store: false, stream: true };
  applyOpenAIConnectorConfig(body as unknown as Record<string, any>, resolvedOpenAIConfig(options), model, options, "codex");

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  };
  const parentSignal = options.signal as AbortSignal | undefined;
  let lastAttemptError: ModelProviderAttemptError | undefined;

  for (let attempt = 0; attempt < CODEX_COMPLETION_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      log.warn(
        `codex completion retry attempt=${attempt + 1}/${CODEX_COMPLETION_MAX_ATTEMPTS} model=${codexModel} ` +
        `reason=${lastAttemptError?.phase ?? "protocol"}:${lastAttemptError?.message ?? "response.failed"} ` +
        `delay=${CODEX_RETRY_DELAYS_MS[attempt - 1]}ms`,
      );
      await codexBackoffSleep(attempt, parentSignal);
    }

    const scope = createCodexAttemptScope(parentSignal);
    try {
      const response = await fetchCodexAttempt(fetchOptions, scope, codexModel, "completion", attempt, CODEX_COMPLETION_MAX_ATTEMPTS);
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "unknown error");
        throw codexHttpAttemptError(response, text, scope);
      }

      let content = "";
      let streamUsage: { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } | undefined;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let firstEventSeen = false;
      let protocolFailure: ModelProviderAttemptError | undefined;
      let terminalEventSeen = false;
      const progress: CodexStreamProgressState = {
        headersMs: Date.now() - scope.startedAt,
        eventCount: 0,
        bytesReceived: 0,
      };

      while (true) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (err: any) {
          if (parentSignal?.aborted) throw new CodexAbortedError();
          throw new ModelProviderAttemptError({
            kind: scope.timedOut() ? "time_to_first_event" : "stream_interrupted",
            retryable: true,
            message: scope.timedOut()
              ? `time_to_first_event_timeout:${CODEX_TIME_TO_FIRST_EVENT_MS}ms`
              : (err?.message || "response body read failed"),
            bodySnippet: err?.message || "response body stalled before first event",
            clientRequestId: scope.clientRequestId,
            providerRequestId: response.headers.get("x-request-id") || undefined,
            phase: firstEventSeen ? "stream" : "first_event",
            diagnostics: codexFailureDiagnostics(scope, progress, terminalEventSeen, response, err),
          });
        }
        if (read.done) {
          if (!firstEventSeen) {
            throw new ModelProviderAttemptError({
              kind: "stream_interrupted",
              retryable: true,
              message: "eof_before_first_event",
              clientRequestId: scope.clientRequestId,
              providerRequestId: response.headers.get("x-request-id") || undefined,
              phase: "first_event",
              diagnostics: codexFailureDiagnostics(scope, progress, terminalEventSeen, response),
            });
          }
          break;
        }
        progress.bytesReceived += read.value.byteLength;
        buffer += decoder.decode(read.value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") break;
          let chunk: CodexResponsesChunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            throw new ModelProviderAttemptError({
              kind: "protocol_invalid",
              retryable: true,
              message: "malformed_sse_json",
              bodySnippet: data.slice(0, 200),
              clientRequestId: scope.clientRequestId,
              providerRequestId: response.headers.get("x-request-id") || undefined,
              phase: "protocol",
              diagnostics: codexFailureDiagnostics(scope, progress, terminalEventSeen, response),
            });
          }

          observeCodexProviderEvent(progress, chunk);
          if (!firstEventSeen) {
            firstEventSeen = true;
            scope.markFirstEvent();
            log.debug(
              `codex completion first event attempt=${attempt + 1}/${CODEX_COMPLETION_MAX_ATTEMPTS} ` +
              `model=${codexModel} firstEventMs=${Date.now() - scope.startedAt} ` +
              `clientRequestId=${scope.clientRequestId} providerRequestId=${response.headers.get("x-request-id") || "none"}`,
            );
          }

          const usageData = chunk.usage || chunk.response?.usage;
          if (usageData) {
            streamUsage = {
              input_tokens: usageData.input_tokens || 0,
              output_tokens: usageData.output_tokens || 0,
              total_tokens: usageData.total_tokens || 0,
              input_tokens_details: usageData.input_tokens_details,
              output_tokens_details: usageData.output_tokens_details,
            };
          }
          if (chunk.type === "response.output_text.delta" && typeof chunk.delta === "string") content += chunk.delta;
          else if (chunk.type === "response.failed" || chunk.type === "error") protocolFailure = responsesProviderFailure(chunk, {
            clientRequestId: scope.clientRequestId,
            providerRequestId: response.headers.get("x-request-id") || undefined,
            status: response.status,
            diagnostics: codexFailureDiagnostics(scope, progress, terminalEventSeen, response),
          });
          else if (chunk.type === "response.completed" || chunk.type === "response.incomplete") terminalEventSeen = true;
        }
        if (protocolFailure) break;
      }

      if (protocolFailure) throw protocolFailure;
      if (!terminalEventSeen) {
        throw new ModelProviderAttemptError({
          kind: "stream_interrupted",
          retryable: true,
          message: firstEventSeen ? "eof_before_terminal_event" : "eof_before_first_event",
          clientRequestId: scope.clientRequestId,
          providerRequestId: response.headers.get("x-request-id") || undefined,
          phase: firstEventSeen ? "stream" : "first_event",
          diagnostics: codexFailureDiagnostics(scope, progress, terminalEventSeen, response),
        });
      }
      if (!content) log.warn(`openai-subscription completion: empty content for model=${codexModel}`);

      return {
        content,
        model,
        provider: "openai-subscription",
        usage: streamUsage ? {
          promptTokens: streamUsage.input_tokens,
          completionTokens: streamUsage.output_tokens,
          totalTokens: streamUsage.total_tokens,
          cacheReadTokens: streamUsage.input_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: streamUsage.output_tokens_details?.reasoning_tokens ?? 0,
          visibleOutputTokens: streamUsage.output_tokens - (streamUsage.output_tokens_details?.reasoning_tokens ?? 0),
        } : undefined,
      };
    } catch (err: any) {
      if (parentSignal?.aborted || (isAbortError(err, scope.signal) && !scope.timedOut())) throw new CodexAbortedError();
      if (!(err instanceof ModelProviderAttemptError)) throw err;
      lastAttemptError = err;
      log.warn(
        `codex completion attempt failed attempt=${attempt + 1}/${CODEX_COMPLETION_MAX_ATTEMPTS} model=${codexModel} ` +
        `phase=${err.phase} status=${err.status || 0} elapsedMs=${Date.now() - scope.startedAt} ` +
        `clientRequestId=${err.clientRequestId} providerRequestId=${err.providerRequestId ?? "none"} error=${err.message}`,
      );
      if (!err.retryable || attempt === CODEX_COMPLETION_MAX_ATTEMPTS - 1) {
        throw modelProviderErrorFromAttempt(err, attempt + 1, { model: codexModel, metadata: options.metadata });
      }
    } finally {
      scope.cleanup();
    }
  }

  if (lastAttemptError) {
    throw modelProviderErrorFromAttempt(lastAttemptError, CODEX_COMPLETION_MAX_ATTEMPTS, { model: codexModel, metadata: options.metadata });
  }
  throw new Error("Codex completion exhausted retries without an attempt error");
}

async function claudeCliCompletion(model: string, options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const { cliSdkCompletion } = await import("./cli-sdk-adapter");
  return cliSdkCompletion(model, options);
}

async function anthropicCompletion(model: string, options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const client = getAnthropicClient(options.routingDecision?.credential);

  let systemPrompt: string | undefined;
  const messages: Array<{ role: "user" | "assistant"; content: string | Array<any> }> = [];

  for (const msg of options.messages) {
    if (msg.role === "system") {
      systemPrompt = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    } else if (Array.isArray(msg.content)) {
      const anthropicBlocks = msg.content.map((block: any) => {
        if (block.type === "image_url" && block.image_url?.url) {
          const url: string = block.image_url.url;
          if (url.startsWith("data:")) {
            const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
            if (match) {
              return {
                type: "image" as const,
                source: { type: "base64" as const, media_type: match[1], data: match[2] },
              };
            }
          }
          return { type: "text" as const, text: `[Image URL: ${url}]` };
        }
        if (block.type === "text") {
          return { type: "text" as const, text: block.text };
        }
        return block;
      });
      messages.push({ role: msg.role as "user" | "assistant", content: anthropicBlocks });
    } else {
      messages.push({
        role: msg.role as "user" | "assistant",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "." });
  }

  if (messages.length > 0 && messages[messages.length - 1].role === "assistant" && typeof messages[messages.length - 1].content === "string") {
    log.debug(`anthropicCompletion: trailing assistant text message detected — stripping to avoid prefill error. model=${model} messageCount=${messages.length}`);
    messages.pop();
    if (messages.length === 0) {
      messages.push({ role: "user", content: "." });
    }
  }

  const maxOutputTokens = getMaxOutputTokens(model);
  const clampedMaxTokens = Math.min(options.maxTokens || 16384, maxOutputTokens);
  if (options.maxTokens && clampedMaxTokens < options.maxTokens) {
    log.debug(`anthropicCompletion clamping maxTokens from ${options.maxTokens} to ${clampedMaxTokens} for model=${model}`);
  }

  const params: any = {
    model,
    messages,
    max_tokens: clampedMaxTokens,
  };

  if (systemPrompt) params.system = systemPrompt;
  if (options.temperature !== undefined) params.temperature = options.temperature;

  const anthropicRequestOptions: Record<string, any> = {};
  if (options.signal) anthropicRequestOptions.signal = options.signal;

  const response = await client.messages.create(params, anthropicRequestOptions);

  let content = "";
  for (const block of response.content) {
    if (block.type === "text") {
      content += block.text;
    }
  }

  if (options.jsonMode) {
    const { safeParseJSON } = await import("./utils/json-parse");
    const parsed = safeParseJSON(content, "anthropicCompletion");
    if (parsed.ok) {
      content = JSON.stringify(parsed.data);
    } else {
      log.warn(`Anthropic jsonMode extraction failed: ${parsed.error} — raw: ${content.slice(0, 200)}`);
      throw new Error(`Anthropic JSON mode failed: ${parsed.error}. Model returned non-JSON: "${content.slice(0, 100)}"`);
    }
  }

  return {
    content,
    model,
    provider: "anthropic",
    usage: response.usage ? {
      promptTokens: response.usage.input_tokens,
      completionTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens
        + (response.usage.cache_read_input_tokens ?? 0)
        + (response.usage.cache_creation_input_tokens ?? 0),
    } : undefined,
  };
}

export async function getModelInfo(activity: ActivityId = ACTIVITY_FRAMING): Promise<{ provider: string; model: string; full: string }> {
  const full = (await resolveModelCandidates(activity))[0].modelString;
  const { provider, model } = parseModelString(full);
  log.debug(`getModelInfo activity=${activity} provider=${provider} model=${model}`);
  return { provider, model, full };
}

export type { ToolDefinition } from "@shared/models/tools";

export interface StreamMessage {
  role: "system" | "user" | "assistant" | "tool" | "tool_result";
  content: string | Array<{ type: string; [key: string]: any }>;
  toolCallId?: string;
  name?: string;
}

export interface ChatCompletionStreamOptions {
  activity?: ActivityId;
  model?: string;
  /** Diagnostic/system-only semantic tier override. Normal routing derives the tier from the active persona. */
  semanticTierOverride?: import("@shared/model-connectors").SemanticTier;
  /**
   * Pre-resolved routing decision. Use this when a caller has already routed by
   * activity/tier and is merely handing the resolved model to the provider
   * boundary. Passing `model` alone means a true explicit model override.
   */
  routingDecision?: ModelRoutingDecision;
  overrideReason?: string;
  metadata?: InferenceMetadata;
  messages: StreamMessage[];
  tools?: ToolDefinition[];
  toolExecutor?: (name: string, args: Record<string, unknown>) => Promise<{ result: string; error?: boolean; sideEffectOnly?: boolean; continuation?: import("./agent-executor").ToolContinuation }>;
  maxTokens?: number;
  temperature?: number;
  /** @deprecated Pass `thinking` instead. Kept for back-compat with existing callers. */
  thinkingBudget?: number;
  thinking?: import("./thinking-config").ResolvedThinking;
  /** Dedicated one-shot Claude CLI lane. Only named latency-critical calls may opt in. */
  warmPoolLane?: "orientation";
  routingTier?: string;
  signal?: AbortSignal;
  // Optional callback the adapter uses to hand the executor any background promises
  // it spawned during cleanup (e.g. force-abort iterator.return chains, interrupt acks).
  // The executor awaits these in its post-abort drain window before releasing the
  // admission slot, which is what stops abort from leaking work into the next run.
  registerBackgroundWork?: (p: Promise<void>) => void;
  // Optional observability correlators (Task #1045). Plumbed through to the
  // CLI adapter so the structured `cli_subprocess_crash` log line can be
  // correlated back to a specific run/conversation in Railway logs. Both are
  // nullable everywhere and never required by any provider path.
  runId?: string;
  convId?: string;
  /** Voice session ID for claiming pre-warmed CLI handles. */
  voiceSessionId?: string;
}

export interface TtftBreakdown {
  provider: string;
  model: string;
  routingTier?: string;
  activity?: string;
  thinkingSent: string;
  maxTokens?: number;
  msToFirstSdkEvent: number | null;
  msToFirstTextDelta: number | null;
  msToFirstThinkingDelta: number | null;
  poolKey?: string;
  poolHit?: boolean;
  poolEligible?: boolean;
}

export type StreamEvent =
  | { type: "thinking_delta"; content: string }
  | { type: "text_delta"; content: string }
  | { type: "tool_use_start"; toolCallId: string; toolName: string }
  | { type: "tool_use_update"; toolCallId: string; narrative: string }
  | { type: "tool_use"; toolCallId: string; toolName: string; arguments: Record<string, any> }
  | { type: "tool_call_resolved"; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: "tool_result_resolved"; toolCallId: string; toolName: string; arguments?: Record<string, unknown>; order?: number; result: string; error?: boolean; continuation?: import("./agent-executor").ToolContinuation }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; visibleOutputTokens?: number }; model?: string; stopReason: string; metadata?: Record<string, unknown> }
  | { type: "error"; error: string; providerFailure?: ModelProviderFailure }
  | { type: "keepalive"; reason: string }
  | { type: "ttft_breakdown"; breakdown: TtftBreakdown }
  | { type: "connected"; metadata?: Record<string, unknown> }
  | { type: "request_sent"; metadata?: Record<string, unknown> }
  | { type: "headers_received"; metadata?: Record<string, unknown> };

export async function* chatCompletionStream(options: ChatCompletionStreamOptions): AsyncGenerator<StreamEvent> {
  const activity = options.activity || options.metadata?.activity || ACTIVITY_CHAT;
  const sessionTierOverride = !options.model && !options.routingDecision && !options.semanticTierOverride
    ? await resolveSessionModelTierOverride(options.metadata)
    : null;
  const candidates = options.routingDecision
    ? [options.routingDecision, ...(options.routingDecision.fallbackCandidates || [])]
    : await resolveModelCandidates(activity, {
        model: options.model,
        overrideReason: options.overrideReason || (sessionTierOverride ? "session model tier override" : undefined),
        semanticTierOverride: options.semanticTierOverride || sessionTierOverride || undefined,
        sessionId: options.metadata?.sessionId,
      });
  let failures = candidates[0]?.attempts ?? [];
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index++) {
    const routing = { ...candidates[index], attempts: failures.length ? failures : candidates[index].attempts };
    let emittedContent = false;
    try {
      for await (const event of executeChatCompletionStream({ ...options, routingDecision: routing }, routing)) {
        if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_use" || event.type === "tool_use_start") emittedContent = true;
        yield event;
      }
      return;
    } catch (error) {
      lastError = error;
      if (isAbortError(error, options.signal) || emittedContent) throw error;
      failures = appendFailedAttempt(routing, error);
      const next = candidates[index + 1];
      if (next) log.warn(`model stream connector fallback connector=${routing.connectorId} tier=${routing.tier} model=${routing.model} nextConnector=${next.connectorId} nextModel=${next.model} failure=${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw lastError;
}

async function* executeChatCompletionStream(options: ChatCompletionStreamOptions, routing: ModelRoutingDecision): AsyncGenerator<StreamEvent> {
  const activity = options.activity || options.metadata?.activity || ACTIVITY_CHAT;
  const { provider, model } = routing;
  const toolCount = options.tools?.length ?? 0;
  const msgCount = options.messages.length;

  // Resolve thinking config: prefer explicit `thinking`, fall back to legacy `thinkingBudget`.
  const { resolveThinkingConfig, thinkingBudgetToTier, describeResolvedThinking } =
    await import("./thinking-config");
  const resolvedThinking = options.thinking
    ?? resolveThinkingConfig(model, thinkingBudgetToTier(options.thinkingBudget));
  const optionsWithResolved: ChatCompletionStreamOptions = { ...options, thinking: resolvedThinking };
  const thinkingDesc = describeResolvedThinking(resolvedThinking);

  if (!options.metadata) log.warn(`chatCompletionStream missing metadata provider=${provider} model=${model} activity=${activity}`);
  log.debug(
    `stream start provider=${provider} model=${model} messages=${msgCount} tools=${toolCount} ` +
    `maxTokens=${options.maxTokens ?? "default"} thinking=${thinkingDesc} ` +
    `tier=${options.routingTier ?? routing.tier} activity=${routing.activity} configHash=${routing.configHash}`,
  );

  const t0 = Date.now();
  const requestContent = buildRequestContent(options.messages);
  let responseContent = "";
  let streamUsage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; visibleOutputTokens?: number } | undefined;
  let firstSdkEventAt: number | null = null;
  let firstTextAt: number | null = null;
  let firstThinkingAt: number | null = null;
  let breakdownEmitted = false;
  let connectedMetadata: Record<string, unknown> | undefined;

  const inner: AsyncGenerator<StreamEvent> = (() => {
    if (provider === "anthropic") return anthropicStream(model, optionsWithResolved);
    if (provider === "claude-cli") {
      // Lazy import; CLI adapter is large.
      return (async function* () {
        const { cliSdkStream } = await import("./cli-sdk-adapter");
        yield* cliSdkStream(model, optionsWithResolved);
      })();
    }
    if (provider === "openai-subscription") return openaiSubscriptionStream(model, optionsWithResolved);
    return openaiStream(model, optionsWithResolved);
  })();

  const emitBreakdown = (): StreamEvent => {
    breakdownEmitted = true;
    const breakdown: TtftBreakdown = {
      provider,
      model,
      routingTier: options.routingTier,
      activity: options.activity,
      thinkingSent: thinkingDesc,
      maxTokens: options.maxTokens,
      msToFirstSdkEvent: firstSdkEventAt !== null ? firstSdkEventAt - t0 : null,
      msToFirstTextDelta: firstTextAt !== null ? firstTextAt - t0 : null,
      msToFirstThinkingDelta: firstThinkingAt !== null ? firstThinkingAt - t0 : null,
      poolKey: connectedMetadata?.poolKey as string | undefined,
      poolHit: connectedMetadata?.poolHit as boolean | undefined,
      poolEligible: connectedMetadata?.poolEligible as boolean | undefined,
    };
    log.debug(
      `stream ttft provider=${provider} model=${model} tier=${breakdown.routingTier ?? "?"} ` +
      `activity=${breakdown.activity ?? "?"} thinking=${breakdown.thinkingSent} maxTokens=${breakdown.maxTokens ?? "?"} ` +
      `firstSdkEvent=${breakdown.msToFirstSdkEvent ?? "n/a"}ms firstText=${breakdown.msToFirstTextDelta ?? "n/a"}ms ` +
      `firstThinking=${breakdown.msToFirstThinkingDelta ?? "n/a"}ms ` +
      `poolEligible=${breakdown.poolEligible ?? "?"} poolHit=${breakdown.poolHit ?? "?"} poolKey=${breakdown.poolKey ?? "?"}`,
    );
    return { type: "ttft_breakdown", breakdown };
  };

  try {
  for await (const event of inner) {
    if (firstSdkEventAt === null && event.type !== "keepalive") {
      firstSdkEventAt = Date.now();
    }
    if (event.type === "connected") {
      if (event.metadata) connectedMetadata = event.metadata;
    } else if (event.type === "text_delta") {
      if (firstTextAt === null) firstTextAt = Date.now();
      responseContent += event.content;
    } else if (event.type === "usage") {
      streamUsage = event.usage;
    } else if (event.type === "error") {
      if (event.providerFailure?.usage) {
        streamUsage = {
          inputTokens: event.providerFailure.usage.inputTokens,
          outputTokens: event.providerFailure.usage.outputTokens,
          totalTokens: event.providerFailure.usage.totalTokens,
          cacheReadTokens: event.providerFailure.usage.cacheReadTokens,
          reasoningTokens: event.providerFailure.usage.reasoningTokens,
        };
      }
      throw event.providerFailure
        ? new ModelProviderError(event.providerFailure)
        : new Error(event.error);
    } else if (event.type === "thinking_delta") {
      if (firstThinkingAt === null) firstThinkingAt = Date.now();
    }

    if (event.type === "usage") {
      yield {
        ...event,
        metadata: {
          ...(event.metadata || {}),
          routing: auditRouting(routing),
          routingSource: routing.source,
          tier: routing.tier,
          trackedAtBoundary: true,
        },
      };
    } else {
      yield event;
    }

    // Emit breakdown once we've seen first text delta — by then both
    // firstSdkEvent and (if any) firstThinkingDelta are also captured, so the
    // breakdown carries all three timings and lets us measure thinking overhead.
    if (!breakdownEmitted && firstTextAt !== null) {
      yield emitBreakdown();
    }
  }

  // Stream ended without text (e.g. tool-only or thinking-only turn). Emit
  // whatever timings we did capture so callers always get one breakdown.
  if (!breakdownEmitted) {
    yield emitBreakdown();
  }
  await recordInference({
    startTime: t0,
    routing,
    metadata: options.metadata,
    status: "success",
    usage: streamUsage,
    requestContent,
    responseContent,
    latency: {
      providerTtftMs: firstTextAt !== null ? firstTextAt - t0 : null,
      firstSdkEventMs: firstSdkEventAt !== null ? firstSdkEventAt - t0 : null,
      firstThinkingMs: firstThinkingAt !== null ? firstThinkingAt - t0 : null,
    },
    signal: options.signal,
  });
  } catch (err: unknown) {
    const status: InferenceStatus = isAbortError(err, options.signal) ? "aborted" : (responseContent ? "partial" : "error");
    routing.attempts = appendFailedAttempt(routing, err);
    await recordInference({
      startTime: t0,
      routing,
      metadata: options.metadata,
      status,
      usage: streamUsage,
      requestContent,
      responseContent,
      error: serializeModelError(err),
      latency: {
        providerTtftMs: firstTextAt !== null ? firstTextAt - t0 : null,
        firstSdkEventMs: firstSdkEventAt !== null ? firstSdkEventAt - t0 : null,
        firstThinkingMs: firstThinkingAt !== null ? firstThinkingAt - t0 : null,
      },
      signal: options.signal,
    });
    throw enrichModelError(err, routing, options.metadata);
  }
}

function convertToolsToAnthropic(tools: ToolDefinition[]): Array<{ name: string; description: string; input_schema: Record<string, any> }> {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function convertToolsToOpenAI(tools: ToolDefinition[]): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, any> } }> {
  return tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

function convertToolsToCodexResponses(tools: ToolDefinition[]): Array<{ type: "function"; name: string; description: string; parameters: Record<string, any> }> {
  return tools.map(t => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

async function* openaiSubscriptionStream(model: string, options: ChatCompletionStreamOptions): AsyncGenerator<StreamEvent> {
  const start = Date.now();
  let eventCount = 0;
  // Set true once ANY event has been yielded to the consumer. Past this
  // point we cannot safely restart the request — mid-stream failures must
  // surface as `error` events.
  let yieldedRealEvent = false;

  try {
    const authStart = Date.now();
    const accessToken = await getOpenAISubscriptionAccessToken();
    const authMs = Date.now() - authStart;

    const modelInfo = getModel(model);
    const codexModel = modelInfo?.codexModelId ?? model;

    const { instructions, input } = buildCodexInput(options.messages);
    const body: CodexResponsesRequest = {
      model: codexModel,
      instructions,
      input,
      store: false,
      stream: true,
    };
    applyOpenAIConnectorConfig(body as unknown as Record<string, any>, resolvedOpenAIConfig(options), model, options, "codex");
    if (!body.reasoning) body.reasoning = { summary: "auto" };

    if (options.tools && options.tools.length > 0) {
      body.tools = convertToolsToCodexResponses(options.tools);
    }

    const fetchOptions: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    };
    if (options.signal) fetchOptions.signal = options.signal as AbortSignal;
    const signal = options.signal as AbortSignal | undefined;

    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";
    let streamUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const pendingToolCalls = new Map<string, { callId: string; name: string; argsAccumulator: string; reasoningEmitted: boolean }>();
    let lastEarlyReason = "";

    // This loop is the sole retry owner. Retries are allowed only before any
    // downstream event, keeping replay safe for tools and visible content.
    // HTTP dispatch boundary: auth + request build complete — everything before
    // this is local overhead, everything after is network/provider time.
    yield { type: "request_sent", metadata: { authMs, buildMs: Date.now() - authStart - authMs } };
    let headersEmitted = false;

    streamRetryLoop: for (let attempt = 0; attempt < CODEX_STREAM_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        log.warn(
          `codex stream retry attempt=${attempt + 1}/${CODEX_STREAM_MAX_ATTEMPTS} model=${codexModel} ` +
          `reason=${lastEarlyReason || "early-failure"} delay=${CODEX_RETRY_DELAYS_MS[attempt - 1]}ms`,
        );
        try {
          await codexBackoffSleep(attempt, signal);
        } catch {
          log.debug(`openai-subscription stream aborted during early-failure backoff model=${model}`);
          throw new CodexAbortedError();
        }
      }

      const scope = createCodexAttemptScope(signal);
      try {
      let response: Response;
      try {
        response = await fetchCodexAttempt(fetchOptions, scope, codexModel, "stream", attempt, CODEX_STREAM_MAX_ATTEMPTS);
        if (!response.ok || !response.body) {
          const text = await response.text().catch(() => "unknown error");
          throw codexHttpAttemptError(response, text, scope);
        }
      } catch (err: any) {
        if (signal?.aborted || (isAbortError(err, scope.signal) && !scope.timedOut())) {
          throw new CodexAbortedError();
        }
        if (!(err instanceof ModelProviderAttemptError)) throw err;
        lastEarlyReason = `${err.kind}:${err.message}`;
        log.warn(
          `codex stream attempt failed attempt=${attempt + 1}/${CODEX_STREAM_MAX_ATTEMPTS} model=${codexModel} ` +
          `kind=${err.kind} retryable=${err.retryable} phase=${err.phase} status=${err.status || 0} ` +
          `elapsedMs=${Date.now() - scope.startedAt} clientRequestId=${err.clientRequestId} ` +
          `providerRequestId=${err.providerRequestId ?? "none"} error=${err.message}`,
        );
        if (err.retryable && attempt < CODEX_STREAM_MAX_ATTEMPTS - 1) continue streamRetryLoop;
        const providerError = modelProviderErrorFromAttempt(err, attempt + 1, { model: codexModel, metadata: options.metadata });
        yield { type: "error", error: providerError.message, providerFailure: providerError.providerFailure };
        return;
      }

      if (!headersEmitted) {
        headersEmitted = true;
        // Response headers landed — TTFB boundary. `connected` fires on the first SSE event.
        yield { type: "headers_received", metadata: { headersMs: Date.now() - scope.startedAt, status: response.status, attempt: attempt + 1 } };
      }

      // Reset per-attempt parser state so a retry starts clean (no leftover
      // tool-call fragments from a failed attempt).
      stopReason = "end_turn";
      streamUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      pendingToolCalls.clear();
      const seenSequenceNumbers = new Set<number>();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let attemptFailure: ModelProviderAttemptError | undefined;
      let firstProviderEventSeen = false;
      let terminalEventSeen = false;
      const progress: CodexStreamProgressState = {
        headersMs: Date.now() - scope.startedAt,
        eventCount: 0,
        bytesReceived: 0,
      };

      sseLoop: while (true) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (err: any) {
          if (signal?.aborted && !scope.timedOut()) throw new CodexAbortedError();
          attemptFailure = new ModelProviderAttemptError({
            kind: scope.timedOut() ? "time_to_first_event" : "stream_interrupted",
            retryable: !yieldedRealEvent,
            message: scope.timedOut()
              ? `time_to_first_event_timeout:${CODEX_TIME_TO_FIRST_EVENT_MS}ms`
              : (err?.message || "response body read failed"),
            bodySnippet: err?.message,
            clientRequestId: scope.clientRequestId,
            providerRequestId: response.headers.get("x-request-id") || undefined,
            phase: firstProviderEventSeen ? "stream" : "first_event",
            diagnostics: codexFailureDiagnostics(scope, progress, terminalEventSeen, response, err),
          });
          break;
        }
        const { done, value } = read;
        if (done) {
          if (!terminalEventSeen) {
            attemptFailure = new ModelProviderAttemptError({
              kind: "stream_interrupted",
              retryable: !yieldedRealEvent,
              message: firstProviderEventSeen ? "eof_before_terminal_event" : "eof_before_first_event",
              clientRequestId: scope.clientRequestId,
              providerRequestId: response.headers.get("x-request-id") || undefined,
              phase: firstProviderEventSeen ? "stream" : "first_event",
              diagnostics: codexFailureDiagnostics(scope, progress, terminalEventSeen, response),
            });
          }
          break;
        }
        progress.bytesReceived += value.byteLength;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") break;

          let chunk: CodexResponsesChunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            attemptFailure = new ModelProviderAttemptError({
              kind: "protocol_invalid",
              retryable: !yieldedRealEvent,
              message: "malformed_sse_json",
              bodySnippet: data.slice(0, 200),
              clientRequestId: scope.clientRequestId,
              providerRequestId: response.headers.get("x-request-id") || undefined,
              phase: "protocol",
              diagnostics: codexFailureDiagnostics(scope, progress, terminalEventSeen, response),
            });
            break sseLoop;
          }

          observeCodexProviderEvent(progress, chunk);
          scope.markFirstEvent();
          if (!firstProviderEventSeen) {
            firstProviderEventSeen = true;
            log.debug(
              `codex stream first event attempt=${attempt + 1}/${CODEX_STREAM_MAX_ATTEMPTS} model=${codexModel} ` +
              `firstEventMs=${Date.now() - scope.startedAt} clientRequestId=${scope.clientRequestId} ` +
              `providerRequestId=${response.headers.get("x-request-id") || "none"}`,
            );
          }

          if (typeof chunk.sequence_number === "number") {
            if (seenSequenceNumbers.has(chunk.sequence_number)) {
              log.warn(`openai-subscription duplicate stream event ignored model=${model} sequence=${chunk.sequence_number} type=${chunk.type}`);
              continue;
            }
            seenSequenceNumbers.add(chunk.sequence_number);
          }
          eventCount++;

          const usageData = chunk.usage || chunk.response?.usage;
          if (usageData) {
            streamUsage = {
              inputTokens: usageData.input_tokens || 0,
              outputTokens: usageData.output_tokens || 0,
              totalTokens: usageData.total_tokens || 0,
              cacheReadTokens: usageData.input_tokens_details?.cached_tokens ?? 0,
              reasoningTokens: usageData.output_tokens_details?.reasoning_tokens ?? 0,
              visibleOutputTokens: (usageData.output_tokens || 0) - (usageData.output_tokens_details?.reasoning_tokens ?? 0),
            };
          }

          // Both terminal failure shapes are documented provider events. Parse
          // them at the model boundary before yielding downstream content so a
          // replay-safe retry remains possible and diagnostics stay structured.
          if (chunk.type === "response.failed" || chunk.type === "error") {
            attemptFailure = responsesProviderFailure(chunk, {
            clientRequestId: scope.clientRequestId,
            providerRequestId: response.headers.get("x-request-id") || undefined,
            status: response.status,
            diagnostics: codexFailureDiagnostics(scope, progress, terminalEventSeen, response),
          });
            attemptFailure.retryable = attemptFailure.retryable && !yieldedRealEvent;
            break sseLoop;
          }

          if (chunk.type === "response.reasoning_summary_text.delta" && typeof chunk.delta === "string") {
            if (!yieldedRealEvent) { yieldedRealEvent = true; yield { type: "connected" }; }
            yield { type: "thinking_delta", content: chunk.delta };
          } else if (chunk.type === "response.output_text.delta" && typeof chunk.delta === "string") {
            if (!yieldedRealEvent) { yieldedRealEvent = true; yield { type: "connected" }; }
            yield { type: "text_delta", content: chunk.delta };
          } else if (chunk.type === "response.output_item.added" && chunk.item?.type === "function_call") {
            // A new function call item started.
            // item.id is the item's unique identifier (used by subsequent delta/done events via item_id).
            // item.call_id is the external tool call ID (used by tool result messages).
            const itemId = chunk.item.id || `item-${chunk.output_index ?? eventCount}`;
            const callId = chunk.item.call_id || itemId;
            const name = chunk.item.name || "";
            // Key the map by item.id so delta/done event lookup by item_id works correctly
            pendingToolCalls.set(itemId, { callId, name, argsAccumulator: "", reasoningEmitted: false });
            if (!yieldedRealEvent) { yieldedRealEvent = true; yield { type: "connected" }; }
            yield { type: "tool_use_start", toolCallId: callId, toolName: name };
            stopReason = "tool_use";
          } else if (chunk.type === "response.function_call_arguments.delta") {
            const itemId = chunk.item_id;
            const argsDelta = typeof chunk.delta === "string" ? chunk.delta : (chunk.delta as any)?.arguments || "";
            if (itemId) {
              const tc = pendingToolCalls.get(itemId);
              if (tc) {
                tc.argsAccumulator += argsDelta;
                // Early extraction: pull reasoning from partial JSON so UI shows it before tool completes
                if (!tc.reasoningEmitted) {
                  const match = tc.argsAccumulator.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"/);
                  if (match) {
                    tc.reasoningEmitted = true;
                    const reasoning = match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
                    if (!yieldedRealEvent) { yieldedRealEvent = true; yield { type: "connected" }; }
                    yield { type: "tool_use_update", toolCallId: tc.callId, narrative: reasoning };
                  }
                }
              }
            }
          } else if (chunk.type === "response.function_call_arguments.done") {
            // Function call arguments complete — emit tool_use event using item_id lookup
            const itemId = chunk.item_id;
            if (itemId) {
              const tc = pendingToolCalls.get(itemId);
              if (tc) {
                let input: Record<string, unknown> = {};
                try { input = JSON.parse(tc.argsAccumulator || "{}"); } catch { /* ignore */ }
                if (!yieldedRealEvent) { yieldedRealEvent = true; yield { type: "connected" }; }
                yield { type: "tool_use", toolCallId: tc.callId, toolName: tc.name, arguments: input };
                pendingToolCalls.delete(itemId);
              }
            }
          } else if (chunk.type === "response.completed") {
            terminalEventSeen = true;
            stopReason = pendingToolCalls.size > 0 ? "tool_use" : "end_turn";
          } else if (chunk.type === "response.incomplete") {
            terminalEventSeen = true;
            stopReason = "max_tokens";
          }
        }
      }

      if (attemptFailure) {
        lastEarlyReason = `${attemptFailure.kind}:${attemptFailure.message}`;
        await reader.cancel(lastEarlyReason).catch(() => undefined);
        log.warn(
          `codex stream attempt failed attempt=${attempt + 1}/${CODEX_STREAM_MAX_ATTEMPTS} model=${codexModel} ` +
          `kind=${attemptFailure.kind} retryable=${attemptFailure.retryable} phase=${attemptFailure.phase} ` +
          `status=${attemptFailure.status || 0} elapsedMs=${Date.now() - scope.startedAt} ` +
          `clientRequestId=${attemptFailure.clientRequestId} providerRequestId=${attemptFailure.providerRequestId ?? "none"} ` +
          `error=${attemptFailure.message}`,
        );
        if (attemptFailure.retryable && attempt < CODEX_STREAM_MAX_ATTEMPTS - 1) continue streamRetryLoop;
        const providerError = modelProviderErrorFromAttempt(attemptFailure, attempt + 1, { model: codexModel, metadata: options.metadata });
        yield { type: "error", error: providerError.message, providerFailure: providerError.providerFailure };
        return;
      }

      scope.cleanup();
      // Successful end-of-stream — exit retry loop.
      break;
      } finally {
        scope.cleanup();
      }
    }

    // Emit any remaining tool calls that didn't receive a done event
    for (const tc of pendingToolCalls.values()) {
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(tc.argsAccumulator || "{}"); } catch { /* ignore */ }
      yield { type: "tool_use", toolCallId: tc.callId, toolName: tc.name, arguments: input };
    }

    log.debug(`openai-subscription stream done model=${model} events=${eventCount} elapsed=${Date.now() - start}ms stopReason=${stopReason}`);
    yield { type: "usage", usage: streamUsage, model, stopReason };
  } catch (err: any) {
    if (err.name === "AbortError" || err.code === "ERR_CANCELED" || options.signal?.aborted) {
      log.debug(`openai-subscription stream aborted model=${model}`);
      throw err;
    } else if (err.status === 429 || (err.message && err.message.includes("rate limit"))) {
      log.error(`openai-subscription stream rate limit model=${model}`);
      yield { type: "error", error: "OpenAI subscription rate limit reached. Your ChatGPT subscription limit has been hit. Please wait and try again." };
    } else {
      log.error(`openai-subscription stream ERROR model=${model}: ${err.message}`);
      yield { type: "error", error: err.message || "OpenAI subscription stream error" };
    }
  }
}


async function* anthropicStream(model: string, options: ChatCompletionStreamOptions): AsyncGenerator<StreamEvent> {
  const client = getAnthropicClient(options.routingDecision?.credential);
  const buildStart = Date.now();

  let systemPrompt: string | undefined;
  const messages: Array<any> = [];

  for (const msg of options.messages) {
    if (msg.role === "system") {
      systemPrompt = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    } else if (msg.role === "tool" || msg.role === "tool_result") {
      if (Array.isArray(msg.content)) {
        messages.push({
          role: "user",
          content: msg.content.map((block: any) => ({
            type: "tool_result",
            tool_use_id: block.tool_use_id || msg.toolCallId,
            content: block.content || (typeof block === "string" ? block : JSON.stringify(block)),
            ...(block.is_error ? { is_error: true } : {}),
          })),
        });
      } else {
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          }],
        });
      }
    } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
      messages.push({ role: "assistant", content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const anthropicBlocks = msg.content.map((block: any) => {
        if (block.type === "image_url" && block.image_url?.url) {
          const url: string = block.image_url.url;
          if (url.startsWith("data:")) {
            const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
            if (match) {
              return {
                type: "image" as const,
                source: { type: "base64" as const, media_type: match[1], data: match[2] },
              };
            }
          }
          return { type: "text" as const, text: `[Image URL: ${url}]` };
        }
        if (block.type === "text") {
          return { type: "text" as const, text: block.text };
        }
        return block;
      });
      messages.push({ role: msg.role as "user" | "assistant", content: anthropicBlocks });
    } else {
      messages.push({
        role: msg.role as "user" | "assistant",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
    }
  }

  if (messages.length === 0) {
    messages.push({ role: "user", content: "." });
  }

  if (messages.length > 0 && messages[messages.length - 1].role === "assistant" && !Array.isArray(messages[messages.length - 1].content)) {
    log.debug(`anthropicStream: trailing assistant text message detected — stripping to avoid prefill error. model=${model} messageCount=${messages.length}`);
    messages.pop();
    if (messages.length === 0) {
      messages.push({ role: "user", content: "." });
    }
  }

  const maxOutputTokens = getMaxOutputTokens(model);
  const clampedMaxTokens = Math.min(options.maxTokens || 16384, maxOutputTokens);
  if (options.maxTokens && clampedMaxTokens < options.maxTokens) {
    log.debug(`anthropicStream clamping maxTokens from ${options.maxTokens} to ${clampedMaxTokens} for model=${model}`);
  }

  const params: any = {
    model,
    messages,
    max_tokens: clampedMaxTokens,
    stream: true,
  };

  if (systemPrompt) params.system = systemPrompt;
  if (options.temperature !== undefined) params.temperature = options.temperature;
  if (options.tools && options.tools.length > 0) {
    params.tools = convertToolsToAnthropic(options.tools);
  }

  const resolved = options.thinking;
  const { isAdaptiveOnly } = await import("./thinking-config");
  const adaptiveOnly = isAdaptiveOnly(model);
  if (resolved?.thinking.type === "enabled" && resolved.thinking.budgetTokens && !adaptiveOnly) {
    params.thinking = { type: "enabled", budget_tokens: resolved.thinking.budgetTokens };
    delete params.temperature;
  } else if (resolved?.thinking.type === "adaptive" || (adaptiveOnly && resolved?.thinking.type !== "disabled")) {
    if (adaptiveOnly) {
      // Adaptive-only models (Fable) reject the budget-token shape and think
      // adaptively by default — omit the thinking param entirely.
      delete params.temperature;
    } else {
      // Anthropic API does not currently accept the SDK 'adaptive' shape; send an enabled
      // thinking block with a sensible default budget so the model still reasons.
      params.thinking = { type: "enabled", budget_tokens: 8192 };
      delete params.temperature;
    }
  } else if (options.thinkingBudget && !resolved) {
    const { isThinkingModel: checkThinking } = await import("./model-registry");
    if (checkThinking(model)) {
      params.thinking = { type: "enabled", budget_tokens: options.thinkingBudget };
      delete params.temperature;
    }
  }

  let eventCount = 0;
  const streamLoopStart = Date.now();
  let connectedEmitted = false;

  // HTTP dispatch boundary: message conversion + params build complete.
  yield { type: "request_sent", metadata: { buildMs: Date.now() - buildStart } };

  const OVERLOAD_RETRY_DELAYS_MS = [1000, 2000, 4000];
  let lastOverloadErr: any = null;

  for (let attempt = 0; attempt <= OVERLOAD_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delayMs = OVERLOAD_RETRY_DELAYS_MS[attempt - 1];
      log.warn(`anthropicStream: overloaded_error, retrying attempt=${attempt} after ${delayMs}ms model=${model}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        options.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (options.signal?.aborted) {
        log.debug(`anthropic stream aborted during overload backoff model=${model}`);
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
        return;
      }
    }

    try {
      const stream = client.messages.stream(params, {
        signal: options.signal,
      });

      let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";
      const toolCalls: Map<number, { id: string; name: string; jsonAccumulator: string }> = new Map();

      log.debug(`anthropic stream loop started model=${model} attempt=${attempt}`);

      for await (const event of stream) {
        eventCount++;
        if (!connectedEmitted) {
          connectedEmitted = true;
          yield { type: "connected" };
        }
        if (event.type === "content_block_start") {
          const block = (event as any).content_block;
          if (block.type === "thinking") {
            // thinking block started
          } else if (block.type === "tool_use") {
            const idx = (event as any).index;
            toolCalls.set(idx, { id: block.id, name: block.name, jsonAccumulator: "" });
            yield { type: "tool_use_start", toolCallId: block.id, toolName: block.name };
          }
        } else if (event.type === "content_block_delta") {
          const delta = (event as any).delta;
          if (delta.type === "thinking_delta") {
            yield { type: "thinking_delta", content: delta.thinking };
          } else if (delta.type === "text_delta") {
            yield { type: "text_delta", content: delta.text };
          } else if (delta.type === "input_json_delta") {
            const idx = (event as any).index;
            const tc = toolCalls.get(idx);
            if (tc) {
              tc.jsonAccumulator += delta.partial_json;
            }
          }
        } else if (event.type === "content_block_stop") {
          const idx = (event as any).index;
          const tc = toolCalls.get(idx);
          if (tc) {
            let input: Record<string, any> = {};
            try {
              input = JSON.parse(tc.jsonAccumulator || "{}");
            } catch (err) { log.warn(`anthropic tool args parse failed`, tc.name, err); }
            yield { type: "tool_use", toolCallId: tc.id, toolName: tc.name, arguments: input };
            toolCalls.delete(idx);
          }
        } else if (event.type === "message_delta") {
          const md = (event as any).delta;
          if (md.stop_reason) {
            stopReason = md.stop_reason;
          }
        }
      }

      log.debug(`anthropic stream loop ended model=${model} events=${eventCount} elapsed=${Date.now() - streamLoopStart}ms`);

      let usage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; visibleOutputTokens?: number } = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      try {
        const finalMessage = await withTimeout(stream.finalMessage(), STREAM_FINAL_MESSAGE_TIMEOUT_MS, "stream.finalMessage");
        if (finalMessage.usage) {
          usage = {
            inputTokens: finalMessage.usage.input_tokens,
            outputTokens: finalMessage.usage.output_tokens,
            cacheReadTokens: finalMessage.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
            totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens
              + (finalMessage.usage.cache_read_input_tokens ?? 0)
              + (finalMessage.usage.cache_creation_input_tokens ?? 0),
          };
        }
      } catch (fmErr) {
        log.warn(`anthropic finalMessage failed (using zero usage) model=${model}: ${fmErr instanceof Error ? fmErr.message : String(fmErr)}`);
      }

      log.debug(`anthropic stream done model=${model} input=${usage.inputTokens} output=${usage.outputTokens} total=${usage.totalTokens} stopReason=${stopReason}`);
      yield { type: "usage", usage, model, stopReason };
      return;
    } catch (err: any) {
      if (err.name === "AbortError" || err.code === "ERR_CANCELED" || options.signal?.aborted) {
        const elapsedMs = Date.now() - streamLoopStart;
        log.debug(`anthropic stream aborted model=${model} events=${eventCount} elapsedMs=${elapsedMs}`);
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
        return;
      }

      const isOverloaded = err.error?.type === "overloaded_error" ||
        (typeof err.message === "string" && err.message.includes("overloaded_error"));

      if (isOverloaded && attempt < OVERLOAD_RETRY_DELAYS_MS.length) {
        lastOverloadErr = err;
        continue;
      }

      log.error(`anthropic stream ERROR model=${model}: ${err.message}`);
      yield { type: "error", error: err.message || "Anthropic stream error" };
      return;
    }
  }

  log.error(`anthropic stream overloaded after all retries model=${model}: ${lastOverloadErr?.message}`);
  yield { type: "error", error: lastOverloadErr?.message || "overloaded_error" };
}

/**
 * Direct OpenAI Responses API stream — used for models with a selectable
 * reasoning effort (registry `selectableEffort`). Mirrors the Codex
 * subscription stream's event handling; reuses the shared Responses-format
 * message and tool converters.
 */
async function* openaiResponsesStream(model: string, options: ChatCompletionStreamOptions): AsyncGenerator<StreamEvent> {
  const start = Date.now();
  const clientRequestId = randomUUID();
  let providerRequestId: string | undefined;
  let eventCount = 0;

  try {
    const client = getOpenAIClient(options.routingDecision?.credential);
    const { instructions, input } = buildCodexInput(options.messages);

    const params: Record<string, any> = {
      model,
      instructions,
      input,
      store: false,
      stream: true,
    };
    applyOpenAIConnectorConfig(params, resolvedOpenAIConfig(options), model, options, "responses");
    if (options.tools && options.tools.length > 0) {
      params.tools = convertToolsToCodexResponses(options.tools);
    }

    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";
    let streamUsage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; reasoningTokens?: number; visibleOutputTokens?: number } = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const pendingToolCalls = new Map<string, { callId: string; name: string; argsAccumulator: string; reasoningEmitted: boolean }>();
    let connectedEmitted = false;

    // HTTP dispatch boundary: request build complete, dispatching to OpenAI.
    yield { type: "request_sent", metadata: { buildMs: Date.now() - start } };
    const dispatchAt = Date.now();
    const responsePromise = client.responses.create(params as any, {
      signal: options.signal,
      maxRetries: 0,
      headers: { "X-Client-Request-Id": clientRequestId },
    });
    const { data: stream, request_id: requestId } = await responsePromise.withResponse();
    providerRequestId = requestId || undefined;
    // responses.create resolves once response headers land — TTFB boundary.
    yield {
      type: "headers_received",
      metadata: {
        headersMs: Date.now() - dispatchAt,
        clientRequestId,
        providerRequestId,
      },
    };

    for await (const chunk of stream) {
      eventCount++;
      if (!connectedEmitted) { connectedEmitted = true; yield { type: "connected" }; }

      const usageData = chunk.response?.usage;
      if (usageData) {
        streamUsage = {
          inputTokens: usageData.input_tokens || 0,
          outputTokens: usageData.output_tokens || 0,
          totalTokens: usageData.total_tokens || 0,
          cacheReadTokens: usageData.input_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: usageData.output_tokens_details?.reasoning_tokens ?? 0,
          visibleOutputTokens: (usageData.output_tokens || 0) - (usageData.output_tokens_details?.reasoning_tokens ?? 0),
        };
      }

      if (chunk.type === "response.reasoning_summary_text.delta" && typeof chunk.delta === "string") {
        yield { type: "thinking_delta", content: chunk.delta };
      } else if (chunk.type === "response.output_text.delta" && typeof chunk.delta === "string") {
        yield { type: "text_delta", content: chunk.delta };
      } else if (chunk.type === "response.output_item.added" && chunk.item?.type === "function_call") {
        const itemId = chunk.item.id || `item-${chunk.output_index ?? eventCount}`;
        const callId = chunk.item.call_id || itemId;
        const name = chunk.item.name || "";
        pendingToolCalls.set(itemId, { callId, name, argsAccumulator: "", reasoningEmitted: false });
        yield { type: "tool_use_start", toolCallId: callId, toolName: name };
        stopReason = "tool_use";
      } else if (chunk.type === "response.function_call_arguments.delta") {
        const itemId = chunk.item_id;
        const argsDelta = typeof chunk.delta === "string" ? chunk.delta : (chunk.delta as any)?.arguments || "";
        if (itemId) {
          const tc = pendingToolCalls.get(itemId);
          if (tc) {
            tc.argsAccumulator += argsDelta;
            if (!tc.reasoningEmitted) {
              const match = tc.argsAccumulator.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"/);
              if (match) {
                tc.reasoningEmitted = true;
                const reasoning = match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
                yield { type: "tool_use_update", toolCallId: tc.callId, narrative: reasoning };
              }
            }
          }
        }
      } else if (chunk.type === "response.function_call_arguments.done") {
        const itemId = chunk.item_id;
        if (itemId) {
          const tc = pendingToolCalls.get(itemId);
          if (tc) {
            let inputArgs: Record<string, unknown> = {};
            try { inputArgs = JSON.parse(tc.argsAccumulator || "{}"); } catch { /* ignore */ }
            yield { type: "tool_use", toolCallId: tc.callId, toolName: tc.name, arguments: inputArgs };
            pendingToolCalls.delete(itemId);
          }
        }
      } else if (chunk.type === "response.completed") {
        stopReason = pendingToolCalls.size > 0 ? "tool_use" : "end_turn";
      } else if (chunk.type === "response.incomplete") {
        stopReason = "max_tokens";
      } else if (chunk.type === "response.failed" || chunk.type === "error") {
        const providerError = modelProviderErrorFromAttempt(
          responsesProviderFailure(chunk, { clientRequestId, providerRequestId }),
          1,
          { provider: "openai", model, metadata: options.metadata },
        );
        yield {
          type: "error",
          error: providerError.message,
          providerFailure: providerError.providerFailure,
        };
        return;
      }
    }

    // Emit any remaining tool calls that didn't receive a done event.
    for (const tc of pendingToolCalls.values()) {
      let inputArgs: Record<string, unknown> = {};
      try { inputArgs = JSON.parse(tc.argsAccumulator || "{}"); } catch { /* ignore */ }
      yield { type: "tool_use", toolCallId: tc.callId, toolName: tc.name, arguments: inputArgs };
    }

    log.debug(`openai responses stream done model=${model} events=${eventCount} elapsed=${Date.now() - start}ms stopReason=${stopReason} effort=${effort ?? "default"}`);
    yield { type: "usage", usage: streamUsage, model, stopReason };
  } catch (err: unknown) {
    const error = err as { name?: string; code?: string };
    if (error?.name === "AbortError" || error?.code === "ERR_CANCELED" || options.signal?.aborted) {
      log.debug(`openai responses stream aborted model=${model}`);
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
      return;
    }
    const providerError = modelProviderErrorFromAttempt(
      openaiSdkAttemptError(err, clientRequestId),
      1,
      { provider: "openai", model, metadata: options.metadata },
    );
    yield {
      type: "error",
      error: providerError.message,
      providerFailure: providerError.providerFailure,
    };
  }
}

async function* openaiStream(model: string, options: ChatCompletionStreamOptions): AsyncGenerator<StreamEvent> {
  // Effort-capable models (GPT-5.6 family) use the Responses API so the tier
  // thinking config can map onto a reasoning effort.
  const connectorConfig = resolvedOpenAIConfig(options);
  if (supportsSelectableEffort(model) || connectorConfig?.reasoningMode || connectorConfig?.reasoningSummary || connectorConfig?.verbosity || connectorConfig?.serviceTier) {
    yield* openaiResponsesStream(model, options);
    return;
  }

  const client = getOpenAIClient(options.routingDecision?.credential);
  const buildStart = Date.now();
  const clientRequestId = randomUUID();

  const messages: Array<any> = options.messages.flatMap(m => {
    if (m.role === "tool" || m.role === "tool_result") {
      if (Array.isArray(m.content)) {
        return m.content.map((block: any) => ({
          role: "tool",
          tool_call_id: block.tool_use_id || m.toolCallId,
          content: block.content || (typeof block === "string" ? block : JSON.stringify(block)),
        }));
      }
      return [{
        role: "tool",
        tool_call_id: m.toolCallId,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      }];
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const textParts = m.content.filter((p: any) => p.type === "text");
      const toolUseParts = m.content.filter((p: any) => p.type === "tool_use");
      const result: any = {
        role: "assistant",
        content: textParts.map((p: any) => p.text).join("") || null,
      };
      if (toolUseParts.length > 0) {
        result.tool_calls = toolUseParts.map((p: any) => ({
          id: p.id,
          type: "function",
          function: { name: p.name, arguments: JSON.stringify(p.input || {}) },
        }));
      }
      return [result];
    }
    return [{ role: m.role, content: m.content }];
  });

  const params: any = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  const chatMaxTokens = connectorMaxOutputTokens(connectorConfig, options.maxTokens);
  if (chatMaxTokens) {
    if (usesMaxCompletionTokens(model)) {
      params.max_completion_tokens = chatMaxTokens;
    } else {
      params.max_tokens = chatMaxTokens;
    }
  }
  if (options.temperature !== undefined) params.temperature = options.temperature;
  if (options.tools && options.tools.length > 0) {
    params.tools = convertToolsToOpenAI(options.tools);
  }

  try {
    // HTTP dispatch boundary: request build complete, dispatching to OpenAI.
    yield { type: "request_sent", metadata: { buildMs: Date.now() - buildStart } };
    const dispatchAt = Date.now();
    const responsePromise = client.chat.completions.create(params, {
      signal: options.signal,
      maxRetries: 0,
      headers: { "X-Client-Request-Id": clientRequestId },
    });
    const { data: stream, request_id: providerRequestId } = await responsePromise.withResponse();
    // completions.create resolves once response headers land — TTFB boundary.
    yield {
      type: "headers_received",
      metadata: {
        headersMs: Date.now() - dispatchAt,
        clientRequestId,
        providerRequestId: providerRequestId || undefined,
      },
    };

    let inThinking = false;
    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";
    const toolCalls: Map<number, { id: string; name: string; argsAccumulator: string }> = new Map();
    let streamUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let connectedEmitted = false;

    for await (const chunk of stream as any) {
      if (!connectedEmitted) {
        connectedEmitted = true;
        yield { type: "connected" };
      }
      if (chunk.usage) {
        streamUsage = {
          inputTokens: chunk.usage.prompt_tokens || 0,
          outputTokens: chunk.usage.completion_tokens || 0,
          totalTokens: chunk.usage.total_tokens || 0,
        };
      }

      const delta = chunk.choices?.[0]?.delta;
      const finishReason = chunk.choices?.[0]?.finish_reason;

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (tc.id) {
            const name = tc.function?.name || "";
            toolCalls.set(idx, { id: tc.id, name, argsAccumulator: tc.function?.arguments || "" });
            yield { type: "tool_use_start", toolCallId: tc.id, toolName: name };
          } else {
            const existing = toolCalls.get(idx);
            if (existing) {
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.argsAccumulator += tc.function.arguments;
            }
          }
        }
      }

      if (delta?.content) {
        const text = delta.content;

        const thinkOpenIdx = text.indexOf("<thinking>");
        const thinkCloseIdx = text.indexOf("</thinking>");

        if (inThinking) {
          if (thinkCloseIdx !== -1) {
            const beforeClose = text.substring(0, thinkCloseIdx);
            const afterClose = text.substring(thinkCloseIdx + "</thinking>".length);
            if (beforeClose) yield { type: "thinking_delta", content: beforeClose };
            inThinking = false;
            if (afterClose) yield { type: "text_delta", content: afterClose };
          } else {
            yield { type: "thinking_delta", content: text };
          }
        } else if (thinkOpenIdx !== -1) {
          const beforeOpen = text.substring(0, thinkOpenIdx);
          const afterOpen = text.substring(thinkOpenIdx + "<thinking>".length);
          if (beforeOpen) yield { type: "text_delta", content: beforeOpen };
          inThinking = true;
          if (afterOpen) {
            const closeInAfter = afterOpen.indexOf("</thinking>");
            if (closeInAfter !== -1) {
              const thinkContent = afterOpen.substring(0, closeInAfter);
              const rest = afterOpen.substring(closeInAfter + "</thinking>".length);
              if (thinkContent) yield { type: "thinking_delta", content: thinkContent };
              inThinking = false;
              if (rest) yield { type: "text_delta", content: rest };
            } else {
              yield { type: "thinking_delta", content: afterOpen };
            }
          }
        } else {
          yield { type: "text_delta", content: text };
        }
      }

      if (finishReason) {
        if (finishReason === "tool_calls") {
          stopReason = "tool_use";
        } else if (finishReason === "length") {
          stopReason = "max_tokens";
        } else if (finishReason === "stop") {
          stopReason = "end_turn";
        }
      }
    }

    const pendingToolCalls = Array.from(toolCalls.values());
    for (const tc of pendingToolCalls) {
      let input: Record<string, any> = {};
      try {
        input = JSON.parse(tc.argsAccumulator || "{}");
      } catch (err) { log.warn(`openai tool args parse failed`, tc.name, err); }
      yield { type: "tool_use", toolCallId: tc.id, toolName: tc.name, arguments: input };
    }

    log.debug(`openai stream done model=${model} toolCalls=${pendingToolCalls.length} stopReason=${stopReason} prompt=${streamUsage.inputTokens} completion=${streamUsage.outputTokens}`);
    yield { type: "usage", usage: streamUsage, model, stopReason };
  } catch (err: unknown) {
    if (isAbortError(err, options.signal)) {
      log.debug(`openai stream aborted model=${model}`);
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
      return;
    }
    const providerError = modelProviderErrorFromAttempt(
      openaiSdkAttemptError(err, clientRequestId),
      1,
      { provider: "openai", model, metadata: options.metadata },
    );
    yield {
      type: "error",
      error: providerError.message,
      providerFailure: providerError.providerFailure,
    };
  }
}

// ---------------------------------------------------------------------------
// Image generation via OpenAI Subscription (Responses API)
// ---------------------------------------------------------------------------

export async function generateImageViaSubscription(
  prompt: string,
  options?: {
    size?: string;
    quality?: string;
    background?: string;
    outputFormat?: string;
    signal?: AbortSignal;
  }
): Promise<{ buffer: Buffer; format: string }> {
  const accessToken = await getOpenAISubscriptionAccessToken();
  const modelString = (await resolveModelCandidates(ACTIVITY_FRAMING))[0].modelString;
  const { model: rawModel } = parseModelString(modelString);
  const modelInfo = getModel(rawModel);
  const codexModel = modelInfo?.codexModelId ?? "gpt-5.5";

  const imageToolDef: Record<string, unknown> = { type: "image_generation" };
  if (options?.size) imageToolDef.size = options.size;
  if (options?.quality) imageToolDef.quality = options.quality;
  if (options?.background) imageToolDef.background = options.background;
  if (options?.outputFormat) imageToolDef.output_format = options.outputFormat;

  const body: CodexResponsesRequest = {
    model: codexModel,
    instructions: "",
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    store: false,
    tools: [imageToolDef as any],
    tool_choice: { type: "image_generation" },
    stream: true,
  };

  const signal = options?.signal;
  const fetchOptions: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  };
  if (signal) fetchOptions.signal = signal;

  for (let attempt = 0; attempt < CODEX_COMPLETION_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      log.warn(`codex image-gen retry attempt=${attempt}/${CODEX_COMPLETION_MAX_ATTEMPTS - 1} model=${codexModel}`);
      try {
        await codexBackoffSleep(attempt, signal);
      } catch {
        throw new CodexAbortedError();
      }
    }

    const scope = createCodexAttemptScope(signal);
    try {
    let response: Response;
    try {
      response = await fetchCodexAttempt(fetchOptions, scope, codexModel, "image-gen", attempt, CODEX_COMPLETION_MAX_ATTEMPTS);
    } catch (err: any) {
      scope.cleanup();
      if (err.name === "AbortError" || signal?.aborted) throw err;
      throw err;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "unknown error");
      throw modelProviderErrorFromAttempt(codexHttpAttemptError(response, text, scope), attempt + 1, { model: codexModel });
    }

    let base64Result = "";
    let earlyFailure: ModelProviderAttemptError | undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break;

        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
        scope.markFirstEvent();

        if (chunk.type === "response.failed" || chunk.type === "error") {
          earlyFailure = responsesProviderFailure(chunk, {
            clientRequestId: scope.clientRequestId,
            providerRequestId: response.headers.get("x-request-id") || undefined,
            status: response.status,
          });
          break outer;
        }

        // Look for image_generation_call output items with a result field
        if (chunk.type === "response.output_item.done" && chunk.item?.type === "image_generation_call" && chunk.item?.result) {
          base64Result = chunk.item.result;
        }
        // Also handle completed response with output array
        if (chunk.type === "response.completed" && chunk.response?.output) {
          for (const outputItem of chunk.response.output) {
            if (outputItem.type === "image_generation_call" && outputItem.result) {
              base64Result = outputItem.result;
            }
          }
        }
      }
    }

    if (earlyFailure) {
      scope.cleanup();
      if (earlyFailure.retryable && attempt < CODEX_COMPLETION_MAX_ATTEMPTS - 1) continue;
      throw modelProviderErrorFromAttempt(earlyFailure, attempt + 1, { model: codexModel });
    }

    if (!base64Result) {
      scope.cleanup();
      throw new Error("Image generation returned empty result — no image data in response.");
    }

    scope.cleanup();
    const format = options?.outputFormat || "png";
    return { buffer: Buffer.from(base64Result, "base64"), format };
    } finally {
      scope.cleanup();
    }
  }

  throw new Error("Codex image generation exhausted retries without a provider failure");
}

export async function editImageViaSubscription(
  imageBuffers: Array<{ buffer: Buffer; mediaType: string }>,
  prompt: string,
  options?: { size?: string; quality?: string; outputFormat?: string; signal?: AbortSignal }
): Promise<{ buffer: Buffer; format: string }> {
  const accessToken = await getOpenAISubscriptionAccessToken();
  const modelString = (await resolveModelCandidates(ACTIVITY_FRAMING))[0].modelString;
  const { model: rawModel } = parseModelString(modelString);
  const modelInfo = getModel(rawModel);
  const codexModel = modelInfo?.codexModelId ?? "gpt-5.5";

  const inputBlocks: Array<CodexContentBlock> = [];
  for (const img of imageBuffers) {
    const dataUrl = `data:${img.mediaType};base64,${img.buffer.toString("base64")}`;
    inputBlocks.push({ type: "input_image", image_url: dataUrl });
  }
  inputBlocks.push({ type: "input_text", text: prompt });

  const imageToolDef: Record<string, unknown> = { type: "image_generation" };
  if (options?.size) imageToolDef.size = options.size;
  if (options?.quality) imageToolDef.quality = options.quality;
  if (options?.outputFormat) imageToolDef.output_format = options.outputFormat;

  const body: CodexResponsesRequest = {
    model: codexModel,
    instructions: "",
    input: [{ role: "user", content: inputBlocks }],
    store: false,
    tools: [imageToolDef as any],
    tool_choice: { type: "image_generation" },
    stream: true,
  };

  const signal = options?.signal;
  const fetchOptions: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  };
  if (signal) fetchOptions.signal = signal;

  for (let attempt = 0; attempt < CODEX_COMPLETION_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      log.warn(`codex image-edit retry attempt=${attempt}/${CODEX_COMPLETION_MAX_ATTEMPTS - 1} model=${codexModel}`);
      try {
        await codexBackoffSleep(attempt, signal);
      } catch {
        throw new CodexAbortedError();
      }
    }

    const scope = createCodexAttemptScope(signal);
    try {
    let response: Response;
    try {
      response = await fetchCodexAttempt(fetchOptions, scope, codexModel, "image-edit", attempt, CODEX_COMPLETION_MAX_ATTEMPTS);
    } catch (err: any) {
      scope.cleanup();
      if (err.name === "AbortError" || signal?.aborted) throw err;
      throw err;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "unknown error");
      throw modelProviderErrorFromAttempt(codexHttpAttemptError(response, text, scope), attempt + 1, { model: codexModel });
    }

    let base64Result = "";
    let earlyFailure: ModelProviderAttemptError | undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") break;

        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
        scope.markFirstEvent();

        if (chunk.type === "response.failed" || chunk.type === "error") {
          earlyFailure = responsesProviderFailure(chunk, {
            clientRequestId: scope.clientRequestId,
            providerRequestId: response.headers.get("x-request-id") || undefined,
            status: response.status,
          });
          break outer;
        }

        if (chunk.type === "response.output_item.done" && chunk.item?.type === "image_generation_call" && chunk.item?.result) {
          base64Result = chunk.item.result;
        }
        if (chunk.type === "response.completed" && chunk.response?.output) {
          for (const outputItem of chunk.response.output) {
            if (outputItem.type === "image_generation_call" && outputItem.result) {
              base64Result = outputItem.result;
            }
          }
        }
      }
    }

    if (earlyFailure) {
      scope.cleanup();
      if (earlyFailure.retryable && attempt < CODEX_COMPLETION_MAX_ATTEMPTS - 1) continue;
      throw modelProviderErrorFromAttempt(earlyFailure, attempt + 1, { model: codexModel });
    }

    if (!base64Result) {
      scope.cleanup();
      throw new Error("Image edit returned empty result — no image data in response.");
    }

    scope.cleanup();
    const format = options?.outputFormat || "png";
    return { buffer: Buffer.from(base64Result, "base64"), format };
    } finally {
      scope.cleanup();
    }
  }

  throw new Error("Codex image editing exhausted retries without a provider failure");
}
