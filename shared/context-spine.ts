export type ContextCallType = "full" | "world" | "internal" | "none";

export type LlmMode = "text" | "voice";

export type SourceType = "static" | "dynamic" | "placeholder";

export type FreshnessPolicy = "rarely" | "per-session" | "real-time" | "never";

export type ContextLayer = "kernel" | "state" | "instructions" | "reference";

export type ContextReferenceStatus = "included" | "referenced" | "omitted" | "degraded";

export interface ContextInstructionGroupMetadata {
  id: string;
  title: string;
  status: ContextReferenceStatus;
  sectionIds: string[];
  tokenCount: number;
}

export interface ContextReferenceMetadata {
  id: string;
  title: string;
  status: ContextReferenceStatus;
  reason: string;
}

export interface RequiredContextReferenceMetadata {
  id: "coding_instructions" | "root_agents" | "subdir_agents" | "design_md";
  label: string;
  required: boolean;
  loaded: boolean;
  source?: string;
  evidence?: string[];
}

export interface CodingContextMetadata {
  alwaysOn: true;
  requiredReferences: RequiredContextReferenceMetadata[];
  proof?: {
    impact?: string[];
    changeScope?: string[];
    build?: string[];
    prTarget?: string;
  };
}

export interface SpineSection {
  id: string;
  title: string;
  parentId: string | null;
  sourceType: SourceType;
  freshnessPolicy: FreshnessPolicy;
  priority: number;
  enabled: boolean;
}

export interface ResolvedSection extends SpineSection {
  content: string;
  tokenCount: number;
  resolvedAt: string;
  children: ResolvedSection[];
}

export interface ResolvedSpine {
  callType: ContextCallType;
  llmMode: LlmMode;
  sections: ResolvedSection[];
  metadata: SpineMetadata;
}

export interface SpineMetadata {
  totalTokens: number;
  sectionCount: number;
  activeSectionCount: number;
  placeholderCount: number;
  assembledAt: string;
  callType: ContextCallType;
  llmMode: LlmMode;
  sessionKey: string | null;
  activity: string | null;
  modelTier: string | null;
  modelId: string | null;
  contextWindow: number | null;
  includeSections?: string[];
  excludeSections?: string[];
  /** Per-section token counts keyed by section ID. */
  sectionTokenCounts?: Record<string, number>;
  /** Selected instruction groups, derived from orientation/context flags and section metadata. */
  instructionGroups?: ContextInstructionGroupMetadata[];
  /** Heavy documentation/reference sections intentionally represented as pointers. */
  references?: ContextReferenceMetadata[];
  /** Runtime coding context invariant: always-on instructions plus loaded/missing required references. */
  codingContext?: CodingContextMetadata;
}

/**
 * One tool's serialized schema size, sourced from the live tool registry
 * (`getToolSchemas`). Truthful by construction: it reuses the exact schemas the
 * chat path sends rather than a hand-maintained copy.
 */
export interface WireToolSchemaEntry {
  name: string;
  category: string;
  chars: number;
  /** chars/3.5 estimate. */
  tokens: number;
  /** True when this entry is an alias schema (extra wire cost the registry ships). */
  isAlias: boolean;
}

/**
 * Latest real model-boundary payload captured for the requesting user. Scoped to
 * the principal so one user never sees another user's captured prompt.
 */
export interface WireBoundaryCaptureView {
  capturedAt: string;
  provider: string;
  model: string;
  activity: string | null;
  /** chars/3.5 estimates of the captured outbound payload components. */
  systemPromptTokens: number;
  toolSchemaTokens: number;
  conversationTokens: number;
  attributableTokens: number;
  /** Provider-measured input tokens for the captured call, when reported. */
  providerInputTokens: number | null;
  providerCacheReadTokens: number | null;
  /**
   * providerInputTokens - attributableTokens, clamped >= 0. The SDK harness plus
   * system-reminder envelopes plus tokenizer overhead — injected at the boundary,
   * not authored in Mantra code, so it is measured as a remainder.
   */
  harnessAndRemindersTokens: number | null;
  /** May be cumulative across a multi-turn session for some providers. */
  providerTokensMayBeCumulative: boolean;
  systemPromptExcerpt: string;
  systemPromptExcerptTruncated: boolean;
}

/**
 * Truthful wire-payload breakdown for the Context viewer: what the model actually
 * receives, not just the rendered spine template.
 */
export interface ContextWirePayload {
  /** Token estimator identity for every estimated value below. */
  estimator: string;
  spine: { tokens: number; chars: number };
  toolSchemas: {
    count: number;
    aliasCount: number;
    totalTokens: number;
    totalChars: number;
    tools: WireToolSchemaEntry[];
  };
  /** Statically attributable estimated tokens (spine + tool schemas), no live call required. */
  estimatedAttributableTokens: number;
  /** Latest real boundary capture for this user, or null when none recorded yet. */
  capture: WireBoundaryCaptureView | null;
  /** Explains SDK-injected components (harness, system-reminders) not authored in Mantra code. */
  sdkInjectedNote: string;
}

export interface ContextRequest {
  callType: ContextCallType;
  llmMode: LlmMode;
  sessionKey?: string | null;
  sessionId?: string;
  modelTier?: string | null;
  activity?: string | null;
  toolDefinitions?: Array<{ name: string; description: string }> | null;
  conversationHistory?: Array<{ role: string; content: string }> | null;
  memoryQuery?: string | null;
  includeSections?: string[];
  excludeSections?: string[];
  /** Current user message text — passed synchronously to avoid storage race on first turn. */
  currentMessage?: string;
  /** Prebuilt, principal-scoped meeting packet rendered only for meeting sessions. */
  meetingContext?: string;
}

export interface SpineSectionConfig {
  id: string;
  title: string;
  parentId: string | null;
  sourceType: SourceType;
  freshnessPolicy: FreshnessPolicy;
  priority: number;
  includedIn: ContextCallType[];
  cacheTtlMs?: number;
  /** If true, this section is always included and cannot be excluded by context flags. */
  bootstrap?: boolean;
  /** If true, this section is included by default (when no explicit context flags are set). */
  defaultIncluded?: boolean;
  /** Context architecture layer used for routing, observability, and UI grouping. */
  layer?: ContextLayer;
  /** Semantic instruction group this section belongs to, if any. */
  instructionGroupId?: string;
  /** If true, render compact retrieval guidance by default instead of heavy documentation. */
  referenceOnly?: boolean;
  /** Soft budget for default rendering. Resolvers own graceful compression. */
  maxDefaultTokens?: number;
}

/** Session-level context section flags. Keys are section IDs, values indicate include (true) or exclude (false). */
export type ContextFlags = Record<string, boolean>;
