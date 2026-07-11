import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { resolveModelForActivity, ACTIVITY_FRAMING, ACTIVITY_CHAT, type ActivityId, type ModelRoutingDecision } from "./job-profiles";
import { getMaxOutputTokens, getModel, supportsSelectableEffort } from "./model-registry";
import { resolveOpenAIReasoningEffort, type OpenAIReasoningEffort } from "./thinking-config";
import { withTimeout, STREAM_FINAL_MESSAGE_TIMEOUT_MS } from "./timeout";
import { createLogger } from "./log";
import { getSecretSync, onSecretChange } from "./secrets-store";
import type { ToolDefinition } from "@shared/models/tools";
import { createNamedSystemPrincipal } from "./principal";
import { runWithPrincipal } from "./principal-context";

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

function getOpenAIClient(): OpenAI {
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
  reasoning?: { effort?: OpenAIReasoningEffort; summary?: "detailed" | "concise" | "auto" };
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
  output?: Array<{ type: string; id?: string; content?: Array<{ type: string; text?: string }> }>;
  item?: { type?: string; id?: string; name?: string; call_id?: string; arguments?: string };
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } };
  response?: { usage?: { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } };
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

function getAnthropicClient(): Anthropic {
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
  signal?: AbortSignal;
  tools?: ToolDefinition[];
  /**
   * Resolved tier thinking config. When provided, effort-capable OpenAI models
   * (registry selectableEffort) receive a mapped reasoning effort. Omitted =
   * provider default behavior (no effort sent).
   */
  thinking?: import("./thinking-config").ResolvedThinking;
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
  const e = err as { name?: string; message?: string; code?: string; status?: number } | null;
  return {
    name: e?.name || "Error",
    message: e?.message || String(err),
    code: e?.code,
    status: e?.status,
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
        status: params.status,
        routing: params.routing,
        error: params.error,
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

export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const activity = options.activity || options.metadata?.activity || ACTIVITY_FRAMING;
  const routing = options.routingDecision ?? resolveModelForActivity(activity, { model: options.model, overrideReason: options.overrideReason });
  const { provider, model } = routing;
  const msgCount = options.messages.length;
  const start = Date.now();
  const requestContent = buildRequestContent(options.messages);
  let result: ChatCompletionResult | undefined;

  if (!options.metadata) log.warn(`chatCompletion missing metadata provider=${provider} model=${model} activity=${activity}`);
  log.debug(`chatCompletion provider=${provider} model=${model} activity=${routing.activity} tier=${routing.tier} source=${routing.source} configHash=${routing.configHash} messages=${msgCount} maxTokens=${options.maxTokens ?? "default"} jsonMode=${!!options.jsonMode}`);

  try {
    result = provider === "anthropic"
      ? await anthropicCompletion(model, options)
      : provider === "claude-cli"
        ? await claudeCliCompletion(model, options)
        : provider === "openai-subscription"
          ? await openaiSubscriptionCompletion(model, options)
          : await openaiCompletion(model, options);

    result = { ...result, metadata: { ...(result.metadata || {}), routing, trackedAtBoundary: true } };
    const elapsed = Date.now() - start;
    const usage = result.usage;
    log.debug(`chatCompletion done in ${elapsed}ms provider=${provider} model=${model} activity=${routing.activity} tier=${routing.tier} configHash=${routing.configHash} prompt=${usage?.promptTokens ?? "?"} completion=${usage?.completionTokens ?? "?"} total=${usage?.totalTokens ?? "?"}`);
    await recordInference({ startTime: start, routing, metadata: options.metadata, status: "success", usage, requestContent, responseContent: result.content, signal: options.signal });
    return result;
  } catch (err: any) {
    const elapsed = Date.now() - start;
    const status: InferenceStatus = isAbortError(err, options.signal) ? "aborted" : "error";
    const errorMetadata = serializeModelError(err);
    log.error(`chatCompletion ${status.toUpperCase()} in ${elapsed}ms provider=${provider} model=${model} activity=${routing.activity} tier=${routing.tier} configHash=${routing.configHash}: ${err.message}`);
    await recordInference({ startTime: start, routing, metadata: options.metadata, status, usage: result?.usage, requestContent, responseContent: result?.content, error: errorMetadata, signal: options.signal });
    throw enrichModelError(err, routing, options.metadata);
  }
}

function usesMaxCompletionTokens(model: string): boolean {
  return model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4") || model.startsWith("gpt-5");
}

async function openaiCompletion(model: string, options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  // Effort-capable models (GPT-5.6 family) use the Responses API so the tier
  // thinking config can map onto a reasoning effort.
  if (supportsSelectableEffort(model)) {
    return openaiResponsesCompletion(model, options);
  }

  const client = getOpenAIClient();

  const params: any = {
    model,
    messages: options.messages.map(m => ({
      role: m.role,
      content: m.content,
    })),
  };

  if (options.maxTokens) {
    if (usesMaxCompletionTokens(model)) {
      params.max_completion_tokens = options.maxTokens;
    } else {
      params.max_tokens = options.maxTokens;
    }
  }
  if (options.temperature !== undefined) params.temperature = options.temperature;
  if (options.jsonMode) params.response_format = { type: "json_object" };

  const requestOptions: Record<string, any> = {};
  if (options.signal) requestOptions.signal = options.signal;

  const response = await client.chat.completions.create(params, requestOptions);
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
}

/**
 * Direct OpenAI Responses API completion — used for models with a selectable
 * reasoning effort (registry `selectableEffort`). Reuses the Responses-format
 * message and tool converters shared with the Codex subscription path.
 */
async function openaiResponsesCompletion(model: string, options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const client = getOpenAIClient();
  const { instructions, input } = buildCodexInput(options.messages);

  const params: Record<string, any> = {
    model,
    instructions,
    input,
    store: false,
  };
  if (options.maxTokens) params.max_output_tokens = options.maxTokens;
  if (options.jsonMode) params.text = { format: { type: "json_object" } };
  if (options.tools && options.tools.length > 0) {
    params.tools = convertToolsToCodexResponses(options.tools);
  }
  const effort = resolveOpenAIReasoningEffort(options.thinking, "responses");
  if (effort) params.reasoning = { effort };

  const requestOptions: Record<string, any> = {};
  if (options.signal) requestOptions.signal = options.signal;

  const response: any = await client.responses.create(params as any, requestOptions);
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
}

/**
 * Retry schedule for transient Codex 5xx / network failures.
 * OpenAI's Codex Responses endpoint occasionally returns brief 500s; the
 * Anthropic provider already retries `overloaded_error` with the same shape.
 */
const CODEX_RETRY_DELAYS_MS = [1000, 2000, 4000];
const CODEX_MAX_ATTEMPTS = CODEX_RETRY_DELAYS_MS.length + 1;

class CodexAbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

class CodexUnavailableError extends Error {
  status: number;
  attempts: number;
  bodySnippet: string;
  constructor(status: number, attempts: number, bodySnippet: string) {
    super(
      status > 0
        ? `Codex temporarily unavailable after ${attempts} attempts — last status: ${status}: ${bodySnippet.slice(0, 200)}`
        : `Codex temporarily unavailable after ${attempts} attempts — last error: ${bodySnippet.slice(0, 200)}`,
    );
    this.name = "CodexUnavailableError";
    this.status = status;
    this.attempts = attempts;
    this.bodySnippet = bodySnippet;
  }
}

async function codexBackoffSleep(attempt: number, signal?: AbortSignal): Promise<void> {
  // Bail before scheduling the timer if the run has already been cancelled,
  // so a pre-aborted signal never waits the full delay.
  if (signal?.aborted) {
    throw new CodexAbortedError();
  }
  const delayMs = CODEX_RETRY_DELAYS_MS[attempt - 1];
  const aborted = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), delayMs);
    signal?.addEventListener(
      "abort",
      () => { clearTimeout(timer); resolve(true); },
      { once: true },
    );
  });
  if (aborted || signal?.aborted) {
    throw new CodexAbortedError();
  }
}

