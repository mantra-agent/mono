import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { DiagnosticChildMode, DiagnosticTimingKind, DiagnosticVisibility } from "../streaming-types";

export const chatSessions = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status").notNull().default("saved"),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    sessionKey: text("session_key"),
    vaultId: text("vault_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_sessions_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_sessions_account").on(table.accountId),
    index("idx_sessions_vault").on(table.vaultId),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("conversation_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    vaultId: text("vault_id"),
    role: text("role").notNull(),
    content: text("content").notNull(),
    thinking: text("thinking"),
    toolCalls: jsonb("tool_calls"),
    systemSteps: jsonb("system_steps"),
    segmentChronology: jsonb("segment_chronology"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index("idx_messages_scope_owner").on(table.scope, table.ownerUserId),
    index("idx_messages_account").on(table.accountId),
    index("idx_messages_session").on(table.sessionId),
  ],
);

export const insertSessionSchema = createInsertSchema(chatSessions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export type ChatStreamEventType =
  | "thinking"
  | "thinking_complete"
  | "delta"
  | "tool_call"
  | "tool_result"
  | "tool_use_pause"
  | "run_start"
  | "done"
  | "saved"
  | "error"
  | "model_info"
  | "title_updated"
  | "session_updated"
  | "session_status_changed"
  | "compacting"
  | "user_message"
  | "system_prompt_message"
  | "voice_xyz_response"
  | "voice_insight"
  | "system_step"
  | "voice_reconnect"
  | "child_session_block"
  | "cross_session"
  | "system_notice";

export type ErrorSeverity = "warning" | "error";

export interface SystemNotice {
  severity: ErrorSeverity;
  errorType: string;
  description: string;
  actionHint: string;
  terminationReason?: string;
  abortReason?: string;
  iterationsUsed?: number;
  durationMs?: number;
  toolCallCount?: number;
}

export interface ChildSessionBlockMeta {
  childSessionId: string;
  parentSessionId: string;
  role: string;
  planId?: string | null;
  planStepId?: string | null;
  planAttemptId?: string | number | null;
  planAttemptNumber?: number | null;
  model?: string | null;
  summary?: string | null;
  startedAt: string;
  updatedAt?: string | null;
  elapsedMs?: number | null;
  cost?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  spawnReason?: string | null;
  planPageRef?: string | null;
  error?: string | null;
}

export type CrossSessionDirection = "sibling" | "parent" | "child" | "direct";

export interface ContinuationCapsule {
  version: 1;
  initiator?: string;
  objective?: string;
  actions: string[];
  systemsTouched: string[];
  decisions: string[];
  stateChanges: string[];
  failures: string[];
  openLoops: string[];
  references: string[];
  resumePoint?: string;
  sourceMessageCount: number;
  sourceActionCount: number;
}

export interface CompactionMeta {
  type: "between_turn";
  summary: string;
  /** How `summary` was produced: LLM narrative (primary) or deterministic capsule (fallback/legacy). */
  summaryKind?: "narrative" | "capsule";
  /** Number of transcript segments that fell back to mechanical excerpts during narrative summarization. */
  degradedSegments?: number;
  capsuleVersion?: 1;
  capsule?: ContinuationCapsule;
  replacedMessageCount: number;
  keptMessageCount: number;
  archiveRefId?: string;
  archiveFormat?: "compaction.v1";
  archiveDownloadable?: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
  tokensSaved?: number;
  summaryLength: number;
  createdAt: string;
}

export interface CrossSessionMeta {
  fromSessionId: string;
  toSessionId: string;
  direction: CrossSessionDirection;
  chainId?: string;
  depth?: number;
  fromLabel?: string;
  toLabel?: string;
}

export type ExecutorStreamEventType =
  | "thinking"
  | "thinking_complete"
  | "delta"
  | "tool_call"
  | "tool_result"
  | "tool_use_pause"
  | "run_start"
  | "done"
  | "error"
  | "compacting"
  | "system_step"
  | "usage"
  | "ttft_breakdown";

export interface ExecutorTtftBreakdown {
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

export type CompactingStatus = "active" | "done" | "error";

export type TerminationReason =
  | "complete"
  | "aborted"
  | "error"
  | "circuit_breaker"
  | "yield_to_interactive";

export interface ProviderTransportErrorInfo {
  name?: string;
  message?: string;
  code?: string;
  errno?: string | number;
  syscall?: string;
  socket?: {
    localAddress?: string;
    localPort?: number;
    remoteAddress?: string;
    remotePort?: number;
    remoteFamily?: string;
    timeout?: number;
    bytesWritten?: number;
    bytesRead?: number;
  };
  cause?: ProviderTransportErrorInfo;
}

export interface ProviderTraceInfo {
  responseDate?: string;
  cfRay?: string;
  cfCacheStatus?: string;
  server?: string;
  via?: string;
  openaiProcessingMs?: string;
  envoyUpstreamServiceTime?: string;
}

export interface ProviderStreamProgressInfo {
  startedAt: string;
  observedAt: string;
  elapsedMs: number;
  headersMs?: number;
  firstEventMs?: number;
  firstEventAt?: string;
  lastEventMs?: number;
  lastEventAt?: string;
  eventCount: number;
  bytesReceived: number;
  lastEventType?: string;
  lastSequenceNumber?: number;
  terminalEventSeen: boolean;
  localAbort: boolean;
  localAbortReason?: string;
  timeToFirstEventTimedOut: boolean;
}

export interface ModelProviderFailureInfo {
  kind: string;
  provider: string;
  model?: string;
  runId?: string;
  sessionId?: string;
  phase: string;
  retryable: boolean;
  status: number;
  attempts: number;
  userMessage: string;
  providerCode?: string;
  providerType?: string;
  providerMessage?: string;
  providerParam?: string | null;
  eventType?: string;
  responseId?: string;
  responseStatus?: string;
  sequenceNumber?: number;
  incompleteReason?: string;
  clientRequestId?: string;
  providerRequestId?: string;
  transportError?: ProviderTransportErrorInfo;
  providerTrace?: ProviderTraceInfo;
  streamProgress?: ProviderStreamProgressInfo;
  providerEventFields?: string[];
  providerResponseFields?: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    reasoningTokens?: number;
  };
}

export type AssistantMessageState =
  | "streaming"
  | "complete"
  | "interrupted"
  | "failed";

export interface SystemStepRecord {
  id?: string;
  name: string;
  status: "done" | "error";
  elapsedMs?: number;
  parentId?: string;
  selfTimeMs?: number;
  startedAt?: number;
  endedAt?: number;
  detail?: string;
  metadata?: Record<string, unknown>;
  timingKind?: DiagnosticTimingKind;
  diagnosticVisibility?: DiagnosticVisibility;
  childMode?: DiagnosticChildMode;
  occurredAt?: number;
}

export interface ExecutorStreamEvent {
  type: ExecutorStreamEventType;
  content?: string;
  toolName?: string;
  toolCallId?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  error?: string;
  providerFailure?: ModelProviderFailureInfo;
  isError?: boolean;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  model?: string;
  stopReason?: string;
  status?: CompactingStatus;
  stepId?: string;
  step?: string;
  detail?: string;
  metadata?: Record<string, unknown>;
  elapsedMs?: number;
  parentId?: string;
  startedAt?: number;
  endedAt?: number;
  selfTimeMs?: number;
  timingKind?: DiagnosticTimingKind;
  diagnosticVisibility?: DiagnosticVisibility;
  childMode?: DiagnosticChildMode;
  occurredAt?: number;
  narrative?: string;
  terminationReason?: TerminationReason;
  iterationsUsed?: number;
  breakdown?: ExecutorTtftBreakdown;
}

interface ChatStreamEventBase {
  sessionKey: string;
  sessionId?: string;
  runId?: string;
  ts?: number;
}

export type ChatStreamEvent =
  | (ChatStreamEventBase & { type: "thinking"; content: string })
  | (ChatStreamEventBase & { type: "thinking_complete"; content: string })
  | (ChatStreamEventBase & { type: "delta"; content: string })
  | (ChatStreamEventBase & {
      type: "compacting";
      content: string;
      status?: CompactingStatus;
      stepId?: string;
    })
  | (ChatStreamEventBase & {
      type: "tool_call";
      toolName?: string;
      toolCallId: string;
      arguments?: Record<string, unknown>;
      narrative?: string;
      parentId?: string;
    })
  | (ChatStreamEventBase & {
      type: "tool_result";
      toolCallId: string;
      toolName?: string;
      result?: unknown;
      error?: string;
    })
  | (ChatStreamEventBase & { type: "tool_use_pause"; content?: string })
  | (ChatStreamEventBase & { type: "run_start"; runId: string })
  | (ChatStreamEventBase & {
      type: "done";
      messageId?: string;
      abortReason?: string;
      terminationReason?: string;
    })
  | (ChatStreamEventBase & { type: "saved"; messageId?: string })
  | (ChatStreamEventBase & { type: "error"; error: string; providerFailure?: ModelProviderFailureInfo })
  | (ChatStreamEventBase & {
      type: "model_info";
      model?: string;
      autoTier?: string;
      persona?: PersonaSnapshot;
    })
  | (ChatStreamEventBase & { type: "title_updated"; title: string })
  | (ChatStreamEventBase & {
      type: "session_updated";
      title?: string;
      topics?: string[];
    })
  | (ChatStreamEventBase & { type: "session_status_changed"; status: string })
  | (ChatStreamEventBase & { type: "user_message"; content: string })
  | (ChatStreamEventBase & { type: "system_prompt_message"; content: string })
  | (ChatStreamEventBase & { type: "voice_xyz_response"; content: string })
  | (ChatStreamEventBase & { type: "voice_insight"; content: string })
  | (ChatStreamEventBase & {
      type: "system_step";
      step: string;
      status: "started" | "done" | "error";
      elapsedMs?: number;
      detail?: string;
      stepId?: string;
      parentId?: string;
      startedAt?: number;
      endedAt?: number;
      selfTimeMs?: number;
      timingKind?: DiagnosticTimingKind;
      diagnosticVisibility?: DiagnosticVisibility;
      childMode?: DiagnosticChildMode;
      occurredAt?: number;
      metadata?: Record<string, unknown>;
    })
  | (ChatStreamEventBase & { type: "voice_reconnect"; reason: string })
  | (ChatStreamEventBase & {
      type: "child_session_block";
      block: ChildSessionBlockMeta;
    })
  | (ChatStreamEventBase & {
      type: "cross_session";
      cross: CrossSessionMeta;
      content: string;
    })
  | (ChatStreamEventBase & {
      type: "system_notice";
      severity: ErrorSeverity;
      notice: string;
    });

export type SessionType = "user" | "agent" | "autonomous" | "focus";

// Historical terminal outcome. `active` is legacy data only; live activity is
// derived from `status === "streaming"` / SessionManager current-turn state.
export type RunStatus = "active" | "resolved" | "failed";

export interface PageContextEntity {
  type: string;
  id: string;
  label?: string;
}

export interface PageContext {
  route: string;
  tab?: string;
  pageTitle?: string;
  subView?: string;
  entity?: PageContextEntity;
  state?: Record<string, string>;
}

const PC_MAX_ROUTE = 256;
const PC_MAX_TAB = 64;
const PC_MAX_TITLE = 200;
const PC_MAX_SUBVIEW = 120;
const PC_MAX_ENTITY_TYPE = 32;
const PC_MAX_ENTITY_ID = 128;
const PC_MAX_ENTITY_LABEL = 200;
export const PC_MAX_STATE_KEYS = 8;
export const PC_MAX_STATE_KEY_LEN = 32;
export const PC_MAX_STATE_VAL_LEN = 96;

export function normalizePageContext(input: unknown): PageContext | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  if (typeof o.route !== "string" || !o.route) return undefined;
  const out: PageContext = { route: o.route.slice(0, PC_MAX_ROUTE) };
  if (typeof o.tab === "string") out.tab = o.tab.slice(0, PC_MAX_TAB);
  if (typeof o.pageTitle === "string")
    out.pageTitle = o.pageTitle.slice(0, PC_MAX_TITLE);
  if (typeof o.subView === "string" && o.subView)
    out.subView = o.subView.slice(0, PC_MAX_SUBVIEW);
  if (o.entity && typeof o.entity === "object") {
    const e = o.entity as Record<string, unknown>;
    if (
      typeof e.type === "string" &&
      e.type &&
      typeof e.id === "string" &&
      e.id
    ) {
      out.entity = {
        type: e.type.slice(0, PC_MAX_ENTITY_TYPE),
        id: e.id.slice(0, PC_MAX_ENTITY_ID),
        label:
          typeof e.label === "string" && e.label
            ? e.label.slice(0, PC_MAX_ENTITY_LABEL)
            : undefined,
      };
    }
  }
  if (o.state && typeof o.state === "object" && !Array.isArray(o.state)) {
    const s: Record<string, string> = {};
    let n = 0;
    for (const [k, v] of Object.entries(o.state as Record<string, unknown>)) {
      if (n >= PC_MAX_STATE_KEYS) break;
      if (typeof k !== "string" || !k) continue;
      if (v === undefined || v === null) continue;
      const sv = typeof v === "string" ? v : String(v);
      if (!sv) continue;
      s[k.slice(0, PC_MAX_STATE_KEY_LEN)] = sv.slice(0, PC_MAX_STATE_VAL_LEN);
      n++;
    }
    if (n > 0) out.state = s;
  }
  return out;
}

