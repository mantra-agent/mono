import OpenAI, { toFile } from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { ACTIVITY_FRAMING, ACTIVITY_CHAT, type ActivityId } from "./job-profiles";
import { resolveModelCandidates, appendFailedAttempt, type ModelRoutingDecision } from "./model-routing";
import { getMaxOutputTokens, getModel, supportsSelectableEffort, supportsGrokReasoningEffort } from "./model-registry";
import type { OpenAITierModelConfig, GrokSubscriptionTierModelConfig } from "@shared/model-connectors";
import {
  buildReasoningAudit,
  resolveOpenAIReasoningEffort,
  type OpenAIReasoningEffort,
  type ReasoningAudit,
} from "./thinking-config";
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
import { captureInferencePayload } from "./inference-payload-capture";
import { beginProviderAttempt, createProviderAttemptTracker, settleRetryingProviderAttempt, type ProviderAttemptTracker } from "./provider-attempt";
import { buildContinuationMessages, normalizeContinuationDelta } from "./provider-continuation";
import { redactSensitiveText } from "./sensitive-data-redaction";

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

function codedError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}

function getOpenAIClient(apiKeyOverride?: string, baseURLOverride?: string): OpenAI {
  if (apiKeyOverride) {
    return new OpenAI(
      baseURLOverride
        ? { apiKey: apiKeyOverride, baseURL: baseURLOverride }
        : { apiKey: apiKeyOverride },
    );
  }
  if (!_openaiClient) {
    const apiKey = getSecretSync("OPENAI_API_KEY");
    if (!apiKey) {
      throw codedError("CONNECTOR_NOT_CONFIGURED", "OpenAI API key not configured — add one in Settings → Secrets");
    }
    _openaiClient = new OpenAI({ apiKey });
  }
  return _openaiClient;
}

const OPENAI_SUBSCRIPTION_ACCOUNT_ID = "openai-subscription-primary";
const OPENAI_SUBSCRIPTION_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_SUBSCRIPTION_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_SUBSCRIPTION_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Single-flight token refresh — concurrent callers share one in-flight promise per account. */
const subscriptionTokenRefreshInFlight = new Map<string, Promise<string>>();

function singleFlightSubscriptionToken(accountId: string, factory: () => Promise<string>): Promise<string> {
  const existing = subscriptionTokenRefreshInFlight.get(accountId);
  if (existing) return existing;
  const pending = factory().finally(() => {
    if (subscriptionTokenRefreshInFlight.get(accountId) === pending) {
      subscriptionTokenRefreshInFlight.delete(accountId);
    }
  });
  subscriptionTokenRefreshInFlight.set(accountId, pending);
  return pending;
}

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
  return singleFlightSubscriptionToken(OPENAI_SUBSCRIPTION_ACCOUNT_ID, () => runWithPrincipal(createNamedSystemPrincipal("model-client"), async () => {
    const { getAccountTokens, updateAccount } = await import("./connected-accounts");
    const rawTokens = await getAccountTokens(OPENAI_SUBSCRIPTION_ACCOUNT_ID);
    if (!isOpenAISubscriptionTokens(rawTokens)) {
      throw codedError("CONNECTOR_NOT_CONFIGURED", "OpenAI Subscription not connected. Please connect your ChatGPT account in Settings → Connections.");
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
  }));
}

// ─── Grok Subscription (xAI SuperGrok / X Premium+) ────────────────────────
// Grok is OpenAI-compatible via api.x.ai/v1, so unlike openai-subscription
// (which rides the bespoke Codex responses transport) it reuses the standard
// chat-completions path with a baseURL + bearer override.
const GROK_SUBSCRIPTION_ACCOUNT_ID = "grok-subscription-primary";
const GROK_SUBSCRIPTION_API_BASE_URL = "https://api.x.ai/v1";
const GROK_SUBSCRIPTION_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const GROK_SUBSCRIPTION_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
/** xAI Imagine model used for image generation/edit via the Grok subscription connector. */
const GROK_IMAGE_MODEL = "grok-imagine-pro";

interface GrokSubscriptionTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expiry_date?: number;
  email?: string;
}

function isGrokSubscriptionTokens(v: unknown): v is GrokSubscriptionTokens {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>).access_token === "string";
}

async function getGrokSubscriptionAccessToken(): Promise<string> {
  return singleFlightSubscriptionToken(GROK_SUBSCRIPTION_ACCOUNT_ID, () => runWithPrincipal(createNamedSystemPrincipal("model-client"), async () => {
    const { getAccountTokens, updateAccount } = await import("./connected-accounts");
    const rawTokens = await getAccountTokens(GROK_SUBSCRIPTION_ACCOUNT_ID);
    if (!isGrokSubscriptionTokens(rawTokens)) {
      throw codedError("CONNECTOR_NOT_CONFIGURED", "Grok Subscription not connected. Please connect your xAI account in Settings → Connections.");
    }

    const tokens: GrokSubscriptionTokens = rawTokens;

    // Grok Subscription is a system integration: all users can use it for model
    // execution, but only system/admin paths may read or rotate its OAuth tokens.
    const isExpired = typeof tokens.expiry_date === "number" && Date.now() >= tokens.expiry_date - 60_000;
    if (isExpired && tokens.refresh_token) {
      log.debug("grok-subscription: refreshing access token");
      try {
        const params = new URLSearchParams({
          client_id: GROK_SUBSCRIPTION_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        });
        const response = await fetch(GROK_SUBSCRIPTION_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        if (response.ok) {
          const newTokens = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number };
          const updated: GrokSubscriptionTokens = {
            ...tokens,
            access_token: newTokens.access_token,
            refresh_token: newTokens.refresh_token || tokens.refresh_token,
            expiry_date: newTokens.expires_in ? Date.now() + newTokens.expires_in * 1000 : undefined,
          };
          await updateAccount(GROK_SUBSCRIPTION_ACCOUNT_ID, { tokens: updated });
          log.debug("grok-subscription: token refreshed successfully");
          return updated.access_token;
        } else {
          log.warn("grok-subscription: token refresh failed, using existing token");
        }
      } catch (err: any) {
        log.warn(`grok-subscription: token refresh error: ${err.message}`);
      }
    }

    return tokens.access_token;
  }));
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

interface OpenAIResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
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
  usage?: OpenAIResponsesUsage;
  response?: {
    id?: string;
    status?: string;
    usage?: OpenAIResponsesUsage;
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
  // The Responses API requires an input-bearing request. Emergency context
  // reduction may legitimately remove every non-system message, so preserve a
  // minimal user turn rather than dispatching an invalid empty request.
  if (input.length === 0) {
    input.push({ role: "user", content: "." });
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
  /**
   * Identifies a caller-owned cancellation that completes through a deliberate
   * degraded path. Expected aborts are audited as aborted inference and logged
   * at debug; the caller remains responsible for warning when it uses fallback.
   */
  expectedAbortReason?: string;
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
  /** Internal canonical provider-attempt tracker. Never supplied by feature callers. */
  providerAttemptTracker?: ProviderAttemptTracker;
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

async function captureProviderDispatch(
  provider: string,
  model: string,
  boundary: string,
  request: unknown,
  options: Pick<ChatCompletionOptions | ChatCompletionStreamOptions, "activity" | "metadata" | "routingDecision" | "providerAttemptTracker">,
  attempt = 1,
): Promise<string | null> {
  const tracker = options.providerAttemptTracker ?? createProviderAttemptTracker();
  const apiCallId = await beginProviderAttempt({
    tracker,
    provider,
    model,
    profile: options.routingDecision?.tier ?? "unknown",
    attempt,
    metadata: {
      activity: options.activity ?? options.metadata?.activity,
      source: options.metadata?.source,
      runId: options.metadata?.runId,
      sessionId: options.metadata?.sessionId,
      sessionKey: options.metadata?.sessionKey,
      requestId: options.metadata?.requestId,
    },
  });
  const captureId = await captureInferencePayload({
    provider,
    model,
    activity: options.activity ?? options.metadata?.activity ?? null,
    boundary,
    authority: `Concrete request object handed to ${boundary}`,
    observableBoundary: `${boundary} immediately before dispatch`,
    request,
    excludedSensitiveFields: ["authorization headers", "provider credentials", "AbortSignal"],
    attempt,
    metadata: {
      runId: options.metadata?.runId ?? null,
      requestId: options.metadata?.requestId ?? null,
      sessionKey: options.metadata?.sessionKey ?? null,
    },
    sessionId: options.metadata?.sessionId ?? null,
    source: options.metadata?.source ?? null,
    apiCallId,
  });
  return captureId;
}

export interface ChatCompletionResult {
  content: string;
  model: string;
  provider: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; visibleOutputTokens?: number };
  stopReason?: string;
  termination?: Record<string, unknown>;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }>;
  metadata?: Record<string, unknown>;
}

const log = createLogger("ModelClient");

const CONNECTOR_QUOTA_COOLDOWN_MS = 15 * 60 * 1000;
const connectorQuotaUnavailableUntil = new Map<number, number>();

function isConnectorQuotaExhaustion(error: unknown): error is ModelProviderError {
  if (!(error instanceof ModelProviderError)) return false;
  const failure = error.providerFailure;
  if (failure.status !== 402 && failure.status !== 403) return false;
  const diagnostic = `${failure.providerCode ?? ""} ${failure.providerMessage ?? ""} ${failure.bodySnippet ?? ""}`.toLowerCase();
  return diagnostic.includes("run out of credits")
    || diagnostic.includes("insufficient_quota")
    || diagnostic.includes("billing_hard_limit_reached");
}

function quotaEligibleCandidates(candidates: ModelRoutingDecision[]): ModelRoutingDecision[] {
  const now = Date.now();
  const eligible = candidates.filter((candidate) => {
    if (candidate.explicitOverride || candidate.connectorId === undefined) return true;
    const unavailableUntil = connectorQuotaUnavailableUntil.get(candidate.connectorId);
    if (!unavailableUntil) return true;
    if (unavailableUntil <= now) {
      connectorQuotaUnavailableUntil.delete(candidate.connectorId);
      return true;
    }
    return false;
  });
  return eligible.length ? eligible : candidates;
}

function recordConnectorQuotaExhaustion(routing: ModelRoutingDecision, error: unknown): void {
  if (routing.connectorId === undefined || routing.explicitOverride || !isConnectorQuotaExhaustion(error)) return;
  const unavailableUntil = Date.now() + CONNECTOR_QUOTA_COOLDOWN_MS;
  connectorQuotaUnavailableUntil.set(routing.connectorId, unavailableUntil);
  log.warn(`model connector quota cooldown connector=${routing.connectorId} provider=${routing.provider} model=${routing.model} unavailableUntil=${new Date(unavailableUntil).toISOString()}`);
}

function buildRequestContent(messages: Array<{ role: string; content: unknown }>): { content?: string; chars: number } {
  try {
    const serialized = JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })));
    // `chars` is the full un-truncated length used for per-call context-token
    // self-measurement; `content` is sliced only for capture/storage.
    return { content: serialized.slice(0, 50000), chars: serialized.length };
  } catch {
    return { content: undefined, chars: 0 };
  }
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  const e = err as { name?: string; code?: string } | null;
  return !!signal?.aborted || e?.name === "AbortError" || e?.code === "ERR_CANCELED";
}