/**
 * Sentinel thrown from the SSE-consumption loop when the stream dies before
 * any real event has been yielded downstream. Retry-eligible; never escapes
 * the retry loop in the calling function.
 */
class CodexEarlyStreamFailure extends Error {
  reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "CodexEarlyStreamFailure";
    this.reason = reason;
  }
}

/**
 * Issue a POST to the Codex responses endpoint with retry on transient
 * 5xx / network errors. Returns a Response with `status === 429` or any
 * non-5xx status untouched (callers handle those). 429 is intentionally
 * NOT retried — that's a quota signal, not a blip.
 */
async function fetchCodexWithRetry(
  fetchOptions: RequestInit,
  signal: AbortSignal | undefined,
  model: string,
  context: string,
): Promise<Response> {
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 0; attempt < CODEX_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      log.warn(
        `codex ${context} retry attempt=${attempt}/${CODEX_MAX_ATTEMPTS - 1} model=${model} ` +
        `lastStatus=${lastStatus} delay=${CODEX_RETRY_DELAYS_MS[attempt - 1]}ms`,
      );
      await codexBackoffSleep(attempt, signal);
    }

    let response: Response;
    try {
      response = await fetch(OPENAI_SUBSCRIPTION_CODEX_RESPONSES_URL, fetchOptions);
    } catch (err: any) {
      if (err.name === "AbortError" || err.code === "ERR_CANCELED" || signal?.aborted) {
        throw err;
      }
      lastStatus = 0;
      lastBody = err?.message || String(err);
      if (attempt < CODEX_MAX_ATTEMPTS - 1) continue;
      log.error(
        `codex ${context} give up after ${CODEX_MAX_ATTEMPTS} attempts model=${model} ` +
        `network error: ${lastBody.slice(0, 200)}`,
      );
      throw new CodexUnavailableError(0, CODEX_MAX_ATTEMPTS, lastBody);
    }

    if (response.status >= 500 && response.status < 600) {
      lastStatus = response.status;
      lastBody = await response.text().catch(() => "unknown error");
      if (attempt < CODEX_MAX_ATTEMPTS - 1) continue;
      log.error(
        `codex ${context} give up after ${CODEX_MAX_ATTEMPTS} attempts model=${model} ` +
        `status=${lastStatus}: ${lastBody.slice(0, 200)}`,
      );
      throw new CodexUnavailableError(lastStatus, CODEX_MAX_ATTEMPTS, lastBody);
    }

    return response;
  }

  // Defensive — loop always either returns or throws.
  throw new CodexUnavailableError(lastStatus, CODEX_MAX_ATTEMPTS, lastBody);
}