interface FocusTraceBackRecipe {
  tool: string;
  example?: string;
  route: (id: string) => string;
}

const FOCUS_TRACE_BACK_RECIPES: Record<string, FocusTraceBackRecipe> = {
  person: {
    tool: "people",
    example: "people action=get id=<id>",
    route: (id) => `/people/${id}`,
  },
  project: {
    tool: "work",
    example: "work action=get_project id=<id>",
    route: (id) => `/projects?project=${encodeURIComponent(id)}`,
  },
  task: { tool: "tasks", route: () => `/work` },
  goal: {
    tool: "goals",
    example: "goals action=get id=<id>",
    route: (id) => `/goals/${id}`,
  },
  strategy: {
    tool: "strategy",
    example: "strategy action=get_strategy goalId=<id>",
    route: (id) => `/strategy/${id}`,
  },
  issue: {
    tool: "system",
    example: "system action=get_issue id=<id>",
    route: (id) => `/issues/${id}`,
  },
  note: {
    tool: "library",
    example: "library action=get_note id=<id>",
    route: (id) => `/info#notes?id=${id}`,
  },
  library_page: {
    tool: "library",
    example: "library action=get_library_page id=<id>",
    route: (id) => `/info#library?page=${id}`,
  },
  event: {
    tool: "meetings",
    example: "meetings action=get_metadata googleEventId=<id>",
    route: (id) => `/calendar?event=${id}`,
  },
  transaction: {
    tool: "finance",
    example:
      "finance action=transactions (read-only; locate transactionId=<id> in the returned list)",
    route: (id) => `/finance?tab=transactions&txn=${id}`,
  },
  opportunity: {
    tool: "exec",
    example: "exec action=get_opportunity id=<id>",
    route: () => `/exec?tab=opportunities`,
  },
  decision: {
    tool: "decisions",
    example: "decisions action=get id=<id>",
    route: () => `/strategy#decisions`,
  },
  skill: {
    tool: "skills",
    example:
      "skills action=get name=<label> (skills are fetched by name — use the entity label)",
    route: () => `/system`,
  },
  memory: {
    tool: "memory",
    example: "memory action=read_entry id=<id>",
    route: () => `/memory`,
  },
};