export function isModelContextOverflow(error: unknown): boolean {
  return error instanceof ModelProviderError
    ? error.kind === "context_overflow" || error.providerFailure.providerCode === "context_length_exceeded"
    : false;
}

function matchesExpectedAbortReason(signal: AbortSignal | undefined, expectedReason: string | undefined): boolean {
  if (!signal?.aborted || !expectedReason) return false;
  const actualReason = signal.reason instanceof Error
    ? signal.reason.message
    : String(signal.reason ?? "");
  return actualReason === expectedReason;
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
    name: redactSensitiveText(e?.name || "Error"),
    message: redactSensitiveText(e?.message || String(err)),
    code: e?.code ? redactSensitiveText(e.code) : undefined,
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
    attempts: safe.attempts.map((attempt) => ({
      ...attempt,
      reason: attempt.reason ? redactSensitiveText(attempt.reason) : undefined,
    })),
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
  requestChars?: number;
  responseContent?: string;
  error?: Record<string, unknown>;
  latency?: { providerTtftMs?: number | null; firstSdkEventMs?: number | null; firstThinkingMs?: number | null; firstProgressMs?: number | null };
  reasoning?: ReasoningAudit;
  stopReason?: string;
  termination?: Record<string, unknown>;
  signal?: AbortSignal;
  apiCallId?: number;
}): Promise<void> {
  try {
    const { logApiCall } = await import("./cost-tracker");
    const meta = params.metadata;
    const reasoning = params.reasoning;

    // Per-call token self-measurement for providers whose native usage is not
    // per-call. claude-cli emits cumulative assistant.usage counters, so its rows
    // are otherwise excluded from comparable aggregation. We own the exact rendered
    // prompt and response at this boundary, so measure context (input) and output
    // tokens ourselves with the canonical char→token estimator and stamp an
    // explicit per_call semantic. The context-health consumer derives context size
    // as totalTokens − outputTokens, so we set total = context + output to keep the
    // row self-consistent. Gated to successful calls to avoid partial/aborted noise.
    let effectiveUsage = params.usage;
    let selfMeasuredMeta: Record<string, unknown> | undefined;
    if (params.routing.provider === "claude-cli" && params.status === "success") {
      const { estimateTokensFromChars, estimateTokens } = await import("./context-builder");
      const contextTokens = typeof params.requestChars === "number" && params.requestChars > 0
        ? estimateTokensFromChars(params.requestChars)
        : (params.requestContent ? estimateTokens(params.requestContent) : 0);
      if (contextTokens > 0) {
        const outputTokens = params.responseContent ? estimateTokens(params.responseContent) : 0;
        effectiveUsage = {
          ...params.usage,
          inputTokens: contextTokens,
          outputTokens,
          totalTokens: contextTokens + outputTokens,
        };
        selfMeasuredMeta = {
          usageSemantics: "per_call",
          tokenAccounting: {
            contextTokenSource: "self_measured_chars",
            providerReportedInputTokens: params.usage?.inputTokens ?? null,
            providerReportedOutputTokens: params.usage?.outputTokens ?? null,
            providerReportedTotalTokens: params.usage?.totalTokens ?? null,
          },
        };
      }
    }

    await logApiCall({
      apiCallId: params.apiCallId,
      startTime: params.startTime,
      profile: params.routing.tier,
      provider: params.routing.provider,
      model: params.routing.model,
      usage: effectiveUsage,
      sessionId: meta?.sessionId,
      runId: meta?.runId,
      sessionKey: meta?.sessionKey || meta?.sessionId || meta?.runId || meta?.source || "system",
      requestContent: params.requestContent,
      responseContent: params.responseContent,
      stopReason: params.stopReason,
      signal: params.signal,
      metadata: {
        ...(meta || {}),
        ...(selfMeasuredMeta || {}),
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
        routerId: params.routing.routerId ?? null,
        status: params.status,
        routing: auditRouting(params.routing),
        error: params.error,
        latency: params.latency,
        reasoning: reasoning
          ? {
              effort: reasoning.effort,
              thinkingSent: reasoning.thinkingSent,
              sourceKind: reasoning.sourceKind,
              nativeEffort: reasoning.nativeEffort,
              budgetTokens: reasoning.budgetTokens,
            }
          : undefined,
        // Flat aliases for SQL/jsonb filters and context-health grouping.
        reasoningEffort: reasoning?.effort,
        reasoningSourceKind: reasoning?.sourceKind,
        thinkingSent: reasoning?.thinkingSent,
        termination: params.termination,
        trackedAtBoundary: true,
      },
    });
  } catch (err: unknown) {
    const trackingError = err instanceof Error ? err : new Error(String(err));
    (trackingError as Error & { code?: string }).code ||= "INFERENCE_TRACKING_FAILED";
    log.error(
      `boundary inference tracking failed provider=${params.routing.provider} model=${params.routing.model} status=${params.status}: ${trackingError.message}`,
      trackingError,
    );
  }
}