async function openaiSubscriptionCompletion(model: string, options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const accessToken = await getOpenAISubscriptionAccessToken();

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
  if (options.thinking && supportsSelectableEffort(model)) {
    const effort = resolveOpenAIReasoningEffort(options.thinking, "codex");
    if (effort) body.reasoning = { effort };
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

  // Retry both initial-fetch failures (handled by fetchCodexWithRetry) AND
  // protocol-level failures (`response.failed`) that occur before the
  // collected response is returned. Since this entry point is non-streaming
  // from the caller's perspective, we never expose partial content, so
  // retrying on `response.failed` is always safe.
  let lastFailedAttempts = 0;
  for (let attempt = 0; attempt < CODEX_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      log.warn(
        `codex completion retry attempt=${attempt}/${CODEX_MAX_ATTEMPTS - 1} model=${codexModel} ` +
        `reason=response.failed delay=${CODEX_RETRY_DELAYS_MS[attempt - 1]}ms`,
      );
      try {
        await codexBackoffSleep(attempt, signal);
      } catch {
        throw new CodexAbortedError();
      }
    }

    let response: Response;
    try {
      response = await fetchCodexWithRetry(fetchOptions, signal, codexModel, "completion");
    } catch (err: any) {
      if (err.name === "AbortError" || err.code === "ERR_CANCELED" || signal?.aborted) throw err;
      throw err;
    }

    if (response.status === 429) {
      throw new Error("OpenAI subscription rate limit reached. Your ChatGPT subscription limit has been hit. Please wait and try again.");
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "unknown error");
      throw new Error(`Codex responses error ${response.status}: ${text.slice(0, 200)}`);
    }

    let content = "";
    let streamUsage: { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } | undefined;
    let earlyFailure = false;

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

        let chunk: CodexResponsesChunk;
        try { chunk = JSON.parse(data); } catch { continue; }

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

        if (chunk.type === "response.output_text.delta" && typeof chunk.delta === "string") {
          content += chunk.delta;
        } else if (chunk.type === "response.failed") {
          earlyFailure = true;
          break outer;
        }
      }
    }

    if (earlyFailure) {
      lastFailedAttempts = attempt + 1;
      if (attempt < CODEX_MAX_ATTEMPTS - 1) continue;
      log.error(
        `codex completion give up after ${CODEX_MAX_ATTEMPTS} attempts model=${codexModel} ` +
        `reason=response.failed`,
      );
      throw new CodexUnavailableError(0, CODEX_MAX_ATTEMPTS, "response.failed");
    }

    if (!content) {
      log.warn(`openai-subscription completion: empty content for model=${codexModel}`);
    }

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
  }

  // Defensive — loop always either returns or throws.
  throw new CodexUnavailableError(0, lastFailedAttempts || CODEX_MAX_ATTEMPTS, "response.failed");
}