export function renderFocusContextBlock(pc: PageContext): string {
  const lines: string[] = [];
  const pageLabel = pc.pageTitle || pc.route;
  const tabSuffix = pc.tab ? ` > ${pc.tab}` : "";
  const subSuffix = pc.subView ? ` > ${pc.subView}` : "";
  lines.push(`Focus Page: ${pageLabel}${tabSuffix}${subSuffix} (${pc.route})`);
  if (pc.entity) {
    const lab = pc.entity.label ? `${pc.entity.label} ` : "";
    lines.push(`Focus Entity: ${pc.entity.type}: ${lab}(id=${pc.entity.id})`);
  } else {
    lines.push(
      "Focus Entity: (none — no specific item is selected; describe the page/tab/filters instead)",
    );
  }
  if (pc.state && Object.keys(pc.state).length > 0) {
    const items = Object.entries(pc.state)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`Focus View State: ${items}`);
  }
  lines.push("");
  lines.push("Trace-back recipe (focus session):");
  lines.push(
    "- When the user asks 'what am I looking at?', answer with the Focus Page (page + tab + sub-view), the focused entity (label and id) above, and any Focus View State filters.",
  );
  if (pc.entity) {
    const recipe = FOCUS_TRACE_BACK_RECIPES[pc.entity.type];
    if (recipe) {
      if (recipe.example) {
        lines.push(
          `- To read the focused ${pc.entity.type}'s underlying data, call: ${recipe.example.replace("<id>", pc.entity.id)}`,
        );
      } else {
        lines.push(
          `- No direct fetch tool exists for entity type '${pc.entity.type}'; rely on the focus context above and offer to navigate the user to the canonical route below.`,
        );
      }
      lines.push(
        `- Canonical route to send the user back to it: ${recipe.route(pc.entity.id)}`,
      );
    } else {
      lines.push(
        `- No standard fetch recipe is registered for entity type '${pc.entity.type}'; describe what you can from the focus context above without inventing data.`,
      );
    }
  } else {
    lines.push(
      "- No specific item is selected — quote any visible filters/state above; do not invent an entity id or label.",
    );
  }
  return lines.join("\n");
}