function enrichModelError(err: unknown, routing: ModelRoutingDecision, metadata?: InferenceMetadata): Error {
  const base = err instanceof Error ? err : new Error(String(err));
  type EnrichedModelError = Error & {
    code?: string;
    routing?: ReturnType<typeof auditRouting>;
    inferenceMetadata?: InferenceMetadata;
  };
  (base as EnrichedModelError).routing = auditRouting(routing);
  (base as EnrichedModelError).inferenceMetadata = metadata;
  if (!(base as Error & { code?: string }).code) {
    const msg = base.message.toLowerCase();
    (base as Error & { code?: string }).code = msg.includes("rate limit") || msg.includes("quota") ? "PROVIDER_QUOTA" : "PROVIDER_UNCLASSIFIED";
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
  const candidates = quotaEligibleCandidates(latencyEligibleCandidates(
    options.routingDecision
      ? [options.routingDecision, ...(options.routingDecision.fallbackCandidates || [])]
      : await resolveModelCandidates(activity, {
          model: options.model,
          overrideReason: options.overrideReason || (sessionTierOverride ? "session model tier override" : undefined),
          semanticTierOverride: options.semanticTierOverride || sessionTierOverride || undefined,
          sessionId: options.metadata?.sessionId,
        }),
    options.latencyBudgetMs,
  ));
  let failures = candidates[0]?.attempts ?? [];
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index++) {
    const routing = { ...candidates[index], attempts: failures.length ? failures : candidates[index].attempts };
    try {
      return await executeChatCompletion({ ...options, routingDecision: routing }, routing);
    } catch (error) {
      lastError = error;
      if (isAbortError(error, options.signal) || isModelContextOverflow(error)) throw error;
      recordConnectorQuotaExhaustion(routing, error);
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
  const { content: requestContent, chars: requestChars } = buildRequestContent(options.messages);
  let result: ChatCompletionResult | undefined;
  const providerAttemptTracker = createProviderAttemptTracker();
  const attemptOptions = { ...options, providerAttemptTracker };

  if (!options.metadata) log.warn(`chatCompletion missing metadata provider=${provider} model=${model} activity=${activity}`);
  log.debug(`chatCompletion provider=${provider} model=${model} activity=${routing.activity} tier=${routing.tier} source=${routing.source} configHash=${routing.configHash} messages=${msgCount} maxTokens=${options.maxTokens ?? "default"} jsonMode=${!!options.jsonMode}`);

  try {
    result = provider === "anthropic"
      ? await anthropicCompletion(model, { ...attemptOptions, routingDecision: routing })
      : provider === "claude-cli"
        ? await claudeCliCompletion(model, { ...attemptOptions, routingDecision: routing })
        : provider === "openai-subscription"
          ? await openaiSubscriptionCompletion(model, { ...attemptOptions, routingDecision: routing })
          : provider === "grok-subscription"
            ? await grokSubscriptionCompletion(model, { ...attemptOptions, routingDecision: routing })
            : await openaiCompletion(model, { ...attemptOptions, routingDecision: routing });

    result = { ...result, metadata: { ...(result.metadata || {}), routing: auditRouting(routing), trackedAtBoundary: true } };
    const elapsed = Date.now() - start;
    const usage = result.usage;
    log.debug(`chatCompletion done in ${elapsed}ms provider=${provider} model=${model} activity=${routing.activity} tier=${routing.tier} configHash=${routing.configHash} prompt=${usage?.promptTokens ?? "?"} completion=${usage?.completionTokens ?? "?"} total=${usage?.totalTokens ?? "?"}`);
    const reasoning = buildReasoningAudit(options.thinking, provider, grokImputedReasoningEffort(routing, model));
    await recordInference({ startTime: providerAttemptTracker.current?.startTime ?? start, routing, metadata: options.metadata, status: "success", usage, requestContent, requestChars, responseContent: result.content, reasoning, stopReason: result.stopReason, termination: result.termination, signal: options.signal, apiCallId: providerAttemptTracker.current?.apiCallId });
    return result;
  } catch (err: any) {
    const elapsed = Date.now() - start;
    const status: InferenceStatus = isAbortError(err, options.signal) ? "aborted" : "error";
    routing.attempts = appendFailedAttempt(routing, err);
    const modelError = enrichModelError(err, routing, options.metadata);
    const errorMetadata = serializeModelError(modelError);
    const expectedAbort = status === "aborted"
      && matchesExpectedAbortReason(options.signal, options.expectedAbortReason);
    const completionFailureMessage =
      `chatCompletion ${status.toUpperCase()} in ${elapsed}ms provider=${provider} model=${model} ` +
      `activity=${routing.activity} tier=${routing.tier} configHash=${routing.configHash}` +
      `${expectedAbort ? ` expectedAbortReason=${options.expectedAbortReason}` : ""}: ${modelError.message}`;
    if (expectedAbort) {
      log.debug(completionFailureMessage);
    } else {
      log.error(completionFailureMessage, modelError);
    }
    const providerUsage = err instanceof ModelProviderError && err.providerFailure.usage
      ? {
          inputTokens: err.providerFailure.usage.inputTokens,
          outputTokens: err.providerFailure.usage.outputTokens,
          totalTokens: err.providerFailure.usage.totalTokens,
          cacheReadTokens: err.providerFailure.usage.cacheReadTokens,
          reasoningTokens: err.providerFailure.usage.reasoningTokens,
        }
      : undefined;
    const providerStopReason = err instanceof ModelProviderError ? providerFailureStopReason(err.providerFailure) : undefined;
    const providerTermination = err instanceof ModelProviderError ? providerFailureTerminationMetadata(err.providerFailure) : undefined;
    const reasoning = buildReasoningAudit(options.thinking, provider, grokImputedReasoningEffort(routing, model));
    await recordInference({ startTime: providerAttemptTracker.current?.startTime ?? start, routing, metadata: options.metadata, status, usage: result?.usage || providerUsage, requestContent, requestChars, responseContent: result?.content, error: errorMetadata, reasoning, stopReason: providerStopReason, termination: providerTermination, signal: options.signal, apiCallId: providerAttemptTracker.current?.apiCallId });
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

function resolvedGrokConfig(options: Pick<ChatCompletionOptions, "routingDecision">): GrokSubscriptionTierModelConfig | undefined {
  return options.routingDecision?.provider === "grok-subscription"
    ? options.routingDecision.modelConfig as GrokSubscriptionTierModelConfig | undefined
    : undefined;
}

// Grok stays on the chat.completions surface (transport override), so its tier
// config never flows through applyOpenAIConnectorConfig. Inject reasoning_effort
// directly, gated to Grok models that accept the parameter.
function applyGrokConnectorConfig(params: Record<string, any>, model: string, options: ChatCompletionOptions): void {
  const config = resolvedGrokConfig(options);
  if (config?.reasoningEffort && supportsGrokReasoningEffort(model)) {
    params.reasoning_effort = config.reasoningEffort;
  }
}

// The exact reasoning_effort actually injected for a Grok call, so the reasoning
// audit can label it instead of falling back to the `disabled` short-circuit.
// Mirrors the capability gate in applyGrokConnectorConfig.
function grokImputedReasoningEffort(routing: ModelRoutingDecision, model: string): string | undefined {
  if (routing.provider !== "grok-subscription") return undefined;
  if (!supportsGrokReasoningEffort(model)) return undefined;
  const config = routing.modelConfig as GrokSubscriptionTierModelConfig | undefined;
  const effort = config?.reasoningEffort;
  return typeof effort === "string" && effort.length > 0 ? effort : undefined;
}

function connectorMaxOutputTokens(config: OpenAITierModelConfig | undefined, runtimeMaxTokens?: number): number | undefined {
  if (runtimeMaxTokens !== undefined) return config?.maxOutputTokens !== undefined ? Math.min(runtimeMaxTokens, config.maxOutputTokens) : runtimeMaxTokens;
  return config?.maxOutputTokens;
}

function connectorReasoningEffort(config: OpenAITierModelConfig | undefined, model: string, thinking: ChatCompletionOptions["thinking"], surface: "responses" | "codex"): OpenAIReasoningEffort | undefined {
  if (!supportsSelectableEffort(model)) return undefined;

  // Connector tier mappings are canonical when configured. Legacy profile
  // thinking remains a compatibility fallback for callers without tier config.
  if (config?.reasoningEffort) return config.reasoningEffort as OpenAIReasoningEffort;
  if (thinking) return resolveOpenAIReasoningEffort(thinking, surface);
  return undefined;
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

async function openaiCompletion(
  model: string,
  options: ChatCompletionOptions,
  transport?: { client?: OpenAI; providerLabel?: string },
): Promise<ChatCompletionResult> {
  const providerLabel = transport?.providerLabel ?? "openai";

  // Effort-capable models (GPT-5.6 family) use the Responses API so the tier
  // thinking config can map onto a reasoning effort. Transport overrides
  // (Grok subscription) stay on the chat.completions surface.
  const connectorConfig = resolvedOpenAIConfig(options);
  if (
    !transport?.client &&
    (supportsSelectableEffort(model) || connectorConfig?.reasoningMode || connectorConfig?.reasoningSummary || connectorConfig?.verbosity || connectorConfig?.serviceTier)
  ) {
    return openaiResponsesCompletion(model, options);
  }

  const client = transport?.client ?? getOpenAIClient(options.routingDecision?.credential);

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
  if (options.tools && options.tools.length > 0) {
    params.tools = convertToolsToOpenAI(options.tools);
    params.tool_choice = "auto";
  }
  if (providerLabel === "grok-subscription") applyGrokConnectorConfig(params, model, options);

  const clientRequestId = randomUUID();
  try {
    await captureProviderDispatch(providerLabel, model, `${providerLabel}.chat.completions.create`, params, options);
    const responsePromise = client.chat.completions.create(params, {
      signal: options.signal,
      maxRetries: 0,
      headers: { "X-Client-Request-Id": clientRequestId },
    });
    const { data: response } = await responsePromise.withResponse();
    const message = response.choices[0]?.message;
    const content = message?.content || "";
    const rawToolCalls = message?.tool_calls;
    const toolCalls = Array.isArray(rawToolCalls) && rawToolCalls.length > 0
      ? rawToolCalls
          .filter((tc: any) => tc?.type === "function" || tc?.function?.name)
          .map((tc: any) => {
            let args: Record<string, any> = {};
            const rawArgs = tc.function?.arguments;
            if (typeof rawArgs === "string" && rawArgs.length > 0) {
              try {
                args = JSON.parse(rawArgs);
              } catch {
                args = { _raw: rawArgs };
              }
            } else if (rawArgs && typeof rawArgs === "object") {
              args = rawArgs as Record<string, any>;
            }
            return {
              id: String(tc.id || ""),
              name: String(tc.function?.name || ""),
              arguments: args,
            };
          })
      : undefined;

    return {
      content,
      model,
      provider: providerLabel,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
      stopReason: response.choices[0]?.finish_reason || undefined,
      toolCalls,
    };
  } catch (err: unknown) {
    if (isAbortError(err, options.signal)) throw err;
    throw modelProviderErrorFromAttempt(
      openaiSdkAttemptError(err, clientRequestId),
      1,
      { provider: providerLabel, model, metadata: options.metadata },
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
    await captureProviderDispatch("openai", model, "openai.responses.create", params, options);
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
const CODEX_MAX_ATTEMPTS = CODEX_RETRY_DELAYS_MS.length + 1;
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
  | "context_overflow"
  | "time_to_first_event"
  | "stream_interrupted"
  | "provider_failed"
  | "protocol_invalid";

export type ModelProviderFailurePhase = "fetch" | "first_event" | "stream" | "protocol";

export interface ModelProviderFailure extends ModelProviderFailureInfo {
  kind: ModelProviderFailureKind;
  provider: "openai-subscription" | "openai" | "grok-subscription" | "claude-cli";
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

/** Stable A-Z0-9_ code for telemetry aggregates — never rely on message tokenization. */
function stableProviderFailureCode(failure: Pick<ModelProviderFailure, "providerCode" | "kind" | "status">): string {
  const fromProvider = String(failure.providerCode ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (/^[A-Z][A-Z0-9_]{1,47}$/.test(fromProvider)) return fromProvider.slice(0, 48);
  const kind = String(failure.kind || "MODEL_PROVIDER")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "MODEL_PROVIDER";
  const status = typeof failure.status === "number" && failure.status > 0 ? `_${failure.status}` : "";
  const combined = `${kind}${status}`.slice(0, 48);
  return /^[A-Z][A-Z0-9_]{1,47}$/.test(combined) ? combined : "MODEL_PROVIDER_ERROR";
}

function normalizeLoggedModelError(err: unknown, fallbackCode: string, message?: string): Error {
  if (err instanceof Error) {
    const coded = err as Error & { code?: string };
    if (!coded.code || !/^[A-Z][A-Z0-9_]{1,48}$/.test(String(coded.code))) {
      coded.code = fallbackCode;
    }
    return err;
  }
  const normalized = new Error(message || (err === undefined || err === null ? fallbackCode : String(err)));
  (normalized as Error & { code?: string }).code = fallbackCode;
  return normalized;
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
  const providerName = failure.provider === "grok-subscription"
    ? "Grok"
    : failure.provider === "openai-subscription"
      ? "OpenAI Codex"
      : failure.provider === "anthropic" || failure.provider === "claude-cli"
        ? "Anthropic"
        : "OpenAI";
  const reference = providerFailureReference(failure);
  const referenceSuffix = reference ? ` Reference: ${reference}.` : "";
  const providerMessage = sanitizeProviderDiagnostic(failure.providerMessage);
  const reportedSuffix = providerMessage && providerMessage !== "response.failed"
    ? ` ${providerName} reported: ${providerMessage}`
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
  readonly code: string;
  readonly providerFailure: ModelProviderFailure;
  readonly kind: ModelProviderFailureKind;
  readonly retryable: boolean;
  readonly status: number;
  readonly attempts: number;
  readonly phase: ModelProviderFailurePhase;
  readonly bodySnippet?: string;
  readonly clientRequestId?: string;
  readonly providerRequestId?: string;
  readonly partialContent?: string;

  constructor(providerFailure: ModelProviderFailure, bodySnippet?: string, partialContent?: string) {
    super(providerFailure.userMessage);
    this.name = "ModelProviderError";
    this.code = stableProviderFailureCode(providerFailure);
    this.providerFailure = providerFailure;
    this.kind = providerFailure.kind;
    this.retryable = providerFailure.retryable;
    this.status = providerFailure.status;
    this.attempts = providerFailure.attempts;
    this.phase = providerFailure.phase;
    this.bodySnippet = sanitizeProviderDiagnostic(bodySnippet);
    this.clientRequestId = providerFailure.clientRequestId;
    this.providerRequestId = providerFailure.providerRequestId;
    this.partialContent = partialContent?.trim() ? partialContent : undefined;
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

function isRetryableCodexProviderCode(providerCode: string | undefined): boolean {
  // The subscription gateway can surface an upstream service failure as HTTP
  // 400 even though the request itself is valid. Trust only the provider's
  // bounded machine code here; never infer retryability from message text.
  return providerCode === "upstream_error";
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
  const detail = parseProviderErrorBody(bodySnippet);
  const contextOverflow = detail.providerCode === "context_length_exceeded";
  const retryable = isRetryableCodexStatus(response.status)
    || isRetryableCodexProviderCode(detail.providerCode);
  return new ModelProviderAttemptError({
    kind: contextOverflow
      ? "context_overflow"
      : response.status === 429
        ? "rate_limited"
        : retryable
          ? "http_retryable"
          : "http_permanent",
    retryable: contextOverflow ? false : retryable,
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
    kind: providerCode === "context_length_exceeded"
      ? "context_overflow"
      : providerCode === "rate_limit_exceeded"
        ? "rate_limited"
        : "provider_failed",
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

function responsesUsageInfo(usage: OpenAIResponsesUsage | undefined): ModelProviderFailureInfo["usage"] | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    totalTokens: usage.total_tokens || 0,
    cacheReadTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

function responsesTerminationMetadata(chunk: CodexResponsesChunk | undefined): Record<string, unknown> | undefined {
  if (!chunk) return undefined;
  const usage = responsesUsageInfo(chunk.response?.usage || chunk.usage);
  return {
    eventType: chunk.type,
    responseId: sanitizeProviderDiagnostic(chunk.response?.id) ?? null,
    responseStatus: sanitizeProviderDiagnostic(chunk.response?.status) ?? null,
    incompleteReason: sanitizeProviderDiagnostic(chunk.response?.incomplete_details?.reason) ?? null,
    sequenceNumber: chunk.sequence_number ?? null,
    usage: usage ?? null,
  };
}

function responsesIncompleteAttemptError(
  chunk: CodexResponsesChunk,
  context: {
    clientRequestId: string;
    providerRequestId?: string;
    status: number;
    diagnostics: Partial<ModelProviderFailure>;
  },
): ModelProviderAttemptError {
  const incompleteReason = sanitizeProviderDiagnostic(chunk.response?.incomplete_details?.reason) || "unknown";
  return new ModelProviderAttemptError({
    kind: "provider_failed",
    retryable: true,
    status: context.status,
    message: `response.incomplete:${incompleteReason}`,
    clientRequestId: context.clientRequestId,
    providerRequestId: context.providerRequestId,
    phase: "protocol",
    diagnostics: {
      ...context.diagnostics,
      eventType: chunk.type,
      responseId: sanitizeProviderDiagnostic(chunk.response?.id),
      responseStatus: sanitizeProviderDiagnostic(chunk.response?.status) || "incomplete",
      sequenceNumber: chunk.sequence_number,
      incompleteReason,
      providerMessage: `response.incomplete:${incompleteReason}`,
      providerEventFields: Object.keys(chunk).sort(),
      providerResponseFields: chunk.response ? Object.keys(chunk.response).sort() : undefined,
      usage: responsesUsageInfo(chunk.response?.usage || chunk.usage),
    },
  });
}

function responsesCompletedEmptyAttemptError(
  chunk: CodexResponsesChunk | undefined,
  context: {
    clientRequestId: string;
    providerRequestId?: string;
    status: number;
    diagnostics: Partial<ModelProviderFailure>;
  },
): ModelProviderAttemptError {
  return new ModelProviderAttemptError({
    kind: "protocol_invalid",
    retryable: true,
    status: context.status,
    message: "response.completed_without_output_text",
    clientRequestId: context.clientRequestId,
    providerRequestId: context.providerRequestId,
    phase: "protocol",
    diagnostics: {
      ...context.diagnostics,
      eventType: chunk?.type || "response.completed",
      responseId: sanitizeProviderDiagnostic(chunk?.response?.id),
      responseStatus: sanitizeProviderDiagnostic(chunk?.response?.status) || "completed",
      sequenceNumber: chunk?.sequence_number,
      providerMessage: "response.completed_without_output_text",
      providerEventFields: chunk ? Object.keys(chunk).sort() : undefined,
      providerResponseFields: chunk?.response ? Object.keys(chunk.response).sort() : undefined,
      usage: responsesUsageInfo(chunk?.response?.usage || chunk?.usage),
    },
  });
}

function providerFailureStopReason(failure: ModelProviderAttemptError | ModelProviderFailure): string {
  const diagnostics = failure instanceof ModelProviderAttemptError ? failure.diagnostics : failure;
  if (diagnostics?.responseStatus === "incomplete" || diagnostics?.eventType === "response.incomplete") {
    return `incomplete:${diagnostics.incompleteReason || "unknown"}`;
  }
  if (failure.kind === "protocol_invalid") return "protocol_invalid";
  return failure.kind;
}

function providerFailureTerminationMetadata(failure: ModelProviderAttemptError | ModelProviderFailure): Record<string, unknown> {
  const diagnostics = failure instanceof ModelProviderAttemptError ? failure.diagnostics : failure;
  return {
    eventType: diagnostics?.eventType ?? null,
    responseId: diagnostics?.responseId ?? null,
    responseStatus: diagnostics?.responseStatus ?? null,
    incompleteReason: diagnostics?.incompleteReason ?? null,
    sequenceNumber: diagnostics?.sequenceNumber ?? null,
    providerRequestId: failure.providerRequestId ?? null,
    usage: diagnostics?.usage ?? null,
  };
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
  const contextOverflow = providerCode === "context_length_exceeded";
  const bodySnippet = safeStringify(sdkError?.error || { message: sdkError?.message }, {
    maxBytes: MAX_PROVIDER_DIAGNOSTIC_CHARS,
    maxStrLen: MAX_PROVIDER_DIAGNOSTIC_CHARS,
    label: "model-client.openaiSdkError",
  });

  return new ModelProviderAttemptError({
    kind: contextOverflow
      ? "context_overflow"
      : status === 429
        ? "rate_limited"
        : status > 0
          ? (retryable ? "http_retryable" : "http_permanent")
          : "transport",
    retryable: contextOverflow ? false : retryable,
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

function anthropicSdkAttemptError(err: unknown, clientRequestId: string): ModelProviderAttemptError {
  const sdkError = err as {
    status?: number;
    request_id?: string;
    message?: string;
    error?: { message?: string; type?: string };
  };
  const status = typeof sdkError?.status === "number" ? sdkError.status : 0;
  const providerType = sanitizeProviderDiagnostic(sdkError?.error?.type);
  const providerMessage = sanitizeProviderDiagnostic(sdkError?.error?.message || sdkError?.message);
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500 || providerType === "overloaded_error";
  const bodySnippet = safeStringify(sdkError?.error || { message: sdkError?.message }, {
    maxBytes: MAX_PROVIDER_DIAGNOSTIC_CHARS,
    maxStrLen: MAX_PROVIDER_DIAGNOSTIC_CHARS,
    label: "model-client.anthropicSdkError",
  });

  return new ModelProviderAttemptError({
    kind: status === 429
      ? "rate_limited"
      : status > 0
        ? (retryable ? "http_retryable" : "http_permanent")
        : providerType === "overloaded_error"
          ? "provider_failed"
          : "transport",
    retryable,
    status,
    message: providerMessage || (status > 0 ? `HTTP ${status}` : "Anthropic SDK transport error"),
    bodySnippet,
    clientRequestId,
    providerRequestId: sanitizeProviderDiagnostic(sdkError?.request_id),
    phase: status > 0 ? "fetch" : "stream",
    diagnostics: {
      providerType,
      providerCode: providerType,
      providerMessage,
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
  // Construction is side-effect free. The tracked chat/stream or modality
  // boundary that terminally rejects the operation owns the one error log and
  // inference record; retries and propagation must not multiply fingerprints.
  return new ModelProviderError(providerFailure, err.bodySnippet);
}

// ─── Grok Subscription completions (xAI, OpenAI-compatible via api.x.ai/v1) ───
// Grok exposes a standard OpenAI-compatible surface, so both the completion and
// streaming paths reuse the OpenAI request/response shape via transport override
// (OAuth bearer + api.x.ai base URL). Non-stream inherits tools/tool_calls parity.
async function grokSubscriptionCompletion(model: string, options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const token = await getGrokSubscriptionAccessToken();
  const client = getOpenAIClient(token, GROK_SUBSCRIPTION_API_BASE_URL);
  return openaiCompletion(model, options, { client, providerLabel: "grok-subscription" });
}

async function* grokSubscriptionStream(model: string, options: ChatCompletionStreamOptions): AsyncGenerator<StreamEvent> {
  const token = await getGrokSubscriptionAccessToken();
  const client = getOpenAIClient(token, GROK_SUBSCRIPTION_API_BASE_URL);
  yield* openaiStream(model, options, { client, providerLabel: "grok-subscription" });
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

  for (let attempt = 0; attempt < CODEX_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      log.debug(
        `codex completion retry attempt=${attempt + 1}/${CODEX_MAX_ATTEMPTS} model=${codexModel} ` +
        `reason=${lastAttemptError?.phase ?? "protocol"}:${lastAttemptError?.message ?? "response.failed"} ` +
        `delay=${CODEX_RETRY_DELAYS_MS[attempt - 1]}ms`,
      );
      await codexBackoffSleep(attempt, parentSignal);
    }

    const scope = createCodexAttemptScope(parentSignal);
    try {
      await captureProviderDispatch("openai-subscription", codexModel, "fetch codex responses", body, options, attempt + 1);
      const response = await fetchCodexAttempt(fetchOptions, scope, codexModel, "completion", attempt, CODEX_MAX_ATTEMPTS);
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "unknown error");
        throw codexHttpAttemptError(response, text, scope);
      }

      let content = "";
      let streamUsage: OpenAIResponsesUsage | undefined;
      let terminalEvent: CodexResponsesChunk | undefined;
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
              `codex completion first event attempt=${attempt + 1}/${CODEX_MAX_ATTEMPTS} ` +
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
          else if (chunk.type === "response.completed" || chunk.type === "response.incomplete") {
            terminalEvent = chunk;
            terminalEventSeen = true;
          }
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
      const terminalUsage = terminalEvent?.response?.usage || terminalEvent?.usage || streamUsage;
      if (terminalEvent?.type === "response.incomplete") {
        throw responsesIncompleteAttemptError(terminalEvent, {
          clientRequestId: scope.clientRequestId,
          providerRequestId: response.headers.get("x-request-id") || undefined,
          status: response.status,
          diagnostics: codexFailureDiagnostics(scope, progress, terminalEventSeen, response),
        });
      }
      if (!content.trim()) {
        throw responsesCompletedEmptyAttemptError(terminalEvent, {
          clientRequestId: scope.clientRequestId,
          providerRequestId: response.headers.get("x-request-id") || undefined,
          status: response.status,
          diagnostics: codexFailureDiagnostics(scope, progress, terminalEventSeen, response),
        });
      }
      if (attempt > 0) {
        log.warn(
          `codex completion recovered after retry attempts=${attempt + 1}/${CODEX_MAX_ATTEMPTS} ` +
          `model=${codexModel} previousFailure=${lastAttemptError?.kind ?? "unknown"}:${lastAttemptError?.message ?? "unknown"}`,
        );
      }

      return {
        content,
        model,
        provider: "openai-subscription",
        usage: terminalUsage ? {
          promptTokens: terminalUsage.input_tokens,
          completionTokens: terminalUsage.output_tokens,
          totalTokens: terminalUsage.total_tokens,
          cacheReadTokens: terminalUsage.input_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: terminalUsage.output_tokens_details?.reasoning_tokens ?? 0,
          visibleOutputTokens: terminalUsage.output_tokens - (terminalUsage.output_tokens_details?.reasoning_tokens ?? 0),
        } : undefined,
        stopReason: "end_turn",
        termination: responsesTerminationMetadata(terminalEvent),
      };
    } catch (err: any) {
      if (parentSignal?.aborted || (isAbortError(err, scope.signal) && !scope.timedOut())) throw new CodexAbortedError();
      if (!(err instanceof ModelProviderAttemptError)) throw err;
      lastAttemptError = err;
      if (err.retryable && attempt < CODEX_MAX_ATTEMPTS - 1) {
        await settleRetryingProviderAttempt(options.providerAttemptTracker ?? createProviderAttemptTracker(), {
          error: serializeModelError(err),
          usage: err.diagnostics?.usage,
          stopReason: providerFailureStopReason(err),
          termination: providerFailureTerminationMetadata(err),
        });
      }
      log.debug(
        `codex completion attempt failed attempt=${attempt + 1}/${CODEX_MAX_ATTEMPTS} model=${codexModel} ` +
        `phase=${err.phase} status=${err.status || 0} elapsedMs=${Date.now() - scope.startedAt} ` +
        `clientRequestId=${err.clientRequestId} providerRequestId=${err.providerRequestId ?? "none"} error=${err.message}`,
      );
      if (!err.retryable || attempt === CODEX_MAX_ATTEMPTS - 1) {
        throw modelProviderErrorFromAttempt(err, attempt + 1, { model: codexModel, metadata: options.metadata });
      }
    } finally {
      scope.cleanup();
    }
  }

  if (lastAttemptError) {
    throw modelProviderErrorFromAttempt(lastAttemptError, CODEX_MAX_ATTEMPTS, { model: codexModel, metadata: options.metadata });
  }
  throw codedError("PROVIDER_RETRY_EXHAUSTED", "Codex completion exhausted retries without an attempt error");
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

  await captureProviderDispatch("anthropic", model, "anthropic.messages.create", params, options);
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
      throw codedError("JSON_MODE_PARSE_FAILED", `Anthropic JSON mode failed: ${parsed.error}. Model returned non-JSON: "${content.slice(0, 100)}"`);
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
  /**
   * Authority-allowed tools that are NOT in `tools` (i.e. not pre-loaded by the
   * active persona bundle). Registered with the SDK MCP server as cheap
   * passthrough stubs so a direct model call against one auto-hydrates and runs
   * within the same turn instead of hard-failing with "No such tool available".
   * Authority is the real boundary; the pre-load set is only an assumed-needs guess.
   */
  stubTools?: ToolDefinition[];
  toolExecutor?: (name: string, args: Record<string, unknown>, context?: { toolCallId: string; order: number }) => Promise<{ result: string; providerResult?: string; error?: boolean; sideEffectOnly?: boolean; continuation?: import("./agent-executor").ToolContinuation; normalizedArguments?: Record<string, unknown> }>;
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
  /** Normalized reasoning level for TTFT joins: none|low|medium|high|xhigh|unknown */
  reasoningEffort?: string;
  /** request_effort | request_budget | imputed_from_tier | none | unknown */
  reasoningSourceKind?: string;
  maxTokens?: number;
  msToFirstSdkEvent: number | null;
  msToFirstTextDelta: number | null;
  msToFirstThinkingDelta: number | null;
  msToFirstToolUse: number | null;
  /** Felt-latency primary: min(thinking, text, tool-use) since call start. */
  msToFirstProgress: number | null;
  poolKey?: string;
  poolHit?: boolean;
  poolEligible?: boolean;
}

export type StreamEvent =
  // A transient provider failure voided the prior attempt's reasoning-only
  // progress; the replacement attempt re-derives it. Consumers must drop any
  // uncommitted thinking accumulation so a retry cannot stitch two attempts
  // into one durable chronology or conversation context.
  | { type: "attempt_reset" }
  | { type: "thinking_delta"; content: string }
  | { type: "text_delta"; content: string }
  | { type: "tool_use_start"; toolCallId: string; toolName: string }
  | { type: "tool_use_update"; toolCallId: string; narrative: string }
  | { type: "tool_use"; toolCallId: string; toolName: string; arguments: Record<string, any> }
  | { type: "tool_call_resolved"; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: "tool_result_resolved"; toolCallId: string; toolName: string; arguments?: Record<string, unknown>; order?: number; result: string; providerResult?: string; error?: boolean; failure?: import("./tool-failure").ToolFailure; recoveryDecision?: import("./tool-operation-recovery").ToolRecoveryDecision; continuation?: import("./agent-executor").ToolContinuation; outcome?: import("./agent-executor").ToolOutcome; durationMs?: number }
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
  const candidates = quotaEligibleCandidates(options.routingDecision
    ? [options.routingDecision, ...(options.routingDecision.fallbackCandidates || [])]
    : await resolveModelCandidates(activity, {
        model: options.model,
        overrideReason: options.overrideReason || (sessionTierOverride ? "session model tier override" : undefined),
        semanticTierOverride: options.semanticTierOverride || sessionTierOverride || undefined,
        sessionId: options.metadata?.sessionId,
      }));
  let failures = candidates[0]?.attempts ?? [];
  let lastError: unknown;
  let continuationText: string | undefined;
  let continuationVisibleText = "";
  for (let index = 0; index < candidates.length; index++) {
    const routing = { ...candidates[index], attempts: failures.length ? failures : candidates[index].attempts };
    let emittedContent = false;
    let emittedTool = false;
    try {
      const attemptOptions = continuationText
        ? { ...options, routingDecision: routing, messages: buildContinuationMessages(options.messages, continuationText) }
        : { ...options, routingDecision: routing };
      for await (const event of executeChatCompletionStream(attemptOptions, routing)) {
        if (event.type === "text_delta" || event.type === "thinking_delta") emittedContent = true;
        if (event.type === "text_delta" && continuationText) {
          const normalized = normalizeContinuationDelta(continuationVisibleText || continuationText, event.content);
          continuationVisibleText += normalized;
          if (!normalized) continue;
          yield { ...event, content: normalized };
          continue;
        }
        if (event.type === "tool_use" || event.type === "tool_use_start" || event.type === "tool_call_resolved") {
          emittedContent = true;
          emittedTool = true;
        }
        yield event;
      }
      return;
    } catch (error) {
      lastError = error;
      const next = candidates[index + 1];
      const partialText = error instanceof ModelProviderError ? error.partialContent : undefined;
      const canContinue = !!next && !emittedTool && !!partialText && error instanceof ModelProviderError && error.retryable;
      if (isAbortError(error, options.signal) || isModelContextOverflow(error) || (emittedContent && !canContinue) || (!emittedContent && !next)) throw error;
      recordConnectorQuotaExhaustion(routing, error);
      failures = appendFailedAttempt(routing, error);
      continuationText = canContinue ? partialText : undefined;
      continuationVisibleText = continuationText || "";
      if (next) {
        if (continuationText) yield { type: "attempt_reset" };
        log.warn(`model stream connector fallback connector=${routing.connectorId} tier=${routing.tier} model=${routing.model} nextConnector=${next.connectorId} nextModel=${next.model} continuation=${!!continuationText} failure=${error instanceof Error ? error.message : String(error)}`);
      }
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
  const reasoningAudit = buildReasoningAudit(resolvedThinking, provider, grokImputedReasoningEffort(routing, model));
  const providerAttemptTracker = createProviderAttemptTracker();
  const optionsWithResolved: ChatCompletionStreamOptions = { ...options, thinking: resolvedThinking, providerAttemptTracker };
  const thinkingDesc = describeResolvedThinking(resolvedThinking);

  if (!options.metadata) log.warn(`chatCompletionStream missing metadata provider=${provider} model=${model} activity=${activity}`);
  log.debug(
    `stream start provider=${provider} model=${model} messages=${msgCount} tools=${toolCount} ` +
    `maxTokens=${options.maxTokens ?? "default"} thinking=${thinkingDesc} ` +
    `tier=${options.routingTier ?? routing.tier} activity=${routing.activity} configHash=${routing.configHash}`,
  );

  const t0 = Date.now();
  const { content: requestContent, chars: requestChars } = buildRequestContent(options.messages);
  let responseContent = "";
  let streamUsage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; visibleOutputTokens?: number } | undefined;
  let streamStopReason: string | undefined;
  let streamTermination: Record<string, unknown> | undefined;
  let firstSdkEventAt: number | null = null;
  let firstTextAt: number | null = null;
  let firstThinkingAt: number | null = null;
  let firstToolAt: number | null = null;
  let breakdownEmitted = false;
  let connectedMetadata: Record<string, unknown> | undefined;

  // Earliest defined milestone timestamp. First *progress* = min(thinking, text, tool).
  const minTs = (...values: Array<number | null>): number | null => {
    const defined = values.filter((v): v is number => v !== null);
    return defined.length ? Math.min(...defined) : null;
  };

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
    if (provider === "grok-subscription") return grokSubscriptionStream(model, optionsWithResolved);
    return openaiStream(model, optionsWithResolved);
  })();

  const emitBreakdown = (): StreamEvent => {
    breakdownEmitted = true;
    const firstProgressAt = minTs(firstThinkingAt, firstTextAt, firstToolAt);
    const breakdown: TtftBreakdown = {
      provider,
      model,
      routingTier: options.routingTier,
      activity: options.activity,
      thinkingSent: thinkingDesc,
      reasoningEffort: reasoningAudit.effort,
      reasoningSourceKind: reasoningAudit.sourceKind,
      maxTokens: options.maxTokens,
      msToFirstSdkEvent: firstSdkEventAt !== null ? firstSdkEventAt - t0 : null,
      msToFirstTextDelta: firstTextAt !== null ? firstTextAt - t0 : null,
      msToFirstThinkingDelta: firstThinkingAt !== null ? firstThinkingAt - t0 : null,
      msToFirstToolUse: firstToolAt !== null ? firstToolAt - t0 : null,
      msToFirstProgress: firstProgressAt !== null ? firstProgressAt - t0 : null,
      poolKey: connectedMetadata?.poolKey as string | undefined,
      poolHit: connectedMetadata?.poolHit as boolean | undefined,
      poolEligible: connectedMetadata?.poolEligible as boolean | undefined,
    };
    log.debug(
      `stream ttft provider=${provider} model=${model} tier=${breakdown.routingTier ?? "?"} ` +
      `activity=${breakdown.activity ?? "?"} thinking=${breakdown.thinkingSent} maxTokens=${breakdown.maxTokens ?? "?"} ` +
      `firstSdkEvent=${breakdown.msToFirstSdkEvent ?? "n/a"}ms firstProgress=${breakdown.msToFirstProgress ?? "n/a"}ms ` +
      `firstText=${breakdown.msToFirstTextDelta ?? "n/a"}ms firstThinking=${breakdown.msToFirstThinkingDelta ?? "n/a"}ms ` +
      `firstTool=${breakdown.msToFirstToolUse ?? "n/a"}ms ` +
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
      if (typeof event.stopReason === "string" && event.stopReason.length > 0) {
        streamStopReason = event.stopReason;
      }
      if (event.metadata && typeof event.metadata === "object") {
        const providerFinishReason =
          typeof event.metadata.providerFinishReason === "string"
            ? event.metadata.providerFinishReason
            : undefined;
        if (providerFinishReason || event.metadata.refusal) {
          streamTermination = {
            ...(streamTermination || {}),
            ...(providerFinishReason ? { providerFinishReason } : {}),
            ...(event.metadata.refusal ? { refusal: event.metadata.refusal } : {}),
          };
        }
      }
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
        ? new ModelProviderError(event.providerFailure, undefined, responseContent)
        : codedError("STREAM_ERROR_UNTYPED", event.error || "Provider stream error without structured failure");
    } else if (event.type === "thinking_delta") {
      if (firstThinkingAt === null) firstThinkingAt = Date.now();
    } else if (event.type === "tool_use_start" || event.type === "tool_use") {
      if (firstToolAt === null) firstToolAt = Date.now();
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
    requestChars,
    responseContent,
    reasoning: reasoningAudit,
    stopReason: streamStopReason,
    termination: streamTermination,
    latency: {
      providerTtftMs: firstTextAt !== null ? firstTextAt - t0 : null,
      firstSdkEventMs: firstSdkEventAt !== null ? firstSdkEventAt - t0 : null,
      firstThinkingMs: firstThinkingAt !== null ? firstThinkingAt - t0 : null,
      firstProgressMs: (() => { const p = minTs(firstThinkingAt, firstTextAt, firstToolAt); return p !== null ? p - t0 : null; })(),
    },
    signal: options.signal,
    apiCallId: providerAttemptTracker.current?.apiCallId,
  });
  } catch (err: unknown) {
    const status: InferenceStatus = isAbortError(err, options.signal) ? "aborted" : (responseContent ? "partial" : "error");
    routing.attempts = appendFailedAttempt(routing, err);
    const modelError = enrichModelError(err, routing, options.metadata);
    const continuationError = modelError instanceof ModelProviderError && responseContent
      ? new ModelProviderError(modelError.providerFailure, modelError.bodySnippet, responseContent)
      : modelError;
    const streamFailureMessage =
      `chatCompletionStream ${status.toUpperCase()} provider=${provider} model=${model} ` +
      `activity=${routing.activity} tier=${routing.tier} configHash=${routing.configHash}: ${modelError.message}`;
    if (status === "aborted") {
      // Caller-owned stream cancellation is expected; keep aggregates free of abort noise.
      log.debug(streamFailureMessage);
    } else {
      // Terminal stream failures must log the enriched Error (code + stack), not a string.
      log.error(streamFailureMessage, modelError);
    }
    await recordInference({
      startTime: t0,
      routing,
      metadata: options.metadata,
      status,
      usage: streamUsage,
      requestContent,
      requestChars,
      responseContent,
      reasoning: reasoningAudit,
      stopReason: streamStopReason,
      termination: streamTermination,
      error: serializeModelError(modelError),
      latency: {
        providerTtftMs: firstTextAt !== null ? firstTextAt - t0 : null,
        firstSdkEventMs: firstSdkEventAt !== null ? firstSdkEventAt - t0 : null,
        firstThinkingMs: firstThinkingAt !== null ? firstThinkingAt - t0 : null,
        firstProgressMs: (() => { const p = minTs(firstThinkingAt, firstTextAt, firstToolAt); return p !== null ? p - t0 : null; })(),
      },
      signal: options.signal,
      apiCallId: providerAttemptTracker.current?.apiCallId,
    });
    throw continuationError;
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
  // A retry becomes unsafe only after substantive output can be persisted or
  // executed downstream. Reasoning deltas and connection state do not commit
  // assistant text or invoke tools, so replay cannot duplicate durable work.
  let yieldedReplayUnsafeEvent = false;
  let connectedEmitted = false;
  // Tracks whether the current attempt streamed reasoning deltas downstream.
  // If it did and we retry, the replacement attempt must void them first.
  let yieldedThinkingEvent = false;

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
    let recoveredRetryAttempts = 0;

    // This loop is the sole retry owner. Retries remain safe until text or a
    // tool event crosses the downstream boundary. Reasoning-only progress may
    // be superseded by a replacement attempt without duplicating work.
    // HTTP dispatch boundary: auth + request build complete — everything before
    // this is local overhead, everything after is network/provider time.
    yield { type: "request_sent", metadata: { authMs, buildMs: Date.now() - authStart - authMs } };
    let headersEmitted = false;

    streamRetryLoop: for (let attempt = 0; attempt < CODEX_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        if (yieldedThinkingEvent) {
          // The failed attempt streamed reasoning downstream. Void it before
          // the replacement attempt so consumers cannot stitch two attempts'
          // reasoning into one durable record.
          yieldedThinkingEvent = false;
          yield { type: "attempt_reset" };
        }
        log.debug(
          `codex stream retry attempt=${attempt + 1}/${CODEX_MAX_ATTEMPTS} model=${codexModel} ` +
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
        await captureProviderDispatch("openai-subscription", codexModel, "fetch codex responses stream", body, options, attempt + 1);
        response = await fetchCodexAttempt(fetchOptions, scope, codexModel, "stream", attempt, CODEX_MAX_ATTEMPTS);
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
        log.debug(
          `codex stream attempt failed attempt=${attempt + 1}/${CODEX_MAX_ATTEMPTS} model=${codexModel} ` +
          `kind=${err.kind} retryable=${err.retryable} phase=${err.phase} status=${err.status || 0} ` +
          `elapsedMs=${Date.now() - scope.startedAt} clientRequestId=${err.clientRequestId} ` +
          `providerRequestId=${err.providerRequestId ?? "none"} error=${err.message}`,
        );
        if (err.retryable && attempt < CODEX_MAX_ATTEMPTS - 1) continue streamRetryLoop;
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
            retryable: !yieldedReplayUnsafeEvent,
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
              retryable: !yieldedReplayUnsafeEvent,
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
              retryable: !yieldedReplayUnsafeEvent,
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
              `codex stream first event attempt=${attempt + 1}/${CODEX_MAX_ATTEMPTS} model=${codexModel} ` +
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
            attemptFailure.retryable = attemptFailure.retryable && !yieldedReplayUnsafeEvent;
            break sseLoop;
          }

          if (chunk.type === "response.reasoning_summary_text.delta" && typeof chunk.delta === "string") {
            if (!connectedEmitted) { connectedEmitted = true; yield { type: "connected" }; }
            yieldedThinkingEvent = true;
            yield { type: "thinking_delta", content: chunk.delta };
          } else if (chunk.type === "response.output_text.delta" && typeof chunk.delta === "string") {
            if (!connectedEmitted) { connectedEmitted = true; yield { type: "connected" }; }
            yieldedReplayUnsafeEvent = true;
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
            if (!connectedEmitted) { connectedEmitted = true; yield { type: "connected" }; }
            yieldedReplayUnsafeEvent = true;
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
                    if (!connectedEmitted) { connectedEmitted = true; yield { type: "connected" }; }
                    yieldedReplayUnsafeEvent = true;
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
                if (!connectedEmitted) { connectedEmitted = true; yield { type: "connected" }; }
                yieldedReplayUnsafeEvent = true;
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
        log.debug(
          `codex stream attempt failed attempt=${attempt + 1}/${CODEX_MAX_ATTEMPTS} model=${codexModel} ` +
          `kind=${attemptFailure.kind} retryable=${attemptFailure.retryable} phase=${attemptFailure.phase} ` +
          `status=${attemptFailure.status || 0} elapsedMs=${Date.now() - scope.startedAt} ` +
          `clientRequestId=${attemptFailure.clientRequestId} providerRequestId=${attemptFailure.providerRequestId ?? "none"} ` +
          `error=${attemptFailure.message}`,
        );
        if (attemptFailure.retryable && attempt < CODEX_MAX_ATTEMPTS - 1) continue streamRetryLoop;
        const providerError = modelProviderErrorFromAttempt(attemptFailure, attempt + 1, { model: codexModel, metadata: options.metadata });
        yield { type: "error", error: providerError.message, providerFailure: providerError.providerFailure };
        return;
      }

      scope.cleanup();
      recoveredRetryAttempts = attempt;
      // Successful end-of-stream — exit retry loop.
      break;
      } finally {
        scope.cleanup();
      }
    }

    if (recoveredRetryAttempts > 0) {
      log.warn(
        `codex stream recovered after retry attempts=${recoveredRetryAttempts + 1}/${CODEX_MAX_ATTEMPTS} ` +
        `model=${codexModel} previousFailure=${lastEarlyReason || "unknown"}`,
      );
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
      const rateLimitError = normalizeLoggedModelError(err, "PROVIDER_QUOTA", `openai-subscription stream rate limit model=${model}`);
      log.error(`openai-subscription stream rate limit model=${model}`, rateLimitError);
      yield {
        type: "error",
        error: "OpenAI subscription rate limit reached. Your ChatGPT subscription limit has been hit. Please wait and try again.",
      };
    } else {
      const streamError = normalizeLoggedModelError(
        err,
        "STREAM_ERROR_UNTYPED",
        err?.message || "OpenAI subscription stream error",
      );
      log.error(`openai-subscription stream ERROR model=${model}`, streamError);
      yield { type: "error", error: streamError.message || "OpenAI subscription stream error" };
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
  const clientRequestId = randomUUID();
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
      await captureProviderDispatch("anthropic", model, "anthropic.messages.stream", params, options, attempt + 1);
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

      const providerError = modelProviderErrorFromAttempt(
        anthropicSdkAttemptError(err, clientRequestId),
        attempt + 1,
        { provider: "anthropic", model, metadata: options.metadata },
      );
      yield {
        type: "error",
        error: providerError.message,
        providerFailure: providerError.providerFailure,
      };
      return;
    }
  }

  const overloadError = modelProviderErrorFromAttempt(
    anthropicSdkAttemptError(lastOverloadErr, clientRequestId),
    OVERLOAD_RETRY_DELAYS_MS.length + 1,
    { provider: "anthropic", model, metadata: options.metadata },
  );
  yield {
    type: "error",
    error: overloadError.message,
    providerFailure: overloadError.providerFailure,
  };
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
    await captureProviderDispatch("openai", model, "openai.responses.create stream", params, options);
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

async function* openaiStream(model: string, options: ChatCompletionStreamOptions, transport?: { client?: OpenAI; providerLabel?: string }): AsyncGenerator<StreamEvent> {
  // Effort-capable models (GPT-5.6 family) use the Responses API so the tier
  // thinking config can map onto a reasoning effort.
  const connectorConfig = resolvedOpenAIConfig(options);
  if (supportsSelectableEffort(model) || connectorConfig?.reasoningMode || connectorConfig?.reasoningSummary || connectorConfig?.verbosity || connectorConfig?.serviceTier) {
    yield* openaiResponsesStream(model, options);
    return;
  }

  const providerLabel = transport?.providerLabel ?? "openai";
  const client = transport?.client ?? getOpenAIClient(options.routingDecision?.credential);
  const buildStart = Date.now();

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
  if (providerLabel === "grok-subscription") applyGrokConnectorConfig(params, model, options);

  // Bounded pre-content retries for transient transport blips. SDK maxRetries is 0 so
  // this boundary owns retry; once any user-visible stream event is yielded, replay is unsafe.
  let recoveredRetryAttempts = 0;
  let lastEarlyReason = "";
  streamRetryLoop: for (let attempt = 0; attempt < CODEX_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      log.debug(
        `openai-compatible stream retry attempt=${attempt + 1}/${CODEX_MAX_ATTEMPTS} provider=${providerLabel} model=${model} ` +
        `reason=${lastEarlyReason || "early-failure"} delay=${CODEX_RETRY_DELAYS_MS[attempt - 1]}ms`,
      );
      try {
        await codexBackoffSleep(attempt, options.signal);
      } catch {
        log.debug(`${providerLabel} stream aborted during early-failure backoff model=${model}`);
        yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
        return;
      }
    }

    const clientRequestId = randomUUID();
    let yieldedReplayUnsafeEvent = false;
    try {
    // HTTP dispatch boundary: request build complete, dispatching to provider.
    await captureProviderDispatch(providerLabel, model, `${providerLabel}.chat.completions.create stream`, params, options);
    if (attempt === 0) {
      yield { type: "request_sent", metadata: { buildMs: Date.now() - buildStart } };
    }
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
        attempt: attempt + 1,
      },
    };

    let inThinking = false;
    let stopReason = "end_turn";
    let providerFinishReason: string | undefined;
    let refusal: string | undefined;
    const toolCalls: Map<number, { id: string; name: string; argsAccumulator: string }> = new Map();
    let streamUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let connectedEmitted = false;

    for await (const chunk of stream as any) {
      if (!connectedEmitted) {
        connectedEmitted = true;
        // connected is milestone telemetry only; still replay-safe until content/tools emit.
        yield { type: "connected" };
      }
      if (chunk.usage) {
        streamUsage = {
          inputTokens: chunk.usage.prompt_tokens || 0,
          outputTokens: chunk.usage.completion_tokens || 0,
          totalTokens: chunk.usage.total_tokens || 0,
        };
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
      if (typeof choice?.delta?.refusal === "string" && choice.delta.refusal.length > 0) {
        refusal = `${refusal || ""}${choice.delta.refusal}`;
      }
      if (typeof choice?.message?.refusal === "string" && choice.message.refusal.length > 0) {
        refusal = choice.message.refusal;
      }

      if (delta?.tool_calls) {
        yieldedReplayUnsafeEvent = true;
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
        yieldedReplayUnsafeEvent = true;
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
        providerFinishReason = finishReason;
        // Preserve unknown provider values (content_filter, refusal, etc.) so
        // executor diagnostics and inference audit can classify empty turns.
        if (finishReason === "tool_calls") {
          stopReason = "tool_use";
        } else if (finishReason === "length") {
          stopReason = "max_tokens";
        } else if (finishReason === "stop" || finishReason === "end_turn") {
          stopReason = "end_turn";
        } else if (finishReason === "content_filter") {
          stopReason = "content_filter";
        } else {
          stopReason = finishReason;
        }
      }
    }

    const pendingToolCalls = Array.from(toolCalls.values());
    for (const tc of pendingToolCalls) {
      let input: Record<string, any> = {};
      try {
        input = JSON.parse(tc.argsAccumulator || "{}");
      } catch (err) { log.warn(`openai tool args parse failed`, tc.name, err); }
      yieldedReplayUnsafeEvent = true;
      yield { type: "tool_use", toolCallId: tc.id, toolName: tc.name, arguments: input };
    }

    log.debug(
      `${providerLabel} stream done model=${model} toolCalls=${pendingToolCalls.length} stopReason=${stopReason} ` +
      `providerFinishReason=${providerFinishReason || "n/a"} refusal=${refusal ? "yes" : "no"} ` +
      `prompt=${streamUsage.inputTokens} completion=${streamUsage.outputTokens} attempts=${attempt + 1}`,
    );
    yield {
      type: "usage",
      usage: streamUsage,
      model,
      stopReason,
      metadata: {
        ...(providerFinishReason ? { providerFinishReason } : {}),
        ...(refusal ? { refusal } : {}),
      },
    };
    recoveredRetryAttempts = attempt;
    break streamRetryLoop;
  } catch (err: unknown) {
    if (isAbortError(err, options.signal)) {
      log.debug(`${providerLabel} stream aborted model=${model}`);
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
      return;
    }
    const attemptError = openaiSdkAttemptError(err, clientRequestId);
    // Content already streamed cannot be replayed safely on this connector.
    attemptError.retryable = attemptError.retryable && !yieldedReplayUnsafeEvent;
    lastEarlyReason = `${attemptError.kind}:${attemptError.message}`;
    log.debug(
      `openai-compatible stream attempt failed attempt=${attempt + 1}/${CODEX_MAX_ATTEMPTS} provider=${providerLabel} model=${model} ` +
      `kind=${attemptError.kind} retryable=${attemptError.retryable} phase=${attemptError.phase} ` +
      `status=${attemptError.status || 0} clientRequestId=${attemptError.clientRequestId} error=${attemptError.message}`,
    );
    if (attemptError.retryable && attempt < CODEX_MAX_ATTEMPTS - 1) continue streamRetryLoop;
    const providerError = modelProviderErrorFromAttempt(
      attemptError,
      attempt + 1,
      { provider: providerLabel as ModelProviderFailure["provider"], model, metadata: options.metadata },
    );
    yield {
      type: "error",
      error: providerError.message,
      providerFailure: providerError.providerFailure,
    };
    return;
  }
  }

  if (recoveredRetryAttempts > 0) {
    log.warn(
      `openai-compatible stream recovered after retry attempts=${recoveredRetryAttempts + 1}/${CODEX_MAX_ATTEMPTS} ` +
      `provider=${providerLabel} model=${model} previousFailure=${lastEarlyReason || "unknown"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Image generation / edit
// Primary: OpenAI Subscription Responses API
// Fallback: Grok subscription via xAI Imagine (OpenAI-compatible images API)
// ---------------------------------------------------------------------------

type ImageModalityOptions = {
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
  signal?: AbortSignal;
};

function isOpenAIImageProviderFailure(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    lower.includes("usage_limit") ||
    lower.includes("usage limit") ||
    lower.includes("rate limit") ||
    lower.includes("quota") ||
    lower.includes("insufficient_quota") ||
    lower.includes("billing") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("expired") ||
    lower.includes("authentication") ||
    lower.includes("not configured") ||
    lower.includes("no openai") ||
    lower.includes("openai subscription") ||
    lower.includes("provider_quota") ||
    lower.includes("codex image")
  ) {
    return true;
  }
  // HTTP status codes commonly returned when the OpenAI sub path is down.
  return /\b(401|402|403|429|500|502|503)\b/.test(msg);
}

function aspectRatioFromSize(size?: string): string | undefined {
  if (!size) return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(width, height);
  return `${width / d}:${height / d}`;
}

async function getGrokImageClient(): Promise<OpenAI> {
  const accessToken = await getGrokSubscriptionAccessToken();
  return getOpenAIClient(accessToken, GROK_SUBSCRIPTION_API_BASE_URL);
}

async function generateImageViaOpenAISubscription(
  prompt: string,
  options?: ImageModalityOptions,
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

  for (let attempt = 0; attempt < CODEX_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      log.warn(`codex image-gen retry attempt=${attempt}/${CODEX_MAX_ATTEMPTS - 1} model=${codexModel}`);
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
      response = await fetchCodexAttempt(fetchOptions, scope, codexModel, "image-gen", attempt, CODEX_MAX_ATTEMPTS);
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
      if (earlyFailure.retryable && attempt < CODEX_MAX_ATTEMPTS - 1) continue;
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

/**
 * Generate an image via xAI Imagine on the Grok subscription connector.
 * Uses the OpenAI-compatible Images API at api.x.ai/v1.
 */
export async function generateImageViaGrokSubscription(
  prompt: string,
  options?: ImageModalityOptions,
): Promise<{ buffer: Buffer; format: string }> {
  const client = await getGrokImageClient();
  const format = options?.outputFormat === "jpeg" || options?.outputFormat === "webp"
    ? options.outputFormat
    : "png";
  const aspectRatio = aspectRatioFromSize(options?.size);

  // xAI Imagine rejects OpenAI-style `size` (400 "Argument not supported: size").
  // Map caller size → aspect_ratio only; never forward size on the wire.
  const request: Record<string, unknown> = {
    model: GROK_IMAGE_MODEL,
    prompt,
    n: 1,
    response_format: "b64_json",
  };
  if (aspectRatio) request.aspect_ratio = aspectRatio;

  log.info("Generating image via Grok subscription (xAI Imagine)", {
    model: GROK_IMAGE_MODEL,
    requestedSize: options?.size,
    aspectRatio,
  });

  const response = await client.images.generate(request as any, {
    signal: options?.signal,
  } as any);

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Grok image generation completed but no image data was returned");
  }

  return {
    buffer: Buffer.from(b64, "base64"),
    format,
  };
}

/**
 * Generate an image. Tries OpenAI subscription first; on provider failure falls
 * back to Grok subscription / xAI Imagine so image tools keep working when the
 * OpenAI sub is exhausted or unavailable.
 */
export async function generateImageViaSubscription(
  prompt: string,
  options?: ImageModalityOptions,
): Promise<{ buffer: Buffer; format: string }> {
  try {
    return await generateImageViaOpenAISubscription(prompt, options);
  } catch (err) {
    if (!isOpenAIImageProviderFailure(err)) throw err;
    log.warn("OpenAI image generation failed; falling back to Grok subscription", {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      return await generateImageViaGrokSubscription(prompt, options);
    } catch (fallbackErr) {
      const primary = err instanceof Error ? err.message : String(err);
      const fallback = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(
        `Image generation failed on OpenAI subscription (${primary}); Grok fallback also failed (${fallback})`,
      );
    }
  }
}

async function editImageViaOpenAISubscription(
  imageBuffers: Array<{ buffer: Buffer; mediaType: string }>,
  prompt: string,
  options?: ImageModalityOptions,
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

  for (let attempt = 0; attempt < CODEX_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      log.warn(`codex image-edit retry attempt=${attempt}/${CODEX_MAX_ATTEMPTS - 1} model=${codexModel}`);
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
      response = await fetchCodexAttempt(fetchOptions, scope, codexModel, "image-edit", attempt, CODEX_MAX_ATTEMPTS);
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
      if (earlyFailure.retryable && attempt < CODEX_MAX_ATTEMPTS - 1) continue;
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

/**
 * Edit images via xAI Imagine on the Grok subscription connector.
 * Uses the OpenAI-compatible Images Edit API at api.x.ai/v1.
 */
export async function editImageViaGrokSubscription(
  imageBuffers: Array<{ buffer: Buffer; mediaType: string }>,
  prompt: string,
  options?: ImageModalityOptions,
): Promise<{ buffer: Buffer; format: string }> {
  if (!imageBuffers.length) {
    throw new Error("Grok image edit requires at least one source image");
  }

  const client = await getGrokImageClient();
  const format = options?.outputFormat === "jpeg" || options?.outputFormat === "webp"
    ? options.outputFormat
    : "png";
  const aspectRatio = aspectRatioFromSize(options?.size);

  const files = await Promise.all(
    imageBuffers.map(async (img, index) => {
      const imageExt = img.mediaType.includes("jpeg") || img.mediaType.includes("jpg")
        ? "jpg"
        : img.mediaType.includes("webp")
          ? "webp"
          : "png";
      return toFile(img.buffer, `source-${index}.${imageExt}`, {
        type: img.mediaType || `image/${imageExt === "jpg" ? "jpeg" : imageExt}`,
      });
    }),
  );

  // xAI Imagine rejects OpenAI-style `size` (400 "Argument not supported: size").
  // Map caller size → aspect_ratio only; never forward size on the wire.
  const request: Record<string, unknown> = {
    model: GROK_IMAGE_MODEL,
    image: files.length === 1 ? files[0] : files,
    prompt,
    n: 1,
    response_format: "b64_json",
  };
  if (aspectRatio) request.aspect_ratio = aspectRatio;

  log.info("Editing image via Grok subscription (xAI Imagine)", {
    model: GROK_IMAGE_MODEL,
    sourceCount: imageBuffers.length,
    requestedSize: options?.size,
    aspectRatio,
  });

  const response = await client.images.edit(request as any, {
    signal: options?.signal,
  } as any);

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("Grok image edit completed but no image data was returned");
  }

  return {
    buffer: Buffer.from(b64, "base64"),
    format,
  };
}

/**
 * Edit/combine images. Tries OpenAI subscription first; on provider failure
 * falls back to Grok subscription / xAI Imagine.
 */
export async function editImageViaSubscription(
  imageBuffers: Array<{ buffer: Buffer; mediaType: string }>,
  prompt: string,
  options?: ImageModalityOptions,
): Promise<{ buffer: Buffer; format: string }> {
  try {
    return await editImageViaOpenAISubscription(imageBuffers, prompt, options);
  } catch (err) {
    if (!isOpenAIImageProviderFailure(err)) throw err;
    log.warn("OpenAI image edit failed; falling back to Grok subscription", {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      return await editImageViaGrokSubscription(imageBuffers, prompt, options);
    } catch (fallbackErr) {
      const primary = err instanceof Error ? err.message : String(err);
      const fallback = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(
        `Image edit failed on OpenAI subscription (${primary}); Grok fallback also failed (${fallback})`,
      );
    }
  }
}