async function claudeCliCompletion(model: string, options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const { cliSdkCompletion } = await import("./cli-sdk-adapter");
  return cliSdkCompletion(model, options);
}

async function anthropicCompletion(model: string, options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const client = getAnthropicClient();

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

export function getModelInfo(activity: ActivityId = ACTIVITY_FRAMING): { provider: string; model: string; full: string } {
  const full = resolveModelForActivity(activity).modelString;
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
  toolExecutor?: (name: string, args: Record<string, unknown>) => Promise<{ result: string; error?: boolean; sideEffectOnly?: boolean }>;
  maxTokens?: number;
  temperature?: number;
  /** @deprecated Pass `thinking` instead. Kept for back-compat with existing callers. */
  thinkingBudget?: number;
  thinking?: import("./thinking-config").ResolvedThinking;
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
  | { type: "tool_result_resolved"; toolCallId: string; toolName: string; result: string; error?: boolean }
  | { type: "usage"; usage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; visibleOutputTokens?: number }; model?: string; stopReason: string; metadata?: Record<string, unknown> }
  | { type: "error"; error: string }
  | { type: "keepalive"; reason: string }
  | { type: "ttft_breakdown"; breakdown: TtftBreakdown }
  | { type: "connected"; metadata?: Record<string, unknown> }
  | { type: "request_sent"; metadata?: Record<string, unknown> };

export async function* chatCompletionStream(options: ChatCompletionStreamOptions): AsyncGenerator<StreamEvent> {
  const activity = options.activity || options.metadata?.activity || ACTIVITY_CHAT;
  const routing = options.routingDecision ?? resolveModelForActivity(activity, { model: options.model, overrideReason: options.overrideReason });
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
      throw new Error(event.error);
    } else if (event.type === "thinking_delta") {
      if (firstThinkingAt === null) firstThinkingAt = Date.now();
    }

    if (event.type === "usage") {
      yield {
        ...event,
        metadata: {
          ...(event.metadata || {}),
          routing,
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
  await recordInference({ startTime: t0, routing, metadata: options.metadata, status: "success", usage: streamUsage, requestContent, responseContent, signal: options.signal });
  } catch (err: unknown) {
    const status: InferenceStatus = isAbortError(err, options.signal) ? "aborted" : (responseContent ? "partial" : "error");
    await recordInference({ startTime: t0, routing, metadata: options.metadata, status, usage: streamUsage, requestContent, responseContent, error: serializeModelError(err), signal: options.signal });
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
  const seenSequenceNumbers = new Set<number>();

  try {
    const accessToken = await getOpenAISubscriptionAccessToken();

    const modelInfo = getModel(model);
    const codexModel = modelInfo?.codexModelId ?? model;

    const { instructions, input } = buildCodexInput(options.messages);
    const body: CodexResponsesRequest = {
      model: codexModel,
      instructions,
      input,
      store: false,
      stream: true,
      // ChatGPT subscription reasoning summaries are rendered as visible
      // thinking blocks in chat. Use auto as the middle ground: richer than
      // concise, without forcing the oversized detailed internal-process cards.
      reasoning: { summary: "auto" },
    };
    if (supportsSelectableEffort(model)) {
      const codexEffort = resolveOpenAIReasoningEffort(options.thinking, "codex");
      if (codexEffort) body.reasoning = { effort: codexEffort, summary: "auto" };
    }

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

    // Outer retry loop covers initial-fetch failures (delegated to
    // fetchCodexWithRetry for HTTP 5xx/network) AND early `response.failed`
    // chunks — but only while no real event has been yielded downstream yet.
    streamRetryLoop: for (let attempt = 0; attempt < CODEX_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        log.warn(
          `codex stream retry attempt=${attempt}/${CODEX_MAX_ATTEMPTS - 1} model=${codexModel} ` +
          `reason=${lastEarlyReason || "early-failure"} delay=${CODEX_RETRY_DELAYS_MS[attempt - 1]}ms`,
        );
        try {
          await codexBackoffSleep(attempt, signal);
        } catch {
          log.debug(`openai-subscription stream aborted during early-failure backoff model=${model}`);
          yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
          return;
        }
      }

      let response: Response;
      try {
        response = await fetchCodexWithRetry(fetchOptions, signal, codexModel, "stream");
      } catch (err: any) {
        if (err.name === "AbortError" || err.code === "ERR_CANCELED" || signal?.aborted) {
          log.debug(`openai-subscription stream aborted during fetch retry model=${model}`);
          yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
          return;
        }
        yield { type: "error", error: err?.message || "Codex stream error" };
        return;
      }
      if (response.status === 429) {
        yield { type: "error", error: "OpenAI subscription rate limit reached. Your ChatGPT subscription limit has been hit. Please wait and try again." };
        return;
      }
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "unknown error");
        yield { type: "error", error: `Codex responses error ${response.status}: ${text.slice(0, 200)}` };
        return;
      }

      // Reset per-attempt parser state so a retry starts clean (no leftover
      // tool-call fragments from a failed attempt).
      stopReason = "end_turn";
      streamUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      pendingToolCalls.clear();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let earlyFailure = false;

      sseLoop: while (true) {
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

          let chunk: CodexResponsesChunk;
          try { chunk = JSON.parse(data); } catch { continue; }

          if (typeof chunk.sequence_number === "number") {
            if (seenSequenceNumbers.has(chunk.sequence_number)) {
              log.warn(`openai-subscription duplicate stream event ignored model=${model} sequence=${chunk.sequence_number} type=${chunk.type}`);
              continue;
            }
            seenSequenceNumbers.add(chunk.sequence_number);
          }
          eventCount++;

          // Handle `response.failed` BEFORE any consumer yields so an early
          // protocol failure can be retried invisibly.
          if (chunk.type === "response.failed") {
            if (!yieldedRealEvent) {
              earlyFailure = true;
              lastEarlyReason = "response.failed";
              break sseLoop;
            }
            yield { type: "error", error: "Codex response failed" };
            return;
          }

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
            stopReason = pendingToolCalls.size > 0 ? "tool_use" : "end_turn";
          } else if (chunk.type === "response.incomplete") {
            stopReason = "max_tokens";
          }
        }
      }

      if (earlyFailure) {
        if (attempt < CODEX_MAX_ATTEMPTS - 1) continue streamRetryLoop;
        log.error(
          `codex stream give up after ${CODEX_MAX_ATTEMPTS} attempts model=${codexModel} ` +
          `reason=${lastEarlyReason}`,
        );
        yield {
          type: "error",
          error: `Codex temporarily unavailable after ${CODEX_MAX_ATTEMPTS} attempts — last error: ${lastEarlyReason}`,
        };
        return;
      }

      // Successful end-of-stream — exit retry loop.
      break;
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
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
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
  const client = getAnthropicClient();

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
  let eventCount = 0;

  try {
    const client = getOpenAIClient();
    const { instructions, input } = buildCodexInput(options.messages);

    const params: Record<string, any> = {
      model,
      instructions,
      input,
      store: false,
      stream: true,
    };
    if (options.maxTokens) params.max_output_tokens = options.maxTokens;
    if (options.tools && options.tools.length > 0) {
      params.tools = convertToolsToCodexResponses(options.tools);
    }
    const effort = resolveOpenAIReasoningEffort(options.thinking, "responses");
    if (effort) params.reasoning = { effort };

    let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" = "end_turn";
    let streamUsage: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens?: number; reasoningTokens?: number; visibleOutputTokens?: number } = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const pendingToolCalls = new Map<string, { callId: string; name: string; argsAccumulator: string; reasoningEmitted: boolean }>();
    let connectedEmitted = false;

    const stream: any = await client.responses.create(params as any, { signal: options.signal });

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
      } else if (chunk.type === "response.failed") {
        const failMsg = chunk.response?.error?.message || "OpenAI response failed";
        log.error(`openai responses stream FAILED model=${model}: ${failMsg}`);
        yield { type: "error", error: failMsg };
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
  } catch (err: any) {
    if (err?.name === "AbortError" || err?.code === "ERR_CANCELED" || options.signal?.aborted) {
      log.debug(`openai responses stream aborted model=${model}`);
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
    } else if (err?.status === 429 || (err?.message && err.message.includes("rate limit"))) {
      log.error(`openai responses stream rate limit model=${model}`);
      yield { type: "error", error: "OpenAI rate limit reached. Please wait and try again." };
    } else {
      log.error(`openai responses stream ERROR model=${model}: ${err?.message}`);
      yield { type: "error", error: err?.message || "OpenAI stream error" };
    }
  }
}