export type LastMessageRole = "user" | "assistant" | "system" | "tool" | "unknown";

export type TriggerType =
  | "user"
  | "system"
  | "agent"
  | "intention"
  | "timer"
  | "hook"
  | "skill"
  | "plan"
  | "spawn"
  | "voice"
  | "meeting";

/** Bot lifecycle for a meeting session. Single discriminant for meeting state. */
export type MeetingBotStatus =
  | "dialing"
  | "in_lobby"
  | "live"
  | "leaving"
  | "denied"
  | "failed"
  | "ended";

export type MeetingSpeakerSource = "participant_metadata" | "machine_diarization" | "manual";

/** A canonical speaker within one meeting. key is stable across display-name corrections. */
export interface MeetingParticipant {
  key?: string;
  label: string;
  personId?: string;
  source?: MeetingSpeakerSource;
  transportParticipantId?: string;
  transportEmail?: string;
  providerSpeakerId?: string;
}

export type CanonicalMeetingSpeakerPolicy =
  | { mode: "participant_streams" }
  | { mode: "shared_room" };

export type MeetingSpeakerPolicy =
  | CanonicalMeetingSpeakerPolicy
  | {
      /** @deprecated Legacy attendee-scoped policy. Read as shared_room. */
      mode: "selected_shared_streams";
      sharedStreams: Array<{
        selector: { attendeeEmail?: string; participantLabel?: string };
        expectedPersonIds?: string[];
      }>;
    };

/** Existing attendee-scoped metadata migrates at the read boundary. */
export function normalizeMeetingSpeakerPolicy(
  policy: MeetingSpeakerPolicy | null | undefined,
): CanonicalMeetingSpeakerPolicy {
  return policy?.mode === "shared_room" || policy?.mode === "selected_shared_streams"
    ? { mode: "shared_room" }
    : { mode: "participant_streams" };
}

export interface MeetingRecognitionStream {
  streamKey: string;
  transportParticipantId: string;
  transportLabel?: string;
  attribution: "participant" | "diarized" | "excluded";
  provider: string;
  model: string;
  status: "connecting" | "active" | "fallback" | "closed" | "failed" | "excluded";
  detail?: string;
}

export interface MeetingRecognitionState {
  mode: MeetingSpeakerPolicy["mode"];
  status: "waiting" | "active" | "degraded" | "inactive";
  streams: MeetingRecognitionStream[];
}

/**
 * Meeting metadata on a chat session. A meeting IS a session — this is the
 * only extra state, stored on the session document (single source of truth).
 */
export type MeetingResolutionSource =
  | "calendar_auto_join"
  | "manual_url_match"
  | "unresolved_url";

export interface MeetingSessionMeta {
  title?: string;
  platform?: string;
  participants: MeetingParticipant[];
  botStatus: MeetingBotStatus;
  startedAt?: string;
  endedAt?: string;
  /** Recall.ai bot id when this meeting is driven by a Recall bot. */
  botId?: string;
  /** Original meeting join URL (Zoom/Meet). */
  meetingUrl?: string;
  /** Durable identity of the exact calendar event when confidently resolved. */
  calendarAccountId?: string;
  calendarId?: string;
  providerEventId?: string;
  eventStart?: string;
  eventEnd?: string;
  resolutionSource?: MeetingResolutionSource;
  /** Authoritative private agenda Library page linked from calendar metadata. */
  agendaPage?: {
    id: string;
    title: string;
    slug: string;
  };
  /** Derived agenda text retained for model context and legacy sessions. */
  agenda?: string;
  /** Human-readable detail for denied/failed states (e.g. sub_code). */
  statusDetail?: string;
  /** End-of-meeting recap lifecycle state. */
  recap?: MeetingRecapMeta;
  /** Owner captured at session creation so webhook-driven finalization can run under a real user principal. */
  ownerUserId?: string;
  principalAccountId?: string;
  /** Signed Output Media page URL attached to the Recall bot. */
  outputMediaUrl?: string;
  /** Last meeting speech attempt, surfaced so failures are never silent. */
  speechStatus?: "speaking" | "spoken" | "failed";
  speechStatusDetail?: string;
  /** Speaker routing policy snapshotted from calendar metadata before bot dispatch. */
  speakerPolicy?: MeetingSpeakerPolicy;
  /** Per-stream recognition state for mixed Scribe + Deepgram meetings. */
  recognition?: MeetingRecognitionState;
  /** Canonical recognition boundary telemetry. Recall transcript webhooks remain the explicit fallback. */
  sttProvider?: string;
  sttModel?: string;
  sttSource?: "recall_participant_audio" | "recall_transcript_webhook";
  sttFallback?: boolean;
  sttStatus?: "active" | "fallback" | "inactive";
  sttStatusDetail?: string;
  /** Session-level participation policy. listen_only keeps transcription and
   * recap generation active but never speaks or posts agent responses. */
  participationPolicy?: "auto" | "listen_only";
}