async function* openaiStream(model: string, options: ChatCompletionStreamOptions): AsyncGenerator<StreamEvent> {
  // Effort-capable models (GPT-5.6 family) use the Responses API so the tier
  // thinking config can map onto a reasoning effort.
  if (supportsSelectableEffort(model)) {
    yield* openaiResponsesStream(model, options);
    return;
  }

  const client = getOpenAIClient();

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

  if (options.maxTokens) {
    if (usesMaxCompletionTokens(model)) {
      params.max_completion_tokens = options.maxTokens;
    } else {
      params.max_tokens = options.maxTokens;
    }
  }
  if (options.temperature !== undefined) params.temperature = options.temperature;
  if (options.tools && options.tools.length > 0) {
    params.tools = convertToolsToOpenAI(options.tools);
  }

  try {
    const stream = await client.chat.completions.create(params, {
      signal: options.signal,
    });

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
  } catch (err: any) {
    if (err.name === "AbortError" || err.code === "ERR_CANCELED" || options.signal?.aborted) {
      log.debug(`openai stream aborted model=${model}`);
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, stopReason: "end_turn" };
    } else {
      log.error(`openai stream ERROR model=${model}: ${err.message}`);
      yield { type: "error", error: err.message || "OpenAI stream error" };
    }
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
  const modelString = resolveModelForActivity(ACTIVITY_FRAMING).modelString;
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

    let response: Response;
    try {
      response = await fetchCodexWithRetry(fetchOptions, signal, codexModel, "image-gen");
    } catch (err: any) {
      if (err.name === "AbortError" || signal?.aborted) throw err;
      throw err;
    }

    if (response.status === 429) {
      throw new Error("OpenAI subscription rate limit reached for image generation. Please wait and try again.");
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "unknown error");
      throw new Error(`Codex image generation error ${response.status}: ${text.slice(0, 300)}`);
    }

    let base64Result = "";
    let earlyFailure = false;
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

        if (chunk.type === "response.failed") {
          earlyFailure = true;
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
      if (attempt < CODEX_MAX_ATTEMPTS - 1) continue;
      throw new CodexUnavailableError(0, CODEX_MAX_ATTEMPTS, "response.failed during image generation");
    }

    if (!base64Result) {
      throw new Error("Image generation returned empty result — no image data in response.");
    }

    const format = options?.outputFormat || "png";
    return { buffer: Buffer.from(base64Result, "base64"), format };
  }

  throw new CodexUnavailableError(0, CODEX_MAX_ATTEMPTS, "image generation exhausted retries");
}

export async function editImageViaSubscription(
  imageBuffers: Array<{ buffer: Buffer; mediaType: string }>,
  prompt: string,
  options?: { size?: string; quality?: string; outputFormat?: string; signal?: AbortSignal }
): Promise<{ buffer: Buffer; format: string }> {
  const accessToken = await getOpenAISubscriptionAccessToken();
  const modelString = resolveModelForActivity(ACTIVITY_FRAMING).modelString;
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

    let response: Response;
    try {
      response = await fetchCodexWithRetry(fetchOptions, signal, codexModel, "image-edit");
    } catch (err: any) {
      if (err.name === "AbortError" || signal?.aborted) throw err;
      throw err;
    }

    if (response.status === 429) {
      throw new Error("OpenAI subscription rate limit reached for image editing. Please wait and try again.");
    }
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "unknown error");
      throw new Error(`Codex image edit error ${response.status}: ${text.slice(0, 300)}`);
    }

    let base64Result = "";
    let earlyFailure = false;
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

        if (chunk.type === "response.failed") {
          earlyFailure = true;
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
      if (attempt < CODEX_MAX_ATTEMPTS - 1) continue;
      throw new CodexUnavailableError(0, CODEX_MAX_ATTEMPTS, "response.failed during image editing");
    }

    if (!base64Result) {
      throw new Error("Image edit returned empty result — no image data in response.");
    }

    const format = options?.outputFormat || "png";
    return { buffer: Buffer.from(base64Result, "base64"), format };
  }

  throw new CodexUnavailableError(0, CODEX_MAX_ATTEMPTS, "image editing exhausted retries");
}