/** Recap lifecycle discriminant — one discriminant per decision. */
export type MeetingRecapStatus = "generating" | "ready" | "failed";

/** End-of-meeting recap state stored on the meeting session meta. */
/** Discriminant for recap email distribution lifecycle. */
export type MeetingRecapDistributionStatus = "pending" | "drafting" | "ready" | "failed" | "blocked";

export interface MeetingRecapMeta {
  status: MeetingRecapStatus;
  pageId?: string;
  pageSlug?: string;
  pageTitle?: string;
  interactionsLogged?: number;
  error?: string;
  /** Distribution lifecycle — set after recap status reaches "ready". */
  distributionStatus?: MeetingRecapDistributionStatus;
  /** Gmail draft IDs surfaced as inline @email_draft artifacts in the session. */
  draftIds?: string[];
  distributionError?: string;
  /** true when distribution was skipped (no eligible attendees or no send method). */
  distributionSkipped?: boolean;
}

/** Speaker attribution for inbound meeting transcript messages. */
export interface MessageSpeakerMeta {
  key?: string;
  label: string;
  personId?: string;
}

/** Persona identity frozen when an assistant turn begins. */
export interface PersonaSnapshot {
  id: number;
  name: string;
  icon: string;
}

export type SessionModelTierOverride = "fast" | "balanced" | "high" | "max";

export interface ChatSession {
  id: string;
  title: string;
  manualTitle?: boolean;
  status: string;
  summary?: string | null;
  sessionKey: string | null;
  /** null means Auto: use persona/activity routing without a session override. */
  modelTier: SessionModelTierOverride | null;
  /** Current persona for this session. Conversational authority is session-scoped. */
  personaId?: number | null;
  createdAt: string;
  updatedAt: string;
  type?: "text" | "voice" | "meeting";
  sessionType: SessionType;
  isPinned: boolean;
  pinReason?: string;
  hasUnreadResult?: boolean;
  intentionId?: string;
  voiceSessionId?: string;
  meeting?: MeetingSessionMeta;
  messageCount?: number;
  lastMessageRole?: LastMessageRole;
  topics?: string[];
  runStatus?: RunStatus;
  parentSessionId?: string;
  spawnReason?: string;
  spawnerTool?: string;
  spawnerSkillRun?: string;
  endReason?: string;
  errorSeverity?: ErrorSeverity | null;
  directChildCount?: number;
  parentMissing?: boolean;
  pageContext?: PageContext;
  gitWriteOverride?: boolean;
  contextFlags?: Record<string, boolean>;
  hasPlan?: boolean;
  hasActivePlan?: boolean;
  /** Derived: session contains a `question` tool call with no matching answer message. */
  awaitingQuestionResponse?: boolean;
  hasActiveDescendant?: boolean;
  archivedAt?: string | null;
  ftueWelcome?: boolean;
  reminder?: {
    active: boolean;
    timerId?: string;
    fireAt?: string | null;
    nextBoot?: boolean;
    nextBuild?: boolean;
  };
  // Memory index writeback (populated by consolidation pipeline)
  memoryOneLiner?: string | null;

  // Provenance (write-once at session creation)
  triggerType?: TriggerType;
  triggerId?: string;
  triggerName?: string;
  rootSessionId?: string;
  depth?: number;
}


/** Durable activity shown in Session Menu; live execution remains SessionManager-owned. */
export function isDurablyActiveSession(session: Pick<ChatSession, "status" | "type" | "meeting" | "hasActiveDescendant" | "hasActivePlan">): boolean {
  return session.status === "streaming" ||
    !!session.hasActiveDescendant ||
    !!session.hasActivePlan ||
    (session.type === "meeting" && (session.meeting?.botStatus === "live" || session.meeting?.botStatus === "leaving"));
}

export type ToolCallStatus = "running" | "done" | "error";

export type { QuestionResponseMeta } from "../question-prompt";

export interface ToolCallInfo {
  toolName: string;
  status: ToolCallStatus;
  output?: string;
  arguments?: Record<string, unknown>;
  toolCallId?: string;
  result?: unknown;
  error?: string | Record<string, unknown>;
  parentId?: string;
}
