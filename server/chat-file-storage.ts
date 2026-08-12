import { documentStorage } from "./memory";
import {
  ADVISORY_LOCK_NS,
  acquireAdvisoryTransactionLock,
  BOOT_ID,
  db,
  getAmbientDatabaseTransaction,
  hasAmbientDatabaseTransaction,
  runOutsideDatabaseTransaction,
  runWithDatabaseTransaction,
} from "./db";
import { accounts, users, documentStoreDocuments, planStepAttempts, planSteps, sessionArtifacts, sessionTree, compactionOperations } from "@shared/schema";
import { enqueueSessionSearchProjection } from "./memory/session-search-projection";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { combineWithVisibleScope, combineWithWritableScope } from "./scoped-storage";
import { assertWritableVault } from "./library-domain";
import {
  buildLegacySessionSearchQuery,
  buildLiteralSubstringPattern,
  buildTargetSessionSearchQuery,
} from "./memory/session-search-query";
import {
  isSessionSearchProjectionReady,
  isSessionSearchSegmentIndexPresent,
} from "./memory/session-search-projection";
import { generateId } from "./file-storage/utils";
import { createLogger } from "./log";
import { markSessionDeleted } from "./chat-journal";
import { eventBus } from "./event-bus";
import { TTLCache } from "./utils/ttl-cache";
import { requireCurrentPrincipal, runWithPrincipal } from "./principal-context";
import { createNamedSystemPrincipal, createUserPrincipalFromUser, resolveUserIdentityFoundation } from "./principal";
import { storage } from "./storage";
import { normalizeSessionModelTierOverride } from "./session-model-tier-override";
import { hasUnansweredQuestion } from "./question-response";
import { getActiveQuestionToolCallId, type QuestionCancelReason } from "@shared/question-prompt";
import type {
  AssistantMessageState,
  ChildSessionBlockMeta,
  CompactionMeta,
  MeetingAudioSourceMode,
  MeetingParticipant,
  MeetingSessionMeta,
  MessageSpeakerMeta,
  ChatSession,
  PersonaSnapshot,
  SessionAgenda,
  SessionAgendaItem,
  SessionAgendaItemStatus,
  QuestionResponseMeta,
  QuestionCancellationMeta,
  SystemStepRecord,
} from "@shared/models/chat";
import type { QuestionPrompt } from "@shared/question-prompt";
import type { ContextPressureSnapshot } from "@shared/streaming-types";
import { decisionsStorage } from "./decisions-storage";
import { filePrincipleStorage } from "./file-storage/principles";
import {
  deleteConversations,
  hasCanonicalConversation,
  moveConversationToVault,
  readConversationMessages,
  writeConversationRevision,
  type ConversationMessagePayload,
} from "./conversation-persistence";

const log = createLogger("ChatStorage");
const treeLog = createLogger("SessionTree");
const memoryMirrorLog = createLogger("SessionMemoryMirror");

const SESSION_INDEX_TTL_MS = 30_000;
const SESSION_READ_BATCH_SIZE = 500;
const _sessionsCache = new TTLCache<any>("Sessions", SESSION_INDEX_TTL_MS);
const CHAT_RECOVERY_JOB = "chat-recovery";
const CHAT_RECOVERY_NOTICE_PREFIX = "system:chat-interrupted-by-restart:v1";

function getRuntimeInstanceId(): string {
  return process.env.RAILWAY_REPLICA_ID || process.env.HOSTNAME || "local";
}

function getRuntimeOwner(): string {
  return `${getRuntimeInstanceId()}@${BOOT_ID}`;
}

function isOwnedByCurrentRuntime(owner: string | null | undefined): boolean {
  return owner === getRuntimeOwner();
}

function isOwnedByPriorBootOnThisInstance(owner: string | null | undefined): boolean {
  return Boolean(
    owner?.startsWith(`${getRuntimeInstanceId()}@`) &&
      !isOwnedByCurrentRuntime(owner),
  );
}

function principalCacheKey(): string {
  const principal = requireCurrentPrincipal();
  return `${principal.actorType}:${principal.accountId || "no-account"}:${principal.userId || "no-user"}`;
}

/** Delta payload for session list change events.  When present the client can
 *  apply the change directly to its cache instead of refetching the full list. */
interface SessionDelta {
  action: "created" | "updated" | "deleted";
  sessionId: string;
  /** Full session metadata — included for "created", optional for "updated". */
  session?: FileSession;
}

function invalidateSessionsCache(delta?: SessionDelta): void {
  // Clear the server-side TTL cache so the next /api/sessions fetch returns
  // fresh data. Without this, the client refetch triggered by the event below
  // races with the stale cache and overwrites optimistic UI updates.
  _sessionsCache.invalidateAll();
  eventBus.publish({
    category: "system",
    event: "data:sessions_changed",
    payload: { source: "chat_storage", delta },
  });
}

function estimateInlineTokens(value: unknown): number {
  if (typeof value === "string") return Math.ceil(value.length / 3.5);
  if (value == null) return 0;
  try {
    return Math.ceil(JSON.stringify(value).length / 3.5);
  } catch {
    return Math.ceil(String(value).length / 3.5);
  }
}

function isArchivedToolOutputString(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.includes("**Tool Output Archived**") &&
    value.includes("[ref:")
  );
}

function extractToolAction(
  toolName: string | undefined,
  args: unknown,
): string | undefined {
  if (args && typeof args === "object") {
    const action = (args as Record<string, unknown>).action;
    if (typeof action === "string" && action.trim()) return action.trim();
  }
  return toolName;
}

import type {
  SessionType,
  ChatSession,
  RunStatus,
  ToolCallInfo,
  PageContext,
  LastMessageRole,
  TriggerType,
} from "@shared/models/chat";
export type { SessionType, ChatSession, PageContext };

export interface SessionProvenanceInput {
  triggerType: TriggerType;
  triggerId?: string;
  triggerName?: string;
}

interface SpawnMetaInput extends Partial<SessionProvenanceInput> {
  /** Persona selected before creation so initial session snapshots are truthful. */
  personaId?: number;
  /** Explicit child agenda. Parent agendas are never inherited. */
  agenda?: SessionAgenda;
  parentSessionId?: string;
  spawnReason?: string;
  spawnerTool?: string;
  spawnerSkillRun?: string;
}

function normalizeSessionProvenance(
  provenance: SessionProvenanceInput | undefined,
  fallback: SessionProvenanceInput,
): SessionProvenanceInput {
  return {
    triggerType: provenance?.triggerType ?? fallback.triggerType,
    triggerId: provenance?.triggerId ?? fallback.triggerId,
    triggerName: provenance?.triggerName ?? fallback.triggerName,
  };
}

function provenanceFromSessionType(
  sessionType: SessionType | undefined,
  title: string,
  intentionId?: string,
): SessionProvenanceInput {
  if (intentionId) {
    return { triggerType: "intention", triggerId: intentionId, triggerName: title };
  }
  if (sessionType === "agent" || sessionType === "autonomous") {
    return { triggerType: "agent", triggerName: title };
  }
  return { triggerType: "user", triggerName: title };
}

import {
  SESSION_AGENDA_MAX_ITEMS,
  SESSION_AGENDA_DESCRIPTION_MAX_CHARS,
  SESSION_AGENDA_RESOLUTION_MAX_CHARS,
  boundedAgendaText,
  normalizeAgendaTitle,
} from "./agenda-item-contract";

const SESSION_AGENDA_STATUSES = new Set<SessionAgendaItemStatus>([
  "open",
  "complete",
  "skipped",
  "deferred",
]);

export interface SessionAgendaItemInput {
  id?: string;
  title: string;
  description: string;
  status?: SessionAgendaItemStatus;
  resolution?: string;
}

export interface SessionAgendaItemPatch {
  title?: string;
  description?: string;
  status?: SessionAgendaItemStatus;
  resolution?: string;
}

function normalizeAgendaStatus(value: unknown): SessionAgendaItemStatus {
  if (typeof value !== "string" || !SESSION_AGENDA_STATUSES.has(value as SessionAgendaItemStatus)) {
    throw new Error("Agenda item status must be open, complete, skipped, or deferred");
  }
  return value as SessionAgendaItemStatus;
}

function normalizeOptionalAgendaPatchText(
  value: unknown,
  label: string,
  maxChars: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  return boundedAgendaText(value, label, maxChars);
}

function normalizeAgendaItem(
  input: SessionAgendaItemInput,
  existingIds: Set<string>,
): SessionAgendaItem {
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : generateId();
  if (existingIds.has(id)) throw new Error(`Duplicate agenda item id: ${id}`);
  existingIds.add(id);
  const status = normalizeAgendaStatus(input.status ?? "open");
  const resolution = typeof input.resolution === "string" && input.resolution.trim()
    ? boundedAgendaText(input.resolution, "Agenda item resolution", SESSION_AGENDA_RESOLUTION_MAX_CHARS)
    : undefined;
  if (status === "complete" && !resolution) {
    throw new Error("Complete agenda items require a resolution");
  }
  return {
    id,
    title: normalizeAgendaTitle(input.title),
    description: boundedAgendaText(input.description, "Agenda item description", SESSION_AGENDA_DESCRIPTION_MAX_CHARS),
    status,
    ...(status === "complete" ? { resolution } : {}),
  };
}

export function normalizeSessionAgenda(items: SessionAgendaItemInput[]): SessionAgenda {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("A session agenda requires at least one item");
  }
  if (items.length > SESSION_AGENDA_MAX_ITEMS) {
    throw new Error(`A session agenda may contain at most ${SESSION_AGENDA_MAX_ITEMS} items`);
  }
  const existingIds = new Set<string>();
  return { items: items.map((item) => normalizeAgendaItem(item, existingIds)) };
}


export interface FileSession extends ChatSession {
  modelTier: string | null;
  personaId?: number | null;
}

export type MeetingLeaveClaim =
  | { outcome: "claimed"; session: FileSession; previousStatus: MeetingSessionMeta["botStatus"] }
  | { outcome: "already_leaving"; session: FileSession }
  | { outcome: "not_leaveable"; session: FileSession }
  | { outcome: "not_meeting" };

export type MeetingRecapClaim =
  | { outcome: "claimed"; session: FileSession }
  | { outcome: "already_generating"; session: FileSession }
  | { outcome: "already_ready"; session: FileSession }
  | { outcome: "not_meeting" };

export type MeetingAudioSourcePolicyMutation =
  | { outcome: "updated" | "unchanged"; session: FileSession }
  | { outcome: "not_found" | "not_owned" | "not_active" | "excluded" };

export type MeetingSpeakerAssignment =
  | {
      outcome: "assigned" | "cleared" | "unchanged";
      participant: MeetingParticipant;
      previousPersonId?: string;
      displacedParticipants: Array<{
        participant: MeetingParticipant;
        previousPersonId: string;
      }>;
      session: FileSession;
    }
  | { outcome: "not_found" | "not_owned" };

export type { SystemStepRecord } from "@shared/models/chat";

export type SegmentChronologyEntry =
  | { s: "system"; i: number }
  | { s: "thinking"; c: string }
  | { s: "tool"; i: number }
  | { s: "content"; c: string }
  | { s: "compacting"; i: number };

function alignAssistantChronology(
  chronology: SegmentChronologyEntry[] | undefined,
  content: string,
  sessionId: string,
): SegmentChronologyEntry[] | undefined {
  if (!chronology) return undefined;
  const sanitizedChronology = chronology.map((entry) => {
    if (entry.s !== "content") return entry;
    // Accept legacy/malformed producers that used `t` instead of `c`.
    const raw =
      typeof entry.c === "string"
        ? entry.c
        : typeof (entry as { t?: unknown }).t === "string"
          ? String((entry as { t?: unknown }).t)
          : "";
    return { s: "content" as const, c: stripRoleMarkers(raw, sessionId) };
  });
  const chronologicalContent = sanitizedChronology
    .filter((entry): entry is Extract<SegmentChronologyEntry, { s: "content" }> => entry.s === "content")
    .map((entry) => entry.c)
    .join("");
  if (chronologicalContent === content) return sanitizedChronology;

  if (content.startsWith(chronologicalContent)) {
    const suffix = content.slice(chronologicalContent.length);
    if (!suffix) return chronology;
    const aligned = [...sanitizedChronology];
    for (let index = aligned.length - 1; index >= 0; index -= 1) {
      const entry = aligned[index];
      if (entry.s !== "content") continue;
      aligned[index] = { s: "content", c: entry.c + suffix };
      return aligned;
    }
    aligned.push({ s: "content", c: suffix });
    return aligned;
  }

  log.warn(
    `[ChatFileStorage] assistant chronology content mismatch sessionId=${sessionId} chronologyLen=${chronologicalContent.length} contentLen=${content.length}; persisting authoritative terminal content`,
  );
  const diagnostics = sanitizedChronology.filter((entry) => entry.s !== "content");
  if (content) diagnostics.push({ s: "content", c: content });
  return diagnostics;
}

export interface CrossSessionMeta {
  fromSessionId: string;
  toSessionId: string;
  direction: "sibling" | "parent" | "child" | "direct";
  chainId?: string;
  depth?: number;
}

export interface VoiceMessageMeta {
  source: "elevenlabs-voice";
  voiceSessionId: string;
  turnKey: string;
  /** Canonical per-turn correlation ID minted at turn acceptance. */
  turnId?: string;
  userOrdinal?: number;
  turnNumber?: number;
}

/**
 * Message visibility discriminant. Stored at creation time so renderers
 * never need to name-match system step names to decide visibility.
 *   - 'chat': normal user/assistant messages rendered in transcript (default)
 *   - 'diagnostic': operational lifecycle entries (voice connect/disconnect,
 *     setup steps) persisted for forensics but hidden from chat UI
 */
export type MessageVisibility = "chat" | "diagnostic";

export type TerminalAssistantMessageState = Exclude<AssistantMessageState, "streaming">;

export type AssistantDraftTerminalizationOutcome =
  | { outcome: "terminalized"; state: TerminalAssistantMessageState; durableRevision: number }
  | { outcome: "removed_empty"; state: TerminalAssistantMessageState; durableRevision: number }
  | { outcome: "already_terminal"; state?: TerminalAssistantMessageState; durableRevision: number }
  | { outcome: "run_mismatch"; actualRunId?: string }
  | { outcome: "not_found" };

export interface FileMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  thinking: string | null;
  toolCalls: unknown;
  systemSteps: SystemStepRecord[] | null;
  model: string | null;
  createdAt: string;
  updatedAt?: string;
  cost?: number | null;
  apiCallCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  /** Final provider-bound context pressure observed for this assistant turn. */
  contextPressure?: ContextPressureSnapshot | null;
  segmentChronology?: SegmentChronologyEntry[] | null;
  isError?: boolean;
  crossSession?: CrossSessionMeta;
  childSession?: ChildSessionBlockMeta;
  compaction?: CompactionMeta;
  pageContext?: PageContext;
  assistantState?: AssistantMessageState;
  assistantRunId?: string;
  assistantRuntimeOwner?: string;
  assistantInterruptedAt?: string;
  voice?: VoiceMessageMeta;
  /** Persona that produced this assistant turn. */
  persona?: PersonaSnapshot;
  /** Speaker attribution for meeting transcript messages. */
  speaker?: MessageSpeakerMeta;
  /** Immutable provider/binding attempt provenance for meeting recognition. */
  recognition?: import("@shared/models/chat").MessageRecognitionMeta;
  /** Structured response to an inline question tool call. */
  questionResponse?: QuestionResponseMeta;
  /** Terminal cancellation marker for an inline question tool call (explicit dismiss or superseded by a chat message). */
  questionCancellation?: QuestionCancellationMeta;
  /** Replay-safe identity for a server-produced inline artifact message. */
  artifactKey?: string;
  /** Canonical per-turn correlation ID. Used for replay-safe user-message acceptance and voice turn pairing. */
  turnId?: string;
  /** Visibility discriminant — absent or 'chat' = normal; 'diagnostic' = hidden from transcript */
  visibility?: MessageVisibility;
}

interface SessionData {
  id: string;
  /** Monotonic canonical document revision. Legacy documents begin at zero. */
  durableRevision?: number;
  title: string;
  manualTitle?: boolean;
  status: string;
  summary?: string | null;
  sessionKey: string | null;
  /** Read projection of the document store's canonical vault_id. Never serialized into chat content. */
  vaultId?: string;
  modelTier?: string | null;
  personaId?: number | null;
  rootRevisionId?: string;
  selectedPersonaRevisionId?: string;
  /** True when the user manually pinned the persona from the UI; suppresses agent auto-switching for this session. */
  personaPinnedByUser?: boolean;
  createdAt: string;
  updatedAt: string;
  messages: FileMessage[];
  lastMessageRole?: LastMessageRole;
  type?: "text" | "voice" | "meeting";
  sessionType: SessionType;
  isPinned: boolean;
  pinReason?: string;
  // Legacy persisted payload fields. Read-only compatibility during rename from needsAttention.
  needsAttention?: boolean;
  attentionReason?: string;
  hasUnreadResult?: boolean;
  intentionId?: string;
  voiceSessionId?: string;
  meeting?: MeetingSessionMeta;
  initialSystemPrompt?: string | null;
  topics?: string[];
  agenda?: SessionAgenda;
  runStatus?: RunStatus;
  parentSessionId?: string;
  spawnReason?: string;
  spawnerTool?: string;
  spawnerSkillRun?: string;
  endReason?: string;
  childMissionOutcome?: import("@shared/models/chat").ChildMissionTerminalOutcome;
  errorSeverity?: "warning" | "error" | null;
  /** Runtime instance and boot that owns the currently active text-chat turn. */
  activeRuntimeOwner?: string;
  pageContext?: PageContext;
  gitWriteOverride?: boolean;
  contextFlags?: Record<string, boolean>;
  archivedAt?: string | null;
  ftueWelcome?: boolean;
  /** Recipient-owned recap Meeting guided in place during FTUE. */
  ftueRecapMeetingSessionId?: string;
  memoryEntryId?: number | null;
  memoryOneLiner?: string | null;
  memorySummary?: string | null;
  // Provenance
  triggerType?: import("@shared/models/chat").TriggerType;
  triggerId?: string;
  triggerName?: string;
  triggerAddress?: string;
  rootSessionId?: string;
  depth?: number;
}

async function computeRootAndDepth(
  parentSessionId?: string,
): Promise<{ rootSessionId: string | undefined; depth: number }> {
  if (!parentSessionId) return { rootSessionId: undefined, depth: 0 };
  try {
    const { getAncestry } = await import("./sessions/tree");
    const ancestry = await getAncestry(parentSessionId);
    if (ancestry.length === 0)
      return { rootSessionId: parentSessionId, depth: 1 };
    // Walk to the oldest ancestor (the one with no parent)
    const root =
      ancestry.find((a) => !a.parentSessionId) || ancestry[ancestry.length - 1];
    return { rootSessionId: root.sessionId, depth: ancestry.length };
  } catch (err) {
    log.warn(
      `computeRootAndDepth failed for parent=${parentSessionId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { rootSessionId: undefined, depth: 0 };
  }
}

/**
 * In-memory root/depth from an already-fetched parent map.
 * Used by the session index path so /api/sessions does not issue one
 * recursive ancestry SQL per row (observed multi-second N+1 under load).
 */
function computeRootAndDepthFromParentMap(
  sessionId: string,
  parentById: Map<string, string | undefined>,
  memo: Map<string, { rootSessionId: string; depth: number }>,
): { rootSessionId: string; depth: number } {
  const cached = memo.get(sessionId);
  if (cached) return cached;

  const seen = new Set<string>();
  const chain: string[] = [];
  let current = sessionId;

  while (!seen.has(current)) {
    seen.add(current);
    chain.push(current);
    const parentId = parentById.get(current);
    if (!parentId) break;
    current = parentId;
    if (chain.length > 128) break;
  }

  const rootSessionId = chain[chain.length - 1] || sessionId;
  for (let i = 0; i < chain.length; i++) {
    const id = chain[i]!;
    memo.set(id, {
      rootSessionId,
      depth: chain.length - 1 - i,
    });
  }
  return memo.get(sessionId) || { rootSessionId: sessionId, depth: 0 };
}

function toLastMessageRole(role: string | undefined): LastMessageRole | undefined {
  if (!role) return undefined;
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
    return role;
  }
  return "unknown";
}

function getLastMessageRole(messages: FileMessage[]): LastMessageRole | undefined {
  return toLastMessageRole(messages[messages.length - 1]?.role);
}

function mergeSystemSteps(
  existing: SystemStepRecord[] | null | undefined,
  incoming: SystemStepRecord[],
): SystemStepRecord[] {
  const result: SystemStepRecord[] = existing ? [...existing] : [];
  const keyOf = (s: SystemStepRecord) =>
    `${s.name}|${s.detail ?? ""}|${s.status}`;
  const seen = new Set(result.map(keyOf));
  for (const step of incoming) {
    const k = keyOf(step);
    if (!seen.has(k)) {
      seen.add(k);
      result.push(step);
    }
  }
  return result;
}

function mergeToolCalls(
  existing: unknown,
  incoming: ToolCallInfo[] | null,
): ToolCallInfo[] | null {
  if (!incoming || incoming.length === 0) {
    return (existing as ToolCallInfo[] | null) ?? null;
  }
  const existingArr = Array.isArray(existing)
    ? (existing as ToolCallInfo[])
    : [];
  const keyOf = (t: ToolCallInfo) =>
    t.toolCallId
      ? `id:${t.toolCallId}`
      : `nm:${t.toolName}|${JSON.stringify(t.arguments ?? null)}`;
  const byKey = new Map<string, ToolCallInfo>();
  for (const tc of existingArr) {
    byKey.set(keyOf(tc), tc);
  }
  for (const tc of incoming) {
    const k = keyOf(tc);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, tc);
      continue;
    }
    // Prefer richer metadata from later writers (executor over stream draft).
    byKey.set(k, {
      ...prev,
      ...tc,
      ...(tc.failureKind || prev.failureKind
        ? { failureKind: tc.failureKind ?? prev.failureKind }
        : {}),
      ...(tc.failureCode || prev.failureCode
        ? { failureCode: tc.failureCode ?? prev.failureCode }
        : {}),
      ...(tc.result !== undefined || prev.result !== undefined
        ? { result: tc.result ?? prev.result }
        : {}),
      ...(tc.error !== undefined || prev.error !== undefined
        ? { error: tc.error ?? prev.error }
        : {}),
      ...(tc.arguments !== undefined || prev.arguments !== undefined
        ? { arguments: tc.arguments ?? prev.arguments }
        : {}),
      status: tc.status ?? prev.status,
    });
  }
  return Array.from(byKey.values());
}

function hasRenderableAssistantPayload(input: {
  content?: string | null;
  thinking?: string | null;
  toolCalls?: unknown;
  systemSteps?: SystemStepRecord[] | null;
  segmentChronology?: SegmentChronologyEntry[] | null;
}): boolean {
  if ((input.content || "").trim().length > 0) return true;
  if ((input.thinking || "").trim().length > 0) return true;
  if (Array.isArray(input.toolCalls) && input.toolCalls.length > 0) return true;
  if (Array.isArray(input.systemSteps) && input.systemSteps.length > 0) return true;
  if (Array.isArray(input.segmentChronology) && input.segmentChronology.length > 0) return true;
  return false;
}


/* ── Role-marker sanitizer ─────────────────────────────────────────── */
const ROLE_MARKER_RE = /^\[(User|Assistant|Tool Result)\]/gm;

function stripRoleMarkers(content: string, sessionId: string): string {
  // Coerce first so a malformed chronology/content producer cannot crash
  // terminal message persistence with "Cannot read properties of undefined (reading 'replace')".
  const text =
    typeof content === "string"
      ? content
      : content == null
        ? ""
        : String(content);
  if (typeof content !== "string") {
    log.warn(
      `[ChatFileStorage] stripRoleMarkers coerced non-string content sessionId=${sessionId} type=${content === null ? "null" : typeof content}`,
    );
  }
  let stripped = false;
  const cleaned = text.replace(ROLE_MARKER_RE, (match) => {
    if (!stripped) {
      log.warn(
        `[ChatFileStorage] Stripped role marker(s) from assistant output, ` +
          `sessionId=${sessionId} preview="${text.slice(0, 80)}"`,
      );
      stripped = true;
    }
    return "";
  });
  return cleaned;
}

const convLocks = new Map<string, Promise<unknown>>();

let _trackConvLockStart: ((id: string, convId: string) => void) | null = null;
let _trackConvLockEnd: ((id: string) => void) | null = null;
try {
  const ww = require("./wedge-watchdog");
  _trackConvLockStart = ww.trackConvLockStart;
  _trackConvLockEnd = ww.trackConvLockEnd;
} catch {
  /* watchdog not available */
}

let _convLockSeq = 0;
function withConvLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = convLocks.get(id) || Promise.resolve();
  const trackId = `cl-${id}-${++_convLockSeq}`;
  const wrapped = async () => {
    _trackConvLockStart?.(trackId, id);
    try {
      return await db.transaction(async (transaction) => {
        await acquireAdvisoryTransactionLock(
          transaction,
          ADVISORY_LOCK_NS.CHAT_DOCUMENT,
          id,
        );
        return runWithDatabaseTransaction(transaction, fn);
      });
    } finally {
      _trackConvLockEnd?.(trackId);
    }
  };
  const next = prev.then(wrapped, wrapped);
  convLocks.set(id, next);
  void next.then(
    () => {
      if (convLocks.get(id) === next) convLocks.delete(id);
    },
    () => {
      if (convLocks.get(id) === next) convLocks.delete(id);
    },
  );
  return next;
}

function parseConvDocument(
  id: string,
  doc: { content: string; vaultId: string | null; metadata: unknown },
): SessionData | null {
  try {
    const data = JSON.parse(doc.content) as SessionData;
    data.vaultId = doc.vaultId || undefined;
    data.hasUnreadResult = metadataBool(doc.metadata || {}, "hasUnreadResult");
    if (!data.sessionType) data.sessionType = "user";
    const legacy = data as SessionData & { needsAttention?: boolean; attentionReason?: string };
    if (data.isPinned === undefined) data.isPinned = legacy.needsAttention === true;
    if (data.pinReason === undefined && legacy.attentionReason !== undefined) data.pinReason = legacy.attentionReason;
    return data;
  } catch (err) {
    log.warn(`readConv parse error id=${id}:`, err);
    return null;
  }
}

async function readConv(id: string): Promise<SessionData | null> {
  const doc = await documentStorage.getDocument("chat", id);
  if (!doc) return null;
  const data = parseConvDocument(id, doc);
  if (!data) return null;
  const principal = requireCurrentPrincipal();
  const canonicalMessages = await readConversationMessages(principal, id);
  if (canonicalMessages.length > 0 || await hasCanonicalConversation(principal, id)) {
    data.messages = canonicalMessages as FileMessage[];
  }
  await applySessionTreeOverlay(data);
  return data;
}

/**
 * Prefer the indexed session_tree row when available. Legacy chat documents may
 * still carry spawn metadata inside the document payload; when encountered,
 * repair the index in place instead of emitting per-session deprecation spam.
 */
type SessionTreeOverlay = Pick<
  typeof sessionTree.$inferSelect,
  "parentSessionId" | "spawnReason" | "spawnerTool" | "spawnerSkillRun"
>;

function applyIndexedSessionTreeOverlay(data: SessionData, row: SessionTreeOverlay): void {
  // session_tree is the source of truth. Null values in the indexed row are
  // authoritative and must not fall back to legacy document metadata.
  data.parentSessionId = row.parentSessionId || undefined;
  data.spawnReason = row.spawnReason || undefined;
  data.spawnerTool = row.spawnerTool || undefined;
  data.spawnerSkillRun = row.spawnerSkillRun || undefined;
}

function hasLegacySessionTreeMetadata(data: SessionData): boolean {
  return Boolean(
    data.parentSessionId ||
    data.spawnReason ||
    data.spawnerTool ||
    data.spawnerSkillRun
  );
}

async function repairLegacySessionTreeMetadata(data: SessionData): Promise<void> {
  if (!hasLegacySessionTreeMetadata(data)) return;
  const tree = await import("./sessions/tree");
  await tree.upsertSessionTreeRow({
    sessionId: data.id,
    parentSessionId: data.parentSessionId || null,
    spawnReason: data.spawnReason || null,
    spawnerTool: data.spawnerTool || null,
    spawnerSkillRun: data.spawnerSkillRun || null,
  });
}

async function applySessionTreeOverlay(data: SessionData): Promise<void> {
  try {
    const tree = await import("./sessions/tree");
    const row = await tree.getSessionTreeRow(data.id);
    if (row) {
      applyIndexedSessionTreeOverlay(data, row);
      return;
    }
    await repairLegacySessionTreeMetadata(data);
  } catch {
    // Silent: tree overlay/backfill is best-effort. Callers can still use the
    // legacy payload fields for this read if the repair path is unavailable.
  }
}

interface ChatDocumentOwnerIdentity {
  ownerUserId: string;
  accountId: string;
  vaultId: string | null;
}

async function runWithChatDocumentOwner<T>(
  docId: string,
  identity: ChatDocumentOwnerIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  if (!identity.ownerUserId || !identity.accountId) {
    throw new Error(`Chat document ownership is incomplete: chat/${docId}`);
  }
  const user = await storage.getUser(identity.ownerUserId);
  if (!user) throw new Error(`Chat document owner is missing: chat/${docId}`);
  const foundation = await resolveUserIdentityFoundation(user.id);
  if (foundation.accountId !== identity.accountId) {
    throw new Error(`Chat document account is not the owner's personal account: chat/${docId}`);
  }
  if (
    identity.vaultId &&
    user.activeVaultId !== identity.vaultId &&
    !user.visibleVaultIds.includes(identity.vaultId)
  ) {
    throw new Error(`Chat document vault is not visible to its owner: chat/${docId}`);
  }
  return runWithPrincipal(
    createUserPrincipalFromUser(user, identity.accountId),
    operation,
  );
}

function countMeetingTranscriptMessages(data: SessionData): number {
  if (data.type !== "meeting") return 0;
  return data.messages.filter(
    (message) => message.role === "user" && Boolean(message.speaker) && Boolean(message.content.trim()),
  ).length;
}

function normalizeDurableRevision(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function buildConvDocumentMetadata(data: SessionData): Record<string, unknown> {
  return {
    conversationStorageVersion: 1,
    durableRevision: normalizeDurableRevision(data.durableRevision),
    title: data.title,
    manualTitle: data.manualTitle || undefined,
    status: data.status,
    summary: data.summary || null,
    sessionKey: data.sessionKey,
    modelTier: normalizeSessionModelTierOverride(data.modelTier),
    personaId: data.personaId ?? null,
    rootRevisionId: data.rootRevisionId,
    selectedPersonaRevisionId: data.selectedPersonaRevisionId,
    personaPinnedByUser: data.personaPinnedByUser ?? false,
    messageCount: data.messages.length,
    lastMessageRole: getLastMessageRole(data.messages),
    awaitingQuestionResponse: hasUnansweredQuestion(data.messages) || undefined,
    type: data.type || "text",
    meeting: data.meeting,
    meetingTranscriptCount: countMeetingTranscriptMessages(data),
    sessionType: data.sessionType || "user",
    isPinned: data.isPinned || false,
    pinReason: data.pinReason || null,
    hasUnreadResult: data.hasUnreadResult || false,
    voiceSessionId: data.voiceSessionId,
    hasInitialContext: !!data.initialSystemPrompt,
    topics: data.topics || [],
    agenda: data.agenda,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    runStatus: data.runStatus || undefined,
    parentSessionId: data.parentSessionId || undefined,
    spawnReason: data.spawnReason || undefined,
    spawnerTool: data.spawnerTool || undefined,
    spawnerSkillRun: data.spawnerSkillRun || undefined,
    endReason: data.endReason || undefined,
    childMissionOutcome: data.childMissionOutcome || undefined,
    errorSeverity: data.errorSeverity || undefined,
    activeRuntimeOwner: data.activeRuntimeOwner || undefined,
    pageContext: data.pageContext || undefined,
    contextFlags: data.contextFlags || undefined,
    triggerType: data.triggerType,
    triggerId: data.triggerId,
    triggerName: data.triggerName,
    triggerAddress: data.triggerAddress,
    rootSessionId: data.rootSessionId,
    depth: data.depth,
    archivedAt: data.archivedAt || null,
    ftueWelcome: data.ftueWelcome || undefined,
    ftueRecapMeetingSessionId: data.ftueRecapMeetingSessionId || undefined,
    memoryEntryId: data.memoryEntryId ?? null,
    memoryOneLiner: data.memoryOneLiner || null,
    memorySummary: data.memorySummary || null,
  };
}

async function resolveSessionWriteVaultId(data: SessionData): Promise<string> {
  const principal = requireCurrentPrincipal();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error(`Session writes require an explicit user and account owner: chat/${data.id}`);
  }
  const requestedVaultId = data.vaultId ?? principal.activeVaultId;
  if (!requestedVaultId) {
    throw Object.assign(new Error("Choose an active Vault before creating a session"), { status: 400 });
  }
  return assertWritableVault(principal, requestedVaultId);
}

function serializeSessionContent(data: SessionData): string {
  const {
    vaultId: _canonicalDocumentVaultId,
    messages: _canonicalConversationMessages,
    ...content
  } = data;
  // The aggregate blob is compatibility metadata only. Transcript authority is
  // conversation_messages; active writes never rewrite the whole transcript.
  return JSON.stringify({ ...content, messages: [] });
}

function shouldProjectSessionSearch(data: SessionData): boolean {
  return (
    !["streaming", "pending"].includes(data.status)
    && !data.messages.some(message => message.assistantState === "streaming")
  );
}

async function enqueueSearchProjectionAfterCanonicalWrite(
  documentStoreId: number,
  data: SessionData,
): Promise<void> {
  if (!shouldProjectSessionSearch(data)) return;
  const transaction = getAmbientDatabaseTransaction();
  const principal = requireCurrentPrincipal();
  if (!transaction || principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error(`Session search projection enqueue requires the canonical user transaction: chat/${data.id}`);
  }
  await enqueueSessionSearchProjection(transaction, principal, {
    documentStoreId,
    sessionId: data.id,
    durableRevision: normalizeDurableRevision(data.durableRevision),
  });
}

async function writeConvInAmbientTransaction(data: SessionData): Promise<number> {
  const vaultId = await resolveSessionWriteVaultId(data);
  data.vaultId = vaultId;
  const principal = requireCurrentPrincipal();
  data.durableRevision = normalizeDurableRevision(data.durableRevision) + 1;
  await writeConversationRevision(principal, {
    sessionId: data.id,
    vaultId,
    revision: data.durableRevision,
    messages: data.messages as ConversationMessagePayload[],
  });
  const writePrincipal = principal.activeVaultId === vaultId
    ? principal
    : { ...principal, activeVaultId: vaultId };
  const document = await runWithPrincipal(writePrincipal, () => documentStorage.upsertDocument(
    "chat",
    data.id,
    `chat/text/conv-${data.id}.json`,
    data.title,
    serializeSessionContent(data),
    buildConvDocumentMetadata(data),
  ));
  await enqueueSearchProjectionAfterCanonicalWrite(document.documentStoreId, data);
  if (
    !["streaming", "pending"].includes(data.status)
    && data.type !== "meeting"
    && data.sessionType !== "meeting"
    && !data.messages.some(message => message.assistantState === "streaming")
  ) {
    if (principal.actorType === "user") {
      const { indexSettledSessionReferences } = await import("./session-reference-index");
      await indexSettledSessionReferences(principal, data);
    }
  }
  return data.durableRevision;
}

async function writeConv(data: SessionData): Promise<number> {
  if (!hasAmbientDatabaseTransaction()) {
    return withConvLock(data.id, () => writeConvInAmbientTransaction(data));
  }
  const durableRevision = await writeConvInAmbientTransaction(data);
  if (
    data.parentSessionId ||
    data.spawnReason ||
    data.spawnerTool ||
    data.spawnerSkillRun
  ) {
    try {
      const { upsertSessionTreeRow } = await import("./sessions/tree");
      await upsertSessionTreeRow({
        sessionId: data.id,
        parentSessionId: data.parentSessionId || null,
        spawnReason: data.spawnReason || null,
        spawnerTool: data.spawnerTool || null,
        spawnerSkillRun: data.spawnerSkillRun || null,
      });
    } catch (err) {
      log.warn(
        `writeConv: failed to dual-write session_tree for ${data.id}`,
        err,
      );
    }
  }
  return durableRevision;
}

export interface SessionDeletionResult {
  deletedSessionIds: string[];
  descendantCount: number;
}

const targetChatDocumentScopeColumns = {
  scope: documentStoreDocuments.scope,
  ownerUserId: documentStoreDocuments.ownerUserId,
  accountId: documentStoreDocuments.accountId,
  vaultId: documentStoreDocuments.vaultId,
};

const planStepScopeColumns = {
  ownerUserId: planSteps.ownerUserId,
  accountId: planSteps.accountId,
};

const planAttemptScopeColumns = {
  ownerUserId: planStepAttempts.ownerUserId,
  accountId: planStepAttempts.accountId,
};

async function deleteSessionSubtree(rootSessionId: string): Promise<SessionDeletionResult> {
  const principal = requireCurrentPrincipal();
  const sessions = await chatFileStorage.getAllSessions();
  const root = sessions.find((session) => session.id === rootSessionId);
  if (!root) throw new Error(`Session not found: ${rootSessionId}`);

  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const children = childrenByParent.get(session.parentSessionId) ?? [];
    children.push(session.id);
    childrenByParent.set(session.parentSessionId, children);
  }

  const deletedSessionIds = [rootSessionId];
  const visited = new Set(deletedSessionIds);
  const pending = [...(childrenByParent.get(rootSessionId) ?? [])];
  while (pending.length > 0) {
    const sessionId = pending.shift()!;
    if (visited.has(sessionId)) continue;
    visited.add(sessionId);
    deletedSessionIds.push(sessionId);
    pending.push(...(childrenByParent.get(sessionId) ?? []));
  }

  await db.transaction(async (tx) => {
    await deleteConversations(principal, deletedSessionIds);
    const deletedDocuments = await tx
      .delete(documentStoreDocuments)
      .where(
        combineWithWritableScope(
          principal,
          targetChatDocumentScopeColumns,
          and(
            eq(documentStoreDocuments.documentType, "chat"),
            inArray(documentStoreDocuments.documentId, deletedSessionIds),
          ),
        ),
      )
      .returning({ sessionId: documentStoreDocuments.documentId });

    if (!deletedDocuments.some((row) => row.sessionId === rootSessionId)) {
      throw new Error(`Session is not writable: ${rootSessionId}`);
    }

    const detachedAt = new Date();
    await tx
      .update(planSteps)
      .set({ sessionId: null, updatedAt: detachedAt })
      .where(combineWithWritableScope(
        principal,
        planStepScopeColumns,
        inArray(planSteps.sessionId, deletedSessionIds),
      ));
    await tx
      .update(planStepAttempts)
      .set({ childSessionId: null, updatedAt: detachedAt })
      .where(combineWithWritableScope(
        principal,
        planAttemptScopeColumns,
        inArray(planStepAttempts.childSessionId, deletedSessionIds),
      ));
    await tx.delete(sessionArtifacts).where(inArray(sessionArtifacts.sessionId, deletedSessionIds));
    await tx.delete(sessionTree).where(inArray(sessionTree.sessionId, deletedSessionIds));
  });

  return {
    deletedSessionIds,
    descendantCount: deletedSessionIds.length - 1,
  };
}

function extractFallbackSessionSummary(data: SessionData): { summary: string | null; reason: string } {
  const explicit = (data.summary || "").trim();
  if (explicit) return { summary: explicit, reason: "session_summary" };

  const compaction = data.messages.find((message) => message.compaction?.summary?.trim());
  const compactionSummary = compaction?.compaction?.summary?.trim();
  if (compactionSummary) return { summary: compactionSummary, reason: "compaction_summary" };

  const completeAssistant = [...data.messages]
    .reverse()
    .find((message) => message.role === "assistant" && !message.isError && message.content?.trim());
  const assistantSummary = completeAssistant?.content?.trim();
  if (assistantSummary) return { summary: assistantSummary.slice(0, 4000), reason: "last_assistant_fallback" };

  const completeUser = [...data.messages]
    .reverse()
    .find((message) => message.role === "user" && message.content?.trim());
  const userSummary = completeUser?.content?.trim();
  if (userSummary) return { summary: userSummary.slice(0, 2000), reason: "last_user_fallback" };

  return { summary: null, reason: "no_summary_material" };
}

function publishSessionStatusChanged(data: SessionData, previousStatus: string | undefined, status: string): void {
  eventBus.publish({
    category: "session",
    event: "chat.stream",
    sessionKey: data.sessionKey || undefined,
    payload: {
      type: "session_status_changed",
      sessionKey: data.sessionKey || "",
      sessionId: data.id,
      status,
      previousStatus,
    },
  });

  if (previousStatus === status) return;

  eventBus.publish({
    category: "chat",
    event: "chat.session.status_changed",
    sessionKey: data.sessionKey || `dashboard:${data.id}`,
    payload: {
      sessionId: data.id,
      status,
      previousStatus,
    },
  });
}


async function syncVnextSessionSourceIfReady(data: SessionData, context: string): Promise<void> {
  if (data.status !== "saved") {
    memoryMirrorLog.debug(
      `[vnext_ingest] skip source=session sessionId=${data.id} context=${context} reason=status_not_saved status=${data.status}`,
    );
    return;
  }

  const principal = requireCurrentPrincipal();
  const { markSourceChanged } = await import("./memory/vnext-source-queue");
  await markSourceChanged("session", data.id, principal);
  memoryMirrorLog.info(
    `[vnext_ingest] queued source=session sessionId=${data.id} context=${context} messageCount=${data.messages.length}`,
  );
}

function queueVnextSessionSource(data: SessionData, context: string): void {
  const snapshot = structuredClone(data) as SessionData;
  void syncVnextSessionSourceIfReady(snapshot, context).catch((err: unknown) => {
    memoryMirrorLog.warn(
      `[vnext_ingest] queue_failed source=session sessionId=${snapshot.id} context=${context} ` +
      `error=${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

function queueSessionMemoryMirror(data: SessionData, context: string): void {
  // Compatibility alias during legacy retirement. Session sources feed vNext
  // directly; no memory_entries mirror is created or updated.
  queueVnextSessionSource(data, `${context}:compat_alias`);
}

function convToMeta(data: SessionData): FileSession {
  return {
    id: data.id,
    durableRevision: normalizeDurableRevision(data.durableRevision),
    title: data.title,
    manualTitle: data.manualTitle || undefined,
    status: data.status,
    summary: data.summary || null,
    sessionKey: data.sessionKey,
    vaultId: data.vaultId,
    modelTier: normalizeSessionModelTierOverride(data.modelTier),
    personaId: data.personaId ?? null,
    rootRevisionId: data.rootRevisionId,
    selectedPersonaRevisionId: data.selectedPersonaRevisionId,
    personaPinnedByUser: data.personaPinnedByUser ?? false,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    type: data.type,
    sessionType: data.sessionType || "user",
    isPinned: data.isPinned || false,
    pinReason: data.pinReason,
    hasUnreadResult: data.hasUnreadResult || false,
    intentionId: data.intentionId,
    voiceSessionId: data.voiceSessionId,
    meeting: data.meeting,
    meetingTranscriptCount: countMeetingTranscriptMessages(data),
    messageCount: data.messages.length,
    lastMessageRole: getLastMessageRole(data.messages),
    awaitingQuestionResponse: hasUnansweredQuestion(data.messages) || undefined,
    topics: data.topics || [],
    agenda: data.agenda,
    runStatus: data.runStatus,
    parentSessionId: data.parentSessionId,
    spawnReason: data.spawnReason,
    spawnerTool: data.spawnerTool,
    spawnerSkillRun: data.spawnerSkillRun,
    endReason: data.endReason,
    childMissionOutcome: data.childMissionOutcome,
    errorSeverity: data.errorSeverity || undefined,
    pageContext: data.pageContext,
    gitWriteOverride: data.gitWriteOverride || false,
    contextFlags: data.contextFlags || undefined,
    triggerType: data.triggerType,
    triggerId: data.triggerId,
    triggerName: data.triggerName,
    triggerAddress: data.triggerAddress,
    rootSessionId: data.rootSessionId,
    depth: data.depth,
    archivedAt: data.archivedAt || null,
    ftueWelcome: data.ftueWelcome || undefined,
    ftueRecapMeetingSessionId: data.ftueRecapMeetingSessionId || undefined,
    memoryEntryId: data.memoryEntryId ?? null,
    memoryOneLiner: data.memoryOneLiner || null,
    memorySummary: data.memorySummary || null,
  };
}

type ChatDocumentMetadata = Record<string, unknown>;

function applyTreeRowToSessionMetadata(
  session: FileSession,
  treeRow: {
    parentSessionId: string | null;
    spawnReason: string | null;
    spawnerTool: string | null;
    spawnerSkillRun: string | null;
  },
): FileSession {
  return {
    ...session,
    parentSessionId: treeRow.parentSessionId || undefined,
    spawnReason: treeRow.spawnReason || undefined,
    spawnerTool: treeRow.spawnerTool || undefined,
    spawnerSkillRun: treeRow.spawnerSkillRun || undefined,
  };
}

async function applySessionTreeRowsToMetadataList(
  docs: Array<{
    docId: string;
    title: string | null;
    createdAt: string | null;
    metadata: ChatDocumentMetadata;
    vaultId?: string | null;
  }>,
): Promise<FileSession[]> {
  if (docs.length === 0) return [];
  const sessions = docs.map(docMetadataToSession);
  try {
    const { getSessionTreeRows } = await import("./sessions/tree");
    const rows = await getSessionTreeRows(sessions.map((session) => session.id));
    if (rows.length === 0) return sessions;
    const bySessionId = new Map(rows.map((row) => [row.sessionId, row]));
    // Parent edges from the tree table are authoritative; fall back to the
    // metadata parent so limited index windows can still stitch local chains
    // without one recursive SQL per session.
    const parentById = new Map<string, string | undefined>();
    for (const session of sessions) {
      parentById.set(session.id, session.parentSessionId || undefined);
    }
    for (const row of rows) {
      parentById.set(row.sessionId, row.parentSessionId || undefined);
    }
    const rootDepthMemo = new Map<string, { rootSessionId: string; depth: number }>();
    const repaired: FileSession[] = [];
    for (const session of sessions) {
      const row = bySessionId.get(session.id);
      if (!row) {
        repaired.push(session);
        continue;
      }
      const { rootSessionId, depth } = computeRootAndDepthFromParentMap(
        session.id,
        parentById,
        rootDepthMemo,
      );
      repaired.push({
        ...applyTreeRowToSessionMetadata(session, row),
        rootSessionId: rootSessionId || row.parentSessionId || session.id,
        depth,
      });
    }
    // Intentionally no metadata rewrite on the index read path. Persisting
    // tree overlays here turned every /api/sessions miss into N sequential
    // document updates and multi-second ancestry SQL under load. Create/move
    // paths remain the writers for tree fields.
    return repaired;
  } catch (err) {
    log.warn(
      `applySessionTreeRowsToMetadataList failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return sessions;
  }
}

function metadataString(meta: ChatDocumentMetadata, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataStringArray(meta: ChatDocumentMetadata, key: string): string[] {
  const value = meta[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function metadataNumber(meta: ChatDocumentMetadata, key: string): number | undefined {
  const value = meta[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataBool(meta: ChatDocumentMetadata, key: string): boolean {
  return meta[key] === true;
}

function docMetadataToSession(doc: {
  docId: string;
  title: string | null;
  createdAt: string | null;
  metadata: ChatDocumentMetadata;
  vaultId?: string | null;
}): FileSession {
  const meta = doc.metadata || {};
  const createdAt =
    metadataString(meta, "createdAt") || doc.createdAt || new Date().toISOString();
  const updatedAt = metadataString(meta, "updatedAt") || createdAt;

  return {
    id: doc.docId,
    durableRevision: normalizeDurableRevision(meta.durableRevision),
    title: doc.title || metadataString(meta, "title") || "Untitled",
    manualTitle: metadataBool(meta, "manualTitle") || undefined,
    status: metadataString(meta, "status") || "saved",
    summary: metadataString(meta, "summary") || null,
    sessionKey: metadataString(meta, "sessionKey") || null,
    vaultId: doc.vaultId || undefined,
    modelTier: normalizeSessionModelTierOverride(metadataString(meta, "modelTier")),
    personaId: metadataNumber(meta, "personaId") ?? null,
    rootRevisionId: metadataString(meta, "rootRevisionId"),
    selectedPersonaRevisionId: metadataString(meta, "selectedPersonaRevisionId"),
    personaPinnedByUser: metadataBool(meta, "personaPinnedByUser"),
    createdAt,
    updatedAt,
    type: metadataString(meta, "type") as "text" | "voice" | undefined,
    sessionType: (metadataString(meta, "sessionType") as SessionType | undefined) || "user",
    isPinned: metadataBool(meta, "isPinned") || metadataBool(meta, "needsAttention"),
    pinReason: metadataString(meta, "pinReason") || metadataString(meta, "attentionReason"),
    hasUnreadResult: metadataBool(meta, "hasUnreadResult"),
    intentionId: metadataString(meta, "intentionId"),
    voiceSessionId: metadataString(meta, "voiceSessionId"),
    meeting: meta.meeting as MeetingSessionMeta | undefined,
    meetingTranscriptCount: metadataNumber(meta, "meetingTranscriptCount"),
    messageCount: metadataNumber(meta, "messageCount") || 0,
    lastMessageRole: toLastMessageRole(metadataString(meta, "lastMessageRole")),
    awaitingQuestionResponse: metadataBool(meta, "awaitingQuestionResponse") || undefined,
    topics: metadataStringArray(meta, "topics"),
    agenda: meta.agenda as SessionAgenda | undefined,
    runStatus: metadataString(meta, "runStatus") as RunStatus | undefined,
    parentSessionId: metadataString(meta, "parentSessionId"),
    spawnReason: metadataString(meta, "spawnReason"),
    spawnerTool: metadataString(meta, "spawnerTool"),
    spawnerSkillRun: metadataString(meta, "spawnerSkillRun"),
    endReason: metadataString(meta, "endReason"),
    childMissionOutcome: metadataString(meta, "childMissionOutcome") as import("@shared/models/chat").ChildMissionTerminalOutcome | undefined,
    errorSeverity: metadataString(meta, "errorSeverity") as "warning" | "error" | undefined,
    pageContext: meta.pageContext as PageContext | undefined,
    gitWriteOverride: metadataBool(meta, "gitWriteOverride"),
    contextFlags: meta.contextFlags as Record<string, boolean> | undefined,
    triggerType: meta.triggerType as import("@shared/models/chat").TriggerType | undefined,
    triggerId: metadataString(meta, "triggerId"),
    triggerName: metadataString(meta, "triggerName"),
    triggerAddress: metadataString(meta, "triggerAddress"),
    rootSessionId: metadataString(meta, "rootSessionId"),
    depth: metadataNumber(meta, "depth"),
    archivedAt: (meta.archivedAt as string | null | undefined) || null,
    ftueWelcome: metadataBool(meta, "ftueWelcome") || undefined,
    ftueRecapMeetingSessionId: metadataString(meta, "ftueRecapMeetingSessionId"),
    memoryEntryId: metadataNumber(meta, "memoryEntryId") ?? null,
    memoryOneLiner: metadataString(meta, "memoryOneLiner") || null,
    memorySummary: metadataString(meta, "memorySummary") || null,
  };
}

export async function rebuildIndex(): Promise<void> {
  const docs = await documentStorage.getDocumentsByType("chat");
  log.log(`Index rebuilt from DB: ${docs.length} sessions`);
}

export interface IChatFileStorage {
  getSession(id: string): Promise<FileSession | undefined>;
  getSessionSnapshot(id: string): Promise<{ session: FileSession; messages: FileMessage[] } | null>;
  getSessions(ids: string[]): Promise<FileSession[]>;
  getSavedSessions(): Promise<FileSession[]>;
  getAllSessions(limit?: number): Promise<FileSession[]>;
  getSessionsForView(
    view: "primary" | "past" | "snooze" | "archive",
    snoozedSessionIds: string[],
    limit?: number,
  ): Promise<FileSession[]>;
  createSession(
    title: string,
    sessionKey?: string,
    modelTier?: string,
    options?: {
      sessionType?: SessionType;
      pageContext?: PageContext;
      provenance?: SessionProvenanceInput;
      ftueWelcome?: boolean;
      ftueRecapMeetingSessionId?: string;
      personaId?: number | null;
      agenda?: SessionAgenda;
    },
  ): Promise<FileSession>;
  createSessionOnce(
    title: string,
    sessionKey: string,
    modelTier?: string,
    options?: {
      sessionType?: SessionType;
      pageContext?: PageContext;
      provenance?: SessionProvenanceInput;
      ftueWelcome?: boolean;
      ftueRecapMeetingSessionId?: string;
      personaId?: number | null;
      agenda?: SessionAgenda;
    },
  ): Promise<{ outcome: "created" | "existing"; session: FileSession }>;
  updatePageContext(id: string, pageContext: PageContext): Promise<void>;
  createVoiceSession(
    title: string,
    voiceSessionId: string,
    transcript: Array<{ source: string; message: string; timestamp?: string }>,
    toolCalls?: Array<{
      name: string;
      parameters: Record<string, unknown>;
      result: string;
      timestamp: string;
    }>,
    summary?: string,
  ): Promise<FileSession>;
  deleteSession(id: string): Promise<SessionDeletionResult>;
  saveSession(id: string, title: string, options?: { source?: "manual" | "auto" | "orient"; respectManualTitle?: boolean }): Promise<number | undefined>;
  updateSessionTitle(id: string, title: string, options?: { source?: "manual" | "auto" | "orient"; respectManualTitle?: boolean }): Promise<void>;
  updateSessionSessionKey(id: string, sessionKey: string): Promise<void>;
  updateSessionTopics(id: string, topics: string[]): Promise<void>;
  setSessionAgenda(id: string, items: SessionAgendaItemInput[]): Promise<FileSession | null>;
  clearSessionAgenda(id: string): Promise<FileSession | null>;
  updateSessionAgendaItem(id: string, itemId: string | null | undefined, patch: SessionAgendaItemPatch): Promise<FileSession | null>;
  updateSessionPersona(id: string, personaId: number): Promise<void>;
  setSessionPersonaIfUnset(id: string, personaId: number): Promise<{ personaId: number; applied: boolean } | null>;
  setSessionPersonaPin(id: string, personaId: number | null): Promise<boolean>;
  clearSession(sessionKey: string): Promise<boolean>;
  updateModelTier(sessionKey: string, tier: string): Promise<boolean>;
  updateSessionStatus(id: string, status: string, summary?: string): Promise<void>;
  getMessagesBySession(sessionId: string): Promise<FileMessage[]>;
  createMessage(
    sessionId: string,
    role: string,
    content: string,
    thinking?: string,
    toolCalls?: unknown,
    model?: string,
    systemSteps?: SystemStepRecord[],
    cost?: number,
    apiCallCount?: number,
    segmentChronology?: SegmentChronologyEntry[],
    isError?: boolean,
    pageContext?: PageContext,
    tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number },
    visibility?: MessageVisibility,
    turnId?: string,
    persona?: PersonaSnapshot,
    contextPressure?: ContextPressureSnapshot,
  ): Promise<FileMessage | null>;
  createAssistantArtifactMessageOnce(
    sessionId: string,
    content: string,
    artifactKey: string,
  ): Promise<
    | { outcome: "created" | "duplicate"; message: FileMessage }
    | { outcome: "session_not_found" }
  >;
  applyVoiceFinalizationAnnotations(
    sessionId: string,
    voiceSessionId: string,
    input: { errorMessage?: string; systemSteps?: SystemStepRecord[] },
  ): Promise<{ outcome: "applied" | "unchanged" | "session_not_found" }>;
  createUserMessageOnce(
    sessionId: string,
    content: string,
    clientTurnId: string,
    pageContext?: PageContext,
    questionResponse?: QuestionResponseMeta,
    questionCancellation?: QuestionCancellationMeta,
    questionPrompt?: QuestionPrompt,
  ): Promise<
    | { outcome: "created"; message: FileMessage; decisionId?: string }
    | { outcome: "duplicate"; message: FileMessage; decisionId?: string }
    | { outcome: "question_already_answered"; message: FileMessage; decisionId?: string }
    | { outcome: "session_not_found" }
  >;
  recordQuestionCancellation(
    sessionId: string,
    reason: QuestionCancelReason,
  ): Promise<
    | { outcome: "cancelled"; questionToolCallId: string }
    | { outcome: "no_active_question" }
    | { outcome: "session_not_found" }
  >;
  upsertVoiceUserMessage(
    sessionId: string,
    content: string,
    voice: VoiceMessageMeta,
  ): Promise<FileMessage | null>;
  createMeetingSession(
    title: string,
    meeting: MeetingSessionMeta,
    sessionKey?: string,
  ): Promise<FileSession>;
  createMeetingSessionOnce(
    title: string,
    meeting: MeetingSessionMeta,
    sessionKey: string,
  ): Promise<{ outcome: "created" | "existing"; session: FileSession }>;
  findMeetingSessionForOccurrence(input: {
    occurrenceKey: string;
    calendarAccountId?: string;
    calendarId?: string;
    providerEventId?: string;
  }): Promise<FileSession | null>;
  findNativeMeetingSessionByIdempotencyKey(idempotencyKey: string): Promise<FileSession | null>;
  updateMeetingMeta(
    sessionId: string,
    patch: Partial<MeetingSessionMeta>,
  ): Promise<FileSession | null>;
  moveMeetingToVault(
    sessionId: string,
    vaultId: string,
    libraryNodePageId: string,
  ): Promise<FileSession | null>;
  claimMeetingLeave(sessionId: string): Promise<MeetingLeaveClaim>;
  restoreMeetingLeave(
    sessionId: string,
    previousStatus: MeetingSessionMeta["botStatus"],
    statusDetail?: string,
  ): Promise<FileSession | null>;
  claimMeetingRecap(sessionId: string): Promise<MeetingRecapClaim>;
  registerMeetingParticipant(
    sessionId: string,
    candidate: MeetingParticipant,
  ): Promise<{ participant: MeetingParticipant; participants: MeetingParticipant[]; added: boolean } | null>;
  assignMeetingParticipantPerson(
    sessionId: string,
    speakerKey: string,
    person: { id: string; name: string } | null,
  ): Promise<MeetingSpeakerAssignment>;
  initializeMeetingAudioSourcePolicy(
    sessionId: string,
    sourceKey: string,
    mode: MeetingAudioSourceMode,
  ): Promise<FileSession | null>;
  setMeetingAudioSourcePolicy(
    sessionId: string,
    sourceKey: string,
    mode: MeetingAudioSourceMode,
    mutationId: string,
  ): Promise<MeetingAudioSourcePolicyMutation>;
  createMeetingUserMessage(
    sessionId: string,
    content: string,
    speaker: MessageSpeakerMeta,
    turnId?: string,
    enrollment?: {
      sessionKey: string;
      speakerKey: string;
      speakerLabel: string;
      participationMode?: "contextual" | "always";
      executionAffinityBootId?: string;
    },
  ): Promise<
    | { outcome: "created" | "duplicate"; message: FileMessage }
    | { outcome: "session_not_found" }
  >;
  createAssistantDraft(
    sessionId: string,
    opts?: {
      model?: string;
      runId?: string;
      systemSteps?: SystemStepRecord[];
      segmentChronology?: SegmentChronologyEntry[];
    },
  ): Promise<FileMessage | null>;
  updateAssistantDraft(
    sessionId: string,
    messageId: string,
    updates: {
      content?: string;
      thinking?: string;
      toolCalls?: unknown;
      model?: string;
      persona?: PersonaSnapshot;
      systemSteps?: SystemStepRecord[];
      cost?: number;
      apiCallCount?: number;
      segmentChronology?: SegmentChronologyEntry[];
      assistantState?: AssistantMessageState;
      /** Atomically settle the owning Session with the terminal assistant write. */
      sessionStatus?: "saved" | "failed";
      assistantInterruptedAt?: string;
    },
  ): Promise<{ message: FileMessage | null; durableRevision: number } | null>;
  terminalizeAssistantDraft(
    sessionId: string,
    messageId: string,
    runId: string,
    state: TerminalAssistantMessageState,
    interruptedAt?: string,
  ): Promise<AssistantDraftTerminalizationOutcome>;
  reconcileInterruptedAssistantDrafts(
    sessionId?: string,
  ): Promise<{ sessionsScanned: number; draftsReconciled: number; failures: number }>;
  updateMessageContent(
    messageId: string,
    sessionId: string,
    content: string,
    thinking?: string,
    toolCalls?: unknown,
  ): Promise<void>;
  updateMessageSystemSteps(
    messageId: string,
    sessionId: string,
    systemSteps: SystemStepRecord[],
  ): Promise<void>;
  getInitialContext(id: string): Promise<string | null>;
  setInitialContext(id: string, systemPrompt: string): Promise<void>;
  createAutonomousSession(
    title: string,
    sessionType: SessionType,
    sessionKey?: string,
    modelTier?: string,
    intentionId?: string,
    spawnMeta?: SpawnMetaInput,
  ): Promise<FileSession>;
  setSessionPinned(
    id: string,
    isPinned: boolean,
    pinReason?: string,
  ): Promise<void>;
  archiveSession(id: string): Promise<void>;
  unarchiveSession(id: string): Promise<void>;
  setHasUnreadResult(id: string, hasUnreadResult: boolean): Promise<void>;
  setParentSessionId(
    id: string,
    parentSessionId: string,
    spawnMeta?: {
      spawnReason?: string;
      spawnerTool?: string;
      spawnerSkillRun?: string;
      triggerType?: TriggerType;
      triggerId?: string;
      triggerName?: string;
    },
  ): Promise<void>;
  clearParentSessionId(id: string): Promise<void>;
  setEndReason(id: string, endReason: string): Promise<void>;
  setChildMissionOutcome(
    id: string,
    outcome: import("@shared/models/chat").ChildMissionTerminalOutcome,
  ): Promise<void>;
  setErrorSeverity(
    id: string,
    severity: "warning" | "error" | null,
  ): Promise<void>;
  setGitWriteOverride(id: string, enabled: boolean): Promise<void>;
  updateSessionContextFlags(
    id: string,
    flags: Record<string, boolean>,
  ): Promise<void>;
  readSessionContextFlags(id: string): Promise<Record<string, boolean> | null>;
  updateSessionMemoryIndex(id: string, oneLiner: string | null, memorySummary?: string | null): Promise<void>;
  moveSessionToVault(id: string, vaultId: string): Promise<FileSession>;
  setSessionMemoryEntryId(id: string, memoryEntryId: number): Promise<void>;
  syncSessionMemoryMirror(id: string): Promise<void>;
  compactSession(
    sessionId: string,
    summaryContent: string,
    removedMessageIds: string[],
    meta?: Partial<CompactionMeta>,
  ): Promise<{
    outcome: "compacted" | "session_not_found" | "invalid_boundary" | "snapshot_changed";
    compacted: boolean;
    messagesBefore: number;
    messagesAfter: number;
    markerId?: string;
  }>;
  repairOversizedContextPayloads(
    sessionId: string,
    opts?: { maxInlineTokens?: number; reason?: string },
  ): Promise<{
    repaired: boolean;
    messagesScanned: number;
    payloadsRepaired: number;
    tokensBefore: number;
    tokensAfter: number;
  }>;
  createCrossSessionMessage(
    fromSessionId: string,
    toSessionId: string,
    content: string,
    direction: "sibling" | "parent" | "child" | "direct",
    chain?: { chainId: string; depth: number },
  ): Promise<{
    fromMessage: FileMessage | null;
    toMessage: FileMessage | null;
  }>;
  createChildSessionBlockMessage(
    parentSessionId: string,
    meta: ChildSessionBlockMeta,
  ): Promise<string | null>;
  updateChildSessionBlockMessage(
    parentSessionId: string,
    childSessionId: string,
    updates: Partial<ChildSessionBlockMeta>,
  ): Promise<boolean>;
  deleteChildSessionBlockMessage(
    parentSessionId: string,
    childSessionId: string,
  ): Promise<boolean>;
  deleteMessage(sessionId: string, messageId: string): Promise<boolean>;
}

async function resolvePersonaProvenance(personaId: number | null | undefined): Promise<{ rootRevisionId?: string; selectedPersonaRevisionId?: string }> {
  const { personaStorage } = await import("./file-storage/persona-storage");
  const [root, selected] = await Promise.all([
    personaStorage.getSystemSeedByName("Root"),
    personaId ? personaStorage.get(personaId) : Promise.resolve(null),
  ]);
  return {
    rootRevisionId: root?.currentRevisionId ?? undefined,
    selectedPersonaRevisionId: selected?.currentRevisionId ?? undefined,
  };
}

async function resolvePersonaSnapshot(personaId: number | null | undefined): Promise<PersonaSnapshot | undefined> {
  if (!personaId) return undefined;
  try {
    const { personaStorage } = await import("./file-storage/persona-storage");
    const persona = await personaStorage.get(personaId);
    return persona ? { id: persona.id, revisionId: persona.currentRevisionId ?? undefined, name: persona.name, icon: persona.icon } : undefined;
  } catch (err) {
    log.warn(`resolvePersonaSnapshot failed personaId=${personaId}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function nextOrdinalLabel(participants: MeetingParticipant[], prefix: string): string {
  const pattern = /^(?:unknown speaker|speaker) (\d+)$/i;
  const ordinals = new Set(
    participants
      .map((participant) => participant.label.match(pattern)?.[1])
      .filter((ordinal): ordinal is string => Boolean(ordinal)),
  );
  let ordinal = participants.length + 1;
  while (ordinals.has(String(ordinal))) ordinal += 1;
  return `${prefix} ${ordinal}`;
}

function nextGenericSpeakerLabel(participants: MeetingParticipant[]): string {
  return nextOrdinalLabel(participants, "Speaker");
}

export const chatFileStorage: IChatFileStorage = {
  async getSession(id: string) {
    return _sessionsCache.getOrFetch(`session:${principalCacheKey()}:${id}`, async () => {
      const data = await readConv(id);
      if (!data) return undefined as any;
      return convToMeta(data);
    });
  },

  async getSessionSnapshot(id: string) {
    const data = await readConv(id);
    if (!data) return null;
    return { session: convToMeta(data), messages: data.messages };
  },

  async getSessions(ids: string[]) {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (uniqueIds.length === 0) return [];
    const cachePrefix = `session:${principalCacheKey()}:`;
    const sessionById = new Map<string, FileSession>();
    const missingIds: string[] = [];

    for (const id of uniqueIds) {
      const cached = _sessionsCache.get(`${cachePrefix}${id}`) as FileSession | undefined;
      if (cached) sessionById.set(id, cached);
      else missingIds.push(id);
    }

    const tree = await import("./sessions/tree");
    for (let index = 0; index < missingIds.length; index += SESSION_READ_BATCH_SIZE) {
      const batch = missingIds.slice(index, index + SESSION_READ_BATCH_SIZE);
      // Read documents before tree overlays so even the canonical batch path
      // never submits more than one database operation at a time.
      const documents = await documentStorage.getDocuments("chat", batch);
      const parsedSessions = documents.flatMap((document) => {
        const data = parseConvDocument(document.docId, document);
        return data ? [data] : [];
      });
      const treeRows = await tree.getSessionTreeRows(parsedSessions.map((session) => session.id));
      const treeBySessionId = new Map(treeRows.map((row) => [row.sessionId, row]));

      for (const data of parsedSessions) {
        const treeRow = treeBySessionId.get(data.id);
        if (treeRow) applyIndexedSessionTreeOverlay(data, treeRow);
      }

      // Legacy repair is intentionally sequential. It is rare after migration
      // and must never recreate the unbounded write fan-out this batch API removes.
      for (const data of parsedSessions) {
        if (!treeBySessionId.has(data.id)) {
          try {
            await repairLegacySessionTreeMetadata(data);
          } catch {
            // Best-effort compatibility repair; the authorized document remains usable.
          }
        }
        const session = convToMeta(data);
        sessionById.set(session.id, session);
        _sessionsCache.set(`${cachePrefix}${session.id}`, session);
      }
    }

    return uniqueIds.flatMap((id) => {
      const session = sessionById.get(id);
      return session ? [session] : [];
    });
  },

  async getSavedSessions() {
    return _sessionsCache.getOrFetch(`saved:${principalCacheKey()}`, async () => {
      const docs = await documentStorage.getDocumentsMetadataOnly("chat");
      const sessions = await applySessionTreeRowsToMetadataList(docs);
      return sessions
        .filter((session) => session.status === "saved")
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
    });
  },

  async getAllSessions(limit?: number) {
    const boundedLimit = limit === undefined ? undefined : Math.min(Math.max(Math.floor(limit), 1), 5_000);
    return _sessionsCache.getOrFetch(`all:${principalCacheKey()}:${boundedLimit ?? "all"}`, async () => {
      const docs = await documentStorage.getDocumentsMetadataOnly("chat", undefined, boundedLimit);
      const sessions = await applySessionTreeRowsToMetadataList(docs);
      return sessions
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
    });
  },

  async getSessionsForView(view, snoozedSessionIds, limit = view === "primary" ? 250 : 5_000) {
    const principal = requireCurrentPrincipal();
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 5_000);
    const snoozed = [...new Set(snoozedSessionIds.filter(Boolean))];
    const isSnoozed = snoozed.length > 0
      ? inArray(documentStoreDocuments.documentId, snoozed)
      : sql`FALSE`;
    const isArchived = sql`${documentStoreDocuments.metadata}->>'archivedAt' IS NOT NULL`;
    const isPrimary = and(
      sql`NOT (${isArchived})`,
      sql`NOT (${isSnoozed})`,
      or(
        sql`${documentStoreDocuments.updatedAt} >= NOW() - INTERVAL '7 days'`,
        sql`${documentStoreDocuments.metadata}->>'isPinned' = 'true'`,
        sql`${documentStoreDocuments.metadata}->>'status' = 'streaming'`,
        sql`${documentStoreDocuments.metadata}->>'awaitingReview' = 'true'`,
        sql`${documentStoreDocuments.metadata}->>'awaitingQuestionResponse' = 'true'`,
      ),
    );
    const viewPredicate = view === "primary"
      ? isPrimary
      : view === "past"
        ? and(sql`NOT (${isArchived})`, sql`NOT (${isSnoozed})`, sql`NOT (${isPrimary})`)
        : view === "snooze"
          ? isSnoozed
          : isArchived;
    const rows = await db
      .select({
        docId: documentStoreDocuments.documentId,
        title: documentStoreDocuments.title,
        createdAt: documentStoreDocuments.createdAt,
        metadata: documentStoreDocuments.metadata,
        ownerUserId: documentStoreDocuments.ownerUserId,
        accountId: documentStoreDocuments.accountId,
        vaultId: documentStoreDocuments.vaultId,
      })
      .from(documentStoreDocuments)
      .where(combineWithVisibleScope(
        principal,
        {
          scope: documentStoreDocuments.scope,
          ownerUserId: documentStoreDocuments.ownerUserId,
          accountId: documentStoreDocuments.accountId,
          vaultId: documentStoreDocuments.vaultId,
        },
        and(eq(documentStoreDocuments.documentType, "chat"), viewPredicate),
      ))
      .orderBy(sql`${documentStoreDocuments.updatedAt} DESC`)
      .limit(boundedLimit);
    const docs = rows.map((row) => ({
      id: 0,
      docId: row.docId,
      title: row.title,
      createdAt: row.createdAt?.toISOString() ?? null,
      metadata: row.metadata as Record<string, unknown>,
      ownerUserId: row.ownerUserId,
      accountId: row.accountId,
      vaultId: row.vaultId,
    }));

    // Bounded working sets (primary/past) can include a recently-active child
    // whose parent falls outside the window. Without the parent in the set, the
    // menu treats the child as an orphaned root and floats it into "Recent"
    // instead of nesting it. Hydrate the ancestor chain of every returned
    // session so the tree stitches correctly. Genuinely deleted parents remain
    // absent and are surfaced as orphans by the client, which is intended.
    if (view === "primary") {
      const loaded = new Set(docs.map((d) => d.docId));
      let frontier = docs
        .map((d) => (d.metadata?.["parentSessionId"] as string | undefined))
        .filter((pid): pid is string => !!pid && !loaded.has(pid));
      let guard = 0;
      while (frontier.length > 0 && guard < 8) {
        guard += 1;
        const missing = [...new Set(frontier)].filter((id) => !loaded.has(id));
        if (missing.length === 0) break;
        const ancestorRows = await db
          .select({
            docId: documentStoreDocuments.documentId,
            title: documentStoreDocuments.title,
            createdAt: documentStoreDocuments.createdAt,
            metadata: documentStoreDocuments.metadata,
            ownerUserId: documentStoreDocuments.ownerUserId,
            accountId: documentStoreDocuments.accountId,
            vaultId: documentStoreDocuments.vaultId,
          })
          .from(documentStoreDocuments)
          .where(combineWithVisibleScope(
            principal,
            {
              scope: documentStoreDocuments.scope,
              ownerUserId: documentStoreDocuments.ownerUserId,
              accountId: documentStoreDocuments.accountId,
              vaultId: documentStoreDocuments.vaultId,
            },
            and(
              eq(documentStoreDocuments.documentType, "chat"),
              inArray(documentStoreDocuments.documentId, missing),
            ),
          ));
        if (ancestorRows.length === 0) break;
        const nextFrontier: string[] = [];
        for (const row of ancestorRows) {
          if (loaded.has(row.docId)) continue;
          loaded.add(row.docId);
          docs.push({
            id: 0,
            docId: row.docId,
            title: row.title,
            createdAt: row.createdAt?.toISOString() ?? null,
            metadata: row.metadata as Record<string, unknown>,
            ownerUserId: row.ownerUserId,
            accountId: row.accountId,
            vaultId: row.vaultId,
          });
          const pid = (row.metadata as Record<string, unknown>)?.["parentSessionId"] as string | undefined;
          if (pid && !loaded.has(pid)) nextFrontier.push(pid);
        }
        frontier = nextFrontier;
      }
    }

    return applySessionTreeRowsToMetadataList(docs);
  },

  async createSession(
    title: string,
    sessionKey?: string,
    modelTier?: string,
    options?: {
      sessionType?: SessionType;
      pageContext?: PageContext;
      provenance?: SessionProvenanceInput;
      ftueWelcome?: boolean;
      ftueRecapMeetingSessionId?: string;
      personaId?: number | null;
      agenda?: SessionAgenda;
    },
  ) {
    const id = generateId();
    const now = new Date().toISOString();
    const provenance = normalizeSessionProvenance(
      options?.provenance,
      provenanceFromSessionType(options?.sessionType || "user", title),
    );
    const personaProvenance = await resolvePersonaProvenance(options?.personaId);
    const data: SessionData = {
      id,
      title,
      status: "saved",
      sessionKey: sessionKey || null,
      modelTier: normalizeSessionModelTierOverride(modelTier),
      personaId: options?.personaId ?? null,
      ...personaProvenance,
      createdAt: now,
      updatedAt: now,
      messages: [],
      sessionType: options?.sessionType || "user",
      isPinned: false,
      pageContext: options?.pageContext,
      ftueWelcome: options?.ftueWelcome || undefined,
      ftueRecapMeetingSessionId: options?.ftueRecapMeetingSessionId?.trim() || undefined,
      agenda: options?.agenda ? normalizeSessionAgenda(options.agenda.items) : undefined,
      triggerType: provenance.triggerType,
      triggerId: provenance.triggerId,
      triggerName: provenance.triggerName,
      triggerAddress: (await import("./execution-provenance-address")).canonicalSessionTriggerAddress(provenance.triggerType, provenance.triggerId),
      rootSessionId: id,
      depth: 0,
    };
    await writeConv(data);
    const meta = convToMeta(data);
    invalidateSessionsCache({ action: "created", sessionId: id, session: meta });
    return meta;
  },

  async createSessionOnce(
    title: string,
    sessionKey: string,
    modelTier?: string,
    options?: {
      sessionType?: SessionType;
      pageContext?: PageContext;
      provenance?: SessionProvenanceInput;
      ftueWelcome?: boolean;
      ftueRecapMeetingSessionId?: string;
      personaId?: number | null;
      agenda?: SessionAgenda;
    },
  ) {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) throw new Error("Replay-safe session creation requires a session key");
    const principal = requireCurrentPrincipal();
    if (!principal.userId || !principal.accountId || principal.actorType !== "user") {
      throw new Error("Replay-safe user session creation requires a user principal");
    }

    return db.transaction(async (transaction) => runWithDatabaseTransaction(transaction, async () => {
      await acquireAdvisoryTransactionLock(
        transaction,
        ADVISORY_LOCK_NS.CHAT_SESSION_KEY,
        `${principal.accountId}:${principal.userId}:${normalizedSessionKey}`,
      );
      const [existing] = await transaction
        .select({
          docId: documentStoreDocuments.documentId,
          title: documentStoreDocuments.title,
          createdAt: documentStoreDocuments.createdAt,
          metadata: documentStoreDocuments.metadata,
          vaultId: documentStoreDocuments.vaultId,
        })
        .from(documentStoreDocuments)
        .where(combineWithWritableScope(
          principal,
          {
            scope: documentStoreDocuments.scope,
            ownerUserId: documentStoreDocuments.ownerUserId,
            accountId: documentStoreDocuments.accountId,
            vaultId: documentStoreDocuments.vaultId,
          },
          and(
            eq(documentStoreDocuments.documentType, "chat"),
            sql`${documentStoreDocuments.metadata}->>'sessionKey' = ${normalizedSessionKey}`,
          ),
        ))
        .orderBy(documentStoreDocuments.createdAt)
        .limit(1);
      if (existing) {
        return {
          outcome: "existing" as const,
          session: docMetadataToSession({
            docId: existing.docId,
            title: existing.title,
            createdAt: existing.createdAt?.toISOString() ?? null,
            metadata: existing.metadata as ChatDocumentMetadata,
            vaultId: existing.vaultId,
          }),
        };
      }

      const session = await chatFileStorage.createSession(
        title,
        normalizedSessionKey,
        modelTier,
        options,
      );
      return { outcome: "created" as const, session };
    }));
  },

  async createVoiceSession(
    title: string,
    voiceSessionId: string,
    transcript: Array<{ source: string; message: string; timestamp?: string }>,
    toolCalls?: Array<{
      name: string;
      parameters: Record<string, unknown>;
      result: string;
      timestamp: string;
    }>,
    summary?: string,
  ) {
    const id = generateId();
    const now = new Date().toISOString();
    const messages: FileMessage[] = [];

    for (const entry of transcript) {
      if (entry.source === "user" || entry.source === "ai") {
        messages.push({
          id: generateId(),
          sessionId: id,
          role: entry.source === "ai" ? "assistant" : "user",
          content: entry.message,
          thinking: null,
          toolCalls: null,
          systemSteps: null,
          model: entry.source === "ai" ? "elevenlabs-voice" : null,
          createdAt: entry.timestamp || now,
        });
      }
    }

    if (summary) {
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      if (lastAssistant) {
        lastAssistant.content += `\n\n---\n*Session summary: ${summary}*`;
      }
    }

    const data: SessionData = {
      id,
      title,
      status: "saved",
      sessionKey: null,
      modelTier: null,
      createdAt: transcript[0]?.timestamp || now,
      updatedAt: now,
      messages,
      type: "voice",
      sessionType: "user",
      isPinned: false,
      voiceSessionId,
      triggerType: "voice",
      triggerId: voiceSessionId,
      triggerName: title,
      rootSessionId: id,
      depth: 0,
    };
    await writeConv(data);
    const meta = convToMeta(data);
    invalidateSessionsCache({ action: "created", sessionId: id, session: meta });
    return meta;
  },

  async deleteSession(id: string): Promise<SessionDeletionResult> {
    const result = await deleteSessionSubtree(id);

    for (const deletedSessionId of result.deletedSessionIds) {
      markSessionDeleted(deletedSessionId);
      invalidateSessionsCache({ action: "deleted", sessionId: deletedSessionId });
      import("./chat-markdown")
        .then((m) => m.removeChatMarkdown(deletedSessionId))
        .catch((err) => log.warn("markdown cleanup failed", err));
    }

    treeLog.log(
      `delete subtree root=${id} descendants=${result.descendantCount} total=${result.deletedSessionIds.length}`,
    );
    return result;
  },

  async saveSession(id: string, title: string, options?: { source?: "manual" | "auto" | "orient"; respectManualTitle?: boolean }) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      const source = options?.source || "auto";
      const shouldRespectManualTitle = options?.respectManualTitle !== false;
      if (source === "manual") {
        data.title = title;
        data.manualTitle = true;
      } else if (!data.manualTitle || !shouldRespectManualTitle) {
        data.title = title;
      }
      const previousStatus = data.status;
      data.status = data.type === "meeting" && (data.meeting?.botStatus === "live" || data.meeting?.botStatus === "leaving")
        ? "streaming"
        : "saved";
      if (data.status !== "streaming" || data.type !== "text") {
        data.activeRuntimeOwner = undefined;
      }
      if (data.status === "saved") data.runStatus = "resolved";
      data.updatedAt = new Date().toISOString();
      const durableRevision = await writeConv(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session: convToMeta(data) });
      publishSessionStatusChanged(data, previousStatus, data.status);
      queueVnextSessionSource(data, "saveSession");
      queueSessionMemoryMirror(data, "saveSession");
      import("./chat-markdown")
        .then((m) => m.generateChatMarkdown(id))
        .catch((err) => log.warn("markdown generation failed", err));
      return durableRevision;
    });
  },

  async updateSessionTitle(id: string, title: string, options?: { source?: "manual" | "auto" | "orient"; respectManualTitle?: boolean }) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      const source = options?.source || "auto";
      const shouldRespectManualTitle = options?.respectManualTitle !== false;
      if (source === "manual") {
        data.title = title;
        data.manualTitle = true;
      } else if (data.manualTitle && shouldRespectManualTitle) {
        log.debug(`updateSessionTitle: preserved manual title for ${id}; ignored ${source} title=${title}`);
        return;
      } else {
        data.title = title;
      }
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session: convToMeta(data) });
    });
  },

  async updateSessionSessionKey(id: string, sessionKey: string) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      data.sessionKey = sessionKey;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
    });
  },

  async updateSessionTopics(id: string, topics: string[]) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      data.topics = topics.slice(0, 8);
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
    });
  },

  async setSessionAgenda(id: string, items: SessionAgendaItemInput[]) {
    const agenda = normalizeSessionAgenda(items);
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return null;
      data.agenda = agenda;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session });
      log.info("Session agenda replaced", { sessionId: id, itemCount: agenda.items.length });
      return session;
    });
  },

  async clearSessionAgenda(id: string) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return null;
      if (!data.agenda) return convToMeta(data);
      data.agenda = undefined;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session });
      log.info("Session agenda cleared", { sessionId: id });
      return session;
    });
  },

  async updateSessionAgendaItem(id: string, itemId: string | null | undefined, patch: SessionAgendaItemPatch) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data?.agenda) return null;
      const requestedId = typeof itemId === "string" ? itemId.trim() : "";
      let resolvedId = requestedId;
      if (!resolvedId) {
        if (patch.status !== "complete") {
          throw new Error("Agenda item ID is required");
        }
        const current = data.agenda.items.find((item) => item.status === "open");
        if (!current) {
          throw new Error("No open agenda item to complete");
        }
        resolvedId = current.id;
      }
      const index = data.agenda.items.findIndex((item) => item.id === resolvedId);
      if (index < 0) {
        const validIds = data.agenda.items.map((item) => item.id);
        throw new Error(
          `Agenda item "${resolvedId}" not found. Valid agenda item IDs: ${validIds.length > 0 ? validIds.join(", ") : "none"}`,
        );
      }
      const current = data.agenda.items[index];
      const nextStatus = patch.status === undefined ? current.status : normalizeAgendaStatus(patch.status);
      const suppliedResolution = normalizeOptionalAgendaPatchText(
        patch.resolution,
        "Agenda item resolution",
        SESSION_AGENDA_RESOLUTION_MAX_CHARS,
      );
      const nextResolution = suppliedResolution ?? current.resolution;
      if (nextStatus === "complete" && !nextResolution) {
        throw new Error("Complete agenda items require a resolution");
      }
      const suppliedTitle = normalizeOptionalAgendaPatchText(
        patch.title,
        "Agenda item title",
        SESSION_AGENDA_TITLE_MAX_CHARS,
      );
      const suppliedDescription = normalizeOptionalAgendaPatchText(
        patch.description,
        "Agenda item description",
        SESSION_AGENDA_DESCRIPTION_MAX_CHARS,
      );
      const next: SessionAgendaItem = {
        id: current.id,
        title: suppliedTitle === undefined ? current.title : normalizeAgendaTitle(suppliedTitle),
        description: suppliedDescription ?? current.description,
        status: nextStatus,
        ...(nextStatus === "complete" ? { resolution: nextResolution } : {}),
      };
      data.agenda.items[index] = next;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session });
      log.info("Session agenda item updated", { sessionId: id, itemId, status: next.status });
      return session;
    });
  },


  async updateSessionPersona(id: string, personaId: number) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      data.personaId = personaId;
      Object.assign(data, await resolvePersonaProvenance(personaId));
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session: convToMeta(data) });
    });
  },

  async setSessionPersonaIfUnset(id: string, personaId: number) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return null;
      if (data.personaId) return { personaId: data.personaId, applied: false };
      data.personaId = personaId;
      Object.assign(data, await resolvePersonaProvenance(personaId));
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session: convToMeta(data) });
      return { personaId, applied: true };
    });
  },

  async setSessionPersonaPin(id: string, personaId: number | null) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return false;
      if (personaId !== null) {
        data.personaId = personaId;
        Object.assign(data, await resolvePersonaProvenance(personaId));
        data.personaPinnedByUser = true;
      } else {
        data.personaPinnedByUser = false;
      }
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session: convToMeta(data) });
      return true;
    });
  },

  async updateSessionStatus(id: string, status: string, summary?: string) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      const previousStatus = data.status;
      data.status = status;
      if (summary !== undefined) {
        data.summary = summary;
      }
      if (status === "streaming") {
        data.runStatus = "active";
        if ((data.type || "text") === "text") {
          data.activeRuntimeOwner = getRuntimeOwner();
        }
      } else {
        data.activeRuntimeOwner = undefined;
        if (status === "failed") data.runStatus = "failed";
        if (status === "saved") data.runStatus = "resolved";
      }
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session: convToMeta(data) });
      queueVnextSessionSource(data, "updateSessionStatus");
      queueSessionMemoryMirror(data, "updateSessionStatus");
      publishSessionStatusChanged(data, previousStatus, status);
    });
  },

  async clearSession(sessionKey: string) {
    const docs = await documentStorage.getDocumentsByType("chat");
    const match = docs.find((d) => {
      const meta = d.metadata as Record<string, unknown>;
      return (
        ((meta?.sessionKey as string) || `dashboard:${d.docId}`) === sessionKey
      );
    });
    if (!match) return false;
    return withConvLock(match.docId, async () => {
      const data = await readConv(match.docId);
      if (!data) return false;
      data.messages = [];
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
      return true;
    });
  },

  async updateModelTier(sessionKey: string, tier: string) {
    const docs = await documentStorage.getDocumentsByType("chat");
    const match = docs.find((d) => {
      const meta = d.metadata as Record<string, unknown>;
      return (
        ((meta?.sessionKey as string) || `dashboard:${d.docId}`) === sessionKey
      );
    });
    if (!match) return false;
    return withConvLock(match.docId, async () => {
      const data = await readConv(match.docId);
      if (!data) return false;
      data.modelTier = normalizeSessionModelTierOverride(tier);
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
      return true;
    });
  },

  async getMessagesBySession(sessionId: string) {
    const initial = await readConv(sessionId);
    if (!initial) return [];
    const firstMarkerIdx = initial.messages.findIndex(
      (message) => message.model === "compaction-marker",
    );
    if (firstMarkerIdx <= 0) {
      if (firstMarkerIdx === 0) {
        log.debug(
          `getMessagesBySession sessionId=${sessionId} hasCompactionMarker=true totalMessages=${initial.messages.length}`,
        );
      }
      return initial.messages;
    }
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) return [];
      const currentMarkerIdx = data.messages.findIndex(
        (message) => message.model === "compaction-marker",
      );
      if (currentMarkerIdx > 0) {
        log.warn(
          `getMessagesBySession sessionId=${sessionId} compaction marker at index ${currentMarkerIdx}; normalizing durably`,
        );
        data.messages = data.messages.slice(currentMarkerIdx);
        data.updatedAt = new Date().toISOString();
        await writeConv(data);
        invalidateSessionsCache();
      }
      return data.messages;
    });
  },

  async createMessage(
    sessionId: string,
    role: string,
    content: string,
    thinking?: string,
    toolCalls?: unknown,
    model?: string,
    systemSteps?: SystemStepRecord[],
    cost?: number,
    apiCallCount?: number,
    segmentChronology?: SegmentChronologyEntry[],
    isError?: boolean,
    pageContext?: PageContext,
    tokenUsage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    },
    visibility?: MessageVisibility,
    turnId?: string,
    frozenPersona?: PersonaSnapshot,
    contextPressure?: ContextPressureSnapshot,
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) {
        log.warn(
          `[ChatFileStorage] createMessage: session ${sessionId} not found, skipping`,
        );
        return null;
      }
      if (role === "assistant" && model === "elevenlabs-voice" && turnId) {
        const existing = data.messages.find(
          (message) => message.role === "assistant" && message.turnId === turnId,
        );
        if (existing) {
          log.debug(
            `[ChatFileStorage] duplicate voice assistant turn ignored session=${sessionId} turnId=${turnId}`,
          );
          return existing;
        }
      }
      const sanitizedContent =
        role === "assistant" ? stripRoleMarkers(content, sessionId) : content;
      const alignedSegmentChronology =
        role === "assistant"
          ? alignAssistantChronology(
              segmentChronology,
              sanitizedContent,
              sessionId,
            )
          : segmentChronology;

      // Diagnostic messages bypass the renderable-payload guard — they are
      // intentionally stored as non-chat-visible forensic records.
      if (role === "assistant" && visibility !== "diagnostic" && !hasRenderableAssistantPayload({
        content: sanitizedContent,
        thinking,
        toolCalls,
        systemSteps,
        segmentChronology: alignedSegmentChronology,
      })) {
        log.warn(
          `[ChatFileStorage] createMessage rejected empty chat-visible assistant row sessionId=${sessionId}`,
        );
        return null;
      }
      const persona = role === "assistant"
        ? frozenPersona ?? await resolvePersonaSnapshot(data.personaId)
        : undefined;
      const msg: FileMessage = {
        id: generateId(),
        sessionId,
        role,
        content: sanitizedContent,
        thinking: thinking || null,
        toolCalls: toolCalls || null,
        systemSteps: systemSteps && systemSteps.length > 0 ? systemSteps : null,
        model: model || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cost: cost != null ? cost : null,
        apiCallCount: apiCallCount != null ? apiCallCount : null,
        inputTokens: tokenUsage?.inputTokens ?? null,
        outputTokens: tokenUsage?.outputTokens ?? null,
        totalTokens: tokenUsage?.totalTokens ?? null,
        contextPressure: contextPressure ?? null,
        segmentChronology:
          alignedSegmentChronology && alignedSegmentChronology.length > 0
            ? alignedSegmentChronology
            : null,
      };
      if (persona) msg.persona = persona;
      if (isError) msg.isError = true;
      if (visibility && visibility !== "chat") msg.visibility = visibility;
      if (pageContext && role === "user") msg.pageContext = pageContext;
      if (turnId) msg.turnId = turnId;
      const matchingUserIndex = role === "assistant" && model === "elevenlabs-voice" && turnId
        ? data.messages.findIndex(
            (message) => message.role === "user" && message.turnId === turnId,
          )
        : -1;
      if (matchingUserIndex >= 0) {
        data.messages.splice(matchingUserIndex + 1, 0, msg);
      } else {
        data.messages.push(msg);
      }
      data.updatedAt = msg.createdAt;
      await writeConv(data);
      invalidateSessionsCache();
      return msg;
    });
  },


  async createAssistantArtifactMessageOnce(
    sessionId: string,
    content: string,
    artifactKey: string,
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) return { outcome: "session_not_found" as const };

      const existing = data.messages.find(
        (message) =>
          message.role === "assistant" && message.artifactKey === artifactKey,
      );
      if (existing) {
        log.debug(
          `[ChatFileStorage] duplicate assistant artifact ignored session=${sessionId} artifactKey=${artifactKey}`,
        );
        return { outcome: "duplicate" as const, message: existing };
      }

      const sanitizedContent = stripRoleMarkers(content, sessionId);
      if (!hasRenderableAssistantPayload({ content: sanitizedContent })) {
        throw new Error(`Assistant artifact ${artifactKey} has no renderable content`);
      }
      const now = new Date().toISOString();
      const message: FileMessage = {
        id: generateId(),
        sessionId,
        role: "assistant",
        content: sanitizedContent,
        thinking: null,
        toolCalls: null,
        systemSteps: null,
        model: null,
        createdAt: now,
        updatedAt: now,
        artifactKey,
        persona: await resolvePersonaSnapshot(data.personaId),
      };
      data.messages.push(message);
      data.updatedAt = now;
      await writeConv(data);
      invalidateSessionsCache();
      eventBus.publish({
        category: "system",
        event: "data:session_messages_changed",
        payload: { source: "chat_storage", sessionId, messageId: message.id },
      });
      return { outcome: "created" as const, message };
    });
  },


  async applyVoiceFinalizationAnnotations(
    sessionId: string,
    voiceSessionId: string,
    input: { errorMessage?: string; systemSteps?: SystemStepRecord[] },
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) return { outcome: "session_not_found" as const };

      let changed = data.voiceSessionId !== voiceSessionId;
      data.voiceSessionId = voiceSessionId;
      if (input.errorMessage) {
        const artifactKey = `voice-finalization-error:${voiceSessionId}`;
        const existing = data.messages.some(
          (message) => message.role === "assistant" && message.artifactKey === artifactKey,
        );
        if (!existing) {
          const now = new Date().toISOString();
          data.messages.push({
            id: generateId(),
            sessionId,
            role: "assistant",
            content: stripRoleMarkers(input.errorMessage, sessionId),
            thinking: null,
            toolCalls: null,
            systemSteps: input.systemSteps?.length ? input.systemSteps : null,
            model: null,
            createdAt: now,
            updatedAt: now,
            artifactKey,
            isError: true,
            persona: await resolvePersonaSnapshot(data.personaId),
          });
          data.updatedAt = now;
          changed = true;
        }
      } else if (input.systemSteps?.length) {
        const lastAssistant = [...data.messages]
          .reverse()
          .find((message) => message.role === "assistant");
        if (lastAssistant) {
          const existingSteps = lastAssistant.systemSteps || [];
          const existingKeys = new Set(
            existingSteps.map((step) => `${step.name}:${step.status}:${step.detail || ""}`),
          );
          const missingSteps = input.systemSteps.filter(
            (step) => !existingKeys.has(`${step.name}:${step.status}:${step.detail || ""}`),
          );
          if (missingSteps.length > 0) {
            lastAssistant.systemSteps = [...existingSteps, ...missingSteps];
            lastAssistant.updatedAt = new Date().toISOString();
            data.updatedAt = lastAssistant.updatedAt;
            changed = true;
          }
        } else {
          const now = new Date().toISOString();
          data.messages.push({
            id: generateId(),
            sessionId,
            role: "assistant",
            content: "",
            thinking: null,
            toolCalls: null,
            systemSteps: input.systemSteps,
            model: null,
            createdAt: now,
            updatedAt: now,
            artifactKey: `voice-finalization-steps:${voiceSessionId}`,
            persona: await resolvePersonaSnapshot(data.personaId),
          });
          data.updatedAt = now;
          changed = true;
        }
      }

      if (!changed) return { outcome: "unchanged" as const };
      await writeConv(data);
      invalidateSessionsCache();
      eventBus.publish({
        category: "system",
        event: "data:session_messages_changed",
        payload: { source: "voice_finalize", sessionId },
      });
      return { outcome: "applied" as const };
    });
  },


  async createUserMessageOnce(
    sessionId: string,
    content: string,
    clientTurnId: string,
    pageContext?: PageContext,
    questionResponse?: QuestionResponseMeta,
    questionCancellation?: QuestionCancellationMeta,
    questionPrompt?: QuestionPrompt,
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) return { outcome: "session_not_found" as const };

      const existing = data.messages.find(
        (message) => message.role === "user" && message.turnId === clientTurnId,
      );
      if (existing) {
        log.debug(`[ChatFileStorage] duplicate client turn ignored session=${sessionId} turnId=${clientTurnId}`);
        return {
          outcome: "duplicate" as const,
          message: existing,
          ...(existing.questionResponse?.decisionId
            ? { decisionId: existing.questionResponse.decisionId }
            : {}),
        };
      }
      if (questionResponse) {
        const priorResponse = data.messages.find(
          (message) => message.questionResponse?.questionToolCallId === questionResponse.questionToolCallId,
        );
        if (priorResponse) {
          log.warn(`[ChatFileStorage] duplicate question response blocked session=${sessionId} toolCallId=${questionResponse.questionToolCallId}`);
          return {
            outcome: "question_already_answered" as const,
            message: priorResponse,
            ...(priorResponse.questionResponse?.decisionId
              ? { decisionId: priorResponse.questionResponse.decisionId }
              : {}),
          };
        }
      }

      // Only stamp a supersession cancellation when the referenced question is
      // still the active one — never re-cancel an already-resolved prompt.
      const effectiveCancellation =
        questionCancellation &&
        getActiveQuestionToolCallId(data.messages) === questionCancellation.questionToolCallId
          ? questionCancellation
          : undefined;

      const now = new Date().toISOString();
      const message: FileMessage = {
        id: generateId(),
        sessionId,
        role: "user",
        content,
        thinking: null,
        toolCalls: null,
        systemSteps: null,
        model: null,
        createdAt: now,
        updatedAt: now,
        turnId: clientTurnId,
        ...(pageContext ? { pageContext } : {}),
        ...(questionResponse ? { questionResponse } : {}),
        ...(effectiveCancellation ? { questionCancellation: effectiveCancellation } : {}),
      };
      let decisionId: string | undefined;
      if (questionResponse && questionPrompt) {
        const currentPrinciples = await filePrincipleStorage.getPrinciples();
        const currentRevisionByPrincipleId = new Map(
          currentPrinciples.map((principle) => [principle.id, principle.currentRevisionId]),
        );
        const promptPrincipleByRevisionId = new Map(
          questionPrompt.principles.map((principle) => [principle.revisionId, principle.principleId]),
        );
        const currentPrincipleRevisionIds = [...new Set(
          (questionResponse.selectedPrincipleRevisionIds ?? [])
            .map((revisionId) => promptPrincipleByRevisionId.get(revisionId))
            .map((principleId) => principleId ? currentRevisionByPrincipleId.get(principleId) : undefined)
            .filter((revisionId): revisionId is string => Boolean(revisionId)),
        )];
        const normalizedQuestionResponse = {
          ...questionResponse,
          ...(currentPrincipleRevisionIds.length > 0
            ? { selectedPrincipleRevisionIds: currentPrincipleRevisionIds }
            : { selectedPrincipleRevisionIds: undefined }),
        };
        const selectedLabels = questionResponse.selectedOptionIds
          .map((id) => questionPrompt.options.find((option) => option.id === id)?.label)
          .filter((label): label is string => Boolean(label));
        const judgment = await decisionsStorage.recordJudgment({
          title: questionPrompt.question,
          description: [...selectedLabels, questionResponse.otherText].filter(Boolean).join("; "),
          answerPayload: {
            selectedOptionIds: questionResponse.selectedOptionIds,
            selectedLabels,
            ...(questionResponse.otherText ? { otherText: questionResponse.otherText } : {}),
            principleRevisionIds: currentPrincipleRevisionIds,
          },
          reasoning: questionResponse.reasoning,
          sourceSessionId: sessionId,
          sourceToolCallId: questionResponse.questionToolCallId,
          ownerPersonRole: "partner",
          principleRevisionIds: currentPrincipleRevisionIds,
          triggeredByAddress: `@question:${sessionId}~${questionResponse.questionToolCallId}`,
          status: "closed",
          resolvedAt: new Date(now),
        });
        decisionId = judgment.decision.id;
        message.questionResponse = {
          ...normalizedQuestionResponse,
          decisionId,
        };
      }
      data.messages.push(message);
      data.updatedAt = now;
      await writeConv(data);
      invalidateSessionsCache();
      return {
        outcome: "created" as const,
        message,
        ...(decisionId ? { decisionId } : {}),
      };
    });
  },

  async recordQuestionCancellation(sessionId: string, reason: QuestionCancelReason) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) return { outcome: "session_not_found" as const };

      const questionToolCallId = getActiveQuestionToolCallId(data.messages);
      if (!questionToolCallId) {
        return { outcome: "no_active_question" as const };
      }

      // A pure cancellation marker: a hidden, content-less lifecycle record that
      // resolves the active question without a visible message or a run. The
      // transcript and context assembly skip content-less cancellation markers.
      const now = new Date().toISOString();
      const message: FileMessage = {
        id: generateId(),
        sessionId,
        role: "user",
        content: "",
        thinking: null,
        toolCalls: null,
        systemSteps: null,
        model: null,
        createdAt: now,
        updatedAt: now,
        visibility: "diagnostic",
        questionCancellation: { questionToolCallId, reason },
      };
      data.messages.push(message);
      data.updatedAt = now;
      await writeConv(data);
      invalidateSessionsCache();
      return { outcome: "cancelled" as const, questionToolCallId };
    });
  },

  async findMeetingSessionForOccurrence(input) {
    const normalized = input.occurrenceKey.trim();
    if (!normalized) return null;
    const legacyIdentity = input.calendarAccountId && input.calendarId && input.providerEventId
      ? and(
          sql`COALESCE(${documentStoreDocuments.metadata}->'meeting'->>'occurrenceKey', '') = ''`,
          sql`${documentStoreDocuments.metadata}->'meeting'->>'resolutionSource' = 'calendar_auto_join'`,
          sql`${documentStoreDocuments.metadata}->'meeting'->>'calendarAccountId' = ${input.calendarAccountId}`,
          sql`${documentStoreDocuments.metadata}->'meeting'->>'calendarId' = ${input.calendarId}`,
          sql`${documentStoreDocuments.metadata}->'meeting'->>'providerEventId' = ${input.providerEventId}`,
        )
      : undefined;
    const rows = await db
      .select({ documentId: documentStoreDocuments.documentId })
      .from(documentStoreDocuments)
      .where(combineWithVisibleScope(
        requireCurrentPrincipal(),
        targetChatDocumentScopeColumns,
        and(
          eq(documentStoreDocuments.documentType, "chat"),
          sql`${documentStoreDocuments.metadata}->>'type' = 'meeting'`,
          legacyIdentity
            ? or(sql`${documentStoreDocuments.metadata}->'meeting'->>'occurrenceKey' = ${normalized}`, legacyIdentity)
            : sql`${documentStoreDocuments.metadata}->'meeting'->>'occurrenceKey' = ${normalized}`,
        ),
      ))
      .limit(2);
    if (rows.length > 1) {
      log.error("meeting occurrence uniqueness invariant violated", {
        occurrenceKey: normalized,
        sessionCount: rows.length,
      });
      throw new Error("Multiple meeting sessions already exist for this calendar occurrence");
    }
    if (!rows[0]) return null;
    return (await chatFileStorage.getSession(rows[0].documentId)) ?? null;
  },

  async findNativeMeetingSessionByIdempotencyKey(idempotencyKey: string) {
    const normalized = idempotencyKey.trim();
    if (!normalized) return null;
    const sessionKey = `meeting-native:${normalized}`;
    const rows = await db
      .select({ documentId: documentStoreDocuments.documentId })
      .from(documentStoreDocuments)
      .where(combineWithVisibleScope(
        requireCurrentPrincipal(),
        targetChatDocumentScopeColumns,
        and(
          eq(documentStoreDocuments.documentType, "chat"),
          sql`${documentStoreDocuments.metadata}->>'type' = 'meeting'`,
          sql`${documentStoreDocuments.metadata}->>'sessionKey' = ${sessionKey}`,
          sql`${documentStoreDocuments.metadata}->'meeting'->>'transport' = 'native'`,
        ),
      ))
      .limit(2);
    if (rows.length > 1) {
      log.error("native meeting idempotency invariant violated", {
        idempotencyKeyLength: normalized.length,
        sessionCount: rows.length,
      });
      throw new Error("Multiple native meeting sessions exist for one idempotency key");
    }
    if (!rows[0]) return null;
    return (await chatFileStorage.getSession(rows[0].documentId)) ?? null;
  },

  async createMeetingSession(
    title: string,
    meeting: MeetingSessionMeta,
    sessionKey?: string,
  ) {
    const id = generateId();
    const now = new Date().toISOString();
    // Capture the owning user structurally so webhook-driven finalization
    // (which has no user principal) can reconstruct it later.
    const principal = requireCurrentPrincipal();
    const vaultId = meeting.vaultId ?? principal.activeVaultId ?? undefined;
    const meetingPrincipal = vaultId
      ? {
          ...principal,
          activeVaultId: vaultId,
          visibleVaultIds: Array.from(new Set([...principal.visibleVaultIds, vaultId])),
        }
      : principal;
    return runWithPrincipal(meetingPrincipal, () => db.transaction(async tx => runWithDatabaseTransaction(tx, async () => {
      const ownership: Partial<MeetingSessionMeta> =
        principal.actorType === "user" && principal.userId
          ? {
              ownerUserId: principal.userId,
              principalAccountId: principal.accountId ?? undefined,
            }
          : {};
      let libraryNodePageId = meeting.libraryNodePageId;
      if (vaultId && !libraryNodePageId) {
        const { ensureMeetingLibraryNode } = await import("./meeting/vault-ownership");
        const node = await ensureMeetingLibraryNode({
          vaultId,
          meetingKey: `session:${id}`,
          title,
          principal: meetingPrincipal,
        });
        libraryNodePageId = node.id;
      }
      const data: SessionData = {
        id,
        title,
        status: "saved",
        sessionKey: sessionKey || `meeting:${id}`,
        modelTier: null,
        createdAt: now,
        updatedAt: now,
        messages: [],
        type: "meeting",
        sessionType: "user",
        isPinned: false,
        meeting: {
          ...meeting,
          ...ownership,
          vaultId,
          libraryNodePageId,
          startedAt: meeting.startedAt || now,
        },
        triggerType: "meeting",
        triggerId: id,
        triggerName: title,
        rootSessionId: id,
        depth: 0,
      };
      await writeConv(data);
      const meta = convToMeta(data);
      invalidateSessionsCache({ action: "created", sessionId: id, session: meta });
      return meta;
    })));
  },

  async createMeetingSessionOnce(
    title: string,
    meeting: MeetingSessionMeta,
    sessionKey: string,
  ) {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) throw new Error("Replay-safe Meeting creation requires a session key");
    const principal = requireCurrentPrincipal();
    if (!principal.userId || !principal.accountId || principal.actorType !== "user") {
      throw new Error("Replay-safe Meeting creation requires a user principal");
    }
    return db.transaction(async transaction => runWithDatabaseTransaction(transaction, async () => {
      await acquireAdvisoryTransactionLock(
        transaction,
        ADVISORY_LOCK_NS.CHAT_SESSION_KEY,
        `${principal.accountId}:${principal.userId}:${normalizedSessionKey}`,
      );
      const [existing] = await transaction
        .select({ documentId: documentStoreDocuments.documentId })
        .from(documentStoreDocuments)
        .where(combineWithWritableScope(
          principal,
          targetChatDocumentScopeColumns,
          and(
            eq(documentStoreDocuments.documentType, "chat"),
            sql`${documentStoreDocuments.metadata}->>'type' = 'meeting'`,
            sql`${documentStoreDocuments.metadata}->>'sessionKey' = ${normalizedSessionKey}`,
          ),
        ))
        .orderBy(documentStoreDocuments.createdAt)
        .limit(1);
      if (existing) {
        const session = await chatFileStorage.getSession(existing.documentId);
        if (!session?.meeting) throw new Error("Existing recipient Meeting projection is malformed");
        return { outcome: "existing" as const, session };
      }
      const session = await chatFileStorage.createMeetingSession(title, meeting, normalizedSessionKey);
      return { outcome: "created" as const, session };
    }));
  },

  async updateMeetingMeta(
    sessionId: string,
    patch: Partial<MeetingSessionMeta>,
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) {
        log.warn(
          `[ChatFileStorage] updateMeetingMeta: session ${sessionId} not found, skipping`,
        );
        return null;
      }
      const existing: MeetingSessionMeta = data.meeting || {
        participants: [],
        botStatus: "live",
      };
      data.meeting = {
        ...existing,
        ...patch,
        participants: patch.participants ?? existing.participants,
      };
      if (patch.botStatus === "live" || patch.botStatus === "leaving") data.status = "streaming";
      if (patch.botStatus === "failed") data.status = "failed";
      if (patch.botStatus === "ended" || patch.botStatus === "denied") data.status = "saved";
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      const meta = convToMeta(data);
      invalidateSessionsCache({
        action: "updated",
        sessionId,
        session: meta,
      });
      return meta;
    });
  },

  async moveSessionToVault(sessionId: string, vaultId: string) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) {
        throw Object.assign(new Error("Session not found"), { status: 404 });
      }
      if (data.type === "meeting" || data.meeting) {
        throw Object.assign(
          new Error("Meeting sessions move with their calendar meeting aggregate"),
          { status: 409 },
        );
      }
      const principal = requireCurrentPrincipal();
      if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
        throw Object.assign(new Error("A user principal is required to move a session"), { status: 401 });
      }
      const destinationVaultId = await assertWritableVault(principal, vaultId);
      const currentVaultId = data.vaultId;
      if (!currentVaultId) {
        throw Object.assign(new Error("Session Vault ownership is incomplete"), { status: 409 });
      }
      if (currentVaultId === destinationVaultId) return convToMeta(data);

      data.vaultId = destinationVaultId;
      data.updatedAt = new Date().toISOString();
      data.durableRevision = normalizeDurableRevision(data.durableRevision) + 1;
      const destinationPrincipal = { ...principal, activeVaultId: destinationVaultId };
      await moveConversationToVault(principal, sessionId, destinationVaultId);
      const document = await runWithPrincipal(destinationPrincipal, () =>
        documentStorage.moveDocumentToVault("chat", sessionId, destinationVaultId, {
          title: data.title,
          content: serializeSessionContent(data),
          metadata: buildConvDocumentMetadata(data),
        }),
      );
      await enqueueSearchProjectionAfterCanonicalWrite(document.documentStoreId, data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId, session });
      log.info("Session Vault moved", {
        sessionId,
        sourceVaultId: currentVaultId,
        destinationVaultId,
      });
      return session;
    });
  },

  async moveMeetingToVault(
    sessionId: string,
    vaultId: string,
    libraryNodePageId: string,
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data?.meeting || data.type !== "meeting") return null;
      const principal = requireCurrentPrincipal();
      if (!principal.userId || !principal.accountId) {
        throw new Error("A user principal is required to move a meeting session");
      }
      const currentVaultId = data.vaultId;
      if (!currentVaultId) throw new Error("Meeting session Vault ownership is incomplete");
      if (!principal.visibleVaultIds.includes(currentVaultId)) {
        throw new Error("Meeting session is outside the principal's visible Vault scope");
      }
      data.vaultId = vaultId;
      data.meeting = { ...data.meeting, vaultId, libraryNodePageId };
      data.updatedAt = new Date().toISOString();
      const document = await documentStorage.moveDocumentToVault("chat", sessionId, vaultId, {
        title: data.title,
        content: serializeSessionContent(data),
        metadata: buildConvDocumentMetadata(data),
      });
      await enqueueSearchProjectionAfterCanonicalWrite(document.documentStoreId, data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId, session });
      return session;
    });
  },

  /** Atomically claim departure so concurrent callers dispatch Recall once. */
  async claimMeetingLeave(sessionId: string): Promise<MeetingLeaveClaim> {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data || data.type !== "meeting" || !data.meeting) {
        return { outcome: "not_meeting" };
      }
      const existing = convToMeta(data);
      if (data.meeting.botStatus === "leaving") {
        return { outcome: "already_leaving", session: existing };
      }
      if (!["dialing", "in_lobby", "live"].includes(data.meeting.botStatus)) {
        return { outcome: "not_leaveable", session: existing };
      }
      const previousStatus = data.meeting.botStatus;
      data.meeting = {
        ...data.meeting,
        botStatus: "leaving",
        statusDetail: "Departure requested",
      };
      data.status = "streaming";
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId, session });
      return { outcome: "claimed", session, previousStatus };
    });
  },

  /** Restore a failed departure claim only while it still owns the leaving state. */
  async restoreMeetingLeave(sessionId, previousStatus, statusDetail) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data?.meeting || data.meeting.botStatus !== "leaving") return null;
      data.meeting = { ...data.meeting, botStatus: previousStatus, statusDetail };
      data.status = "streaming";
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId, session });
      return session;
    });
  },

  /**
   * Atomically claim recap generation for a meeting session. Failed or
   * missing recaps are claimable. Generating and ready recaps are idempotent
   * no-ops with explicit outcomes for webhook and user-initiated callers.
   */
  async claimMeetingRecap(sessionId: string): Promise<MeetingRecapClaim> {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data || data.type !== "meeting" || !data.meeting) {
        return { outcome: "not_meeting" };
      }
      const status = data.meeting.recap?.status;
      const existing = convToMeta(data);
      if (status === "generating") {
        return { outcome: "already_generating", session: existing };
      }
      if (status === "ready") {
        return { outcome: "already_ready", session: existing };
      }
      data.meeting = {
        ...data.meeting,
        recap: { status: "generating" },
      };
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId, session });
      return { outcome: "claimed", session };
    });
  },

  async registerMeetingParticipant(
    sessionId: string,
    candidate: MeetingParticipant,
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data?.meeting) return null;
      const participants = data.meeting.participants || [];
      const keyedIndex = candidate.key
        ? participants.findIndex((participant) => participant.key === candidate.key)
        : -1;
      if (keyedIndex >= 0) {
        const existing = participants[keyedIndex]!;
        if (existing.identitySource === "manual") {
          return { participant: existing, participants, added: false };
        }
        if (candidate.identitySource === "calendar" && existing.identitySource !== "calendar") {
          const participant = { ...existing, ...candidate, key: existing.key || candidate.key };
          const updatedParticipants = [...participants];
          updatedParticipants[keyedIndex] = participant;
          const now = new Date().toISOString();
          for (const message of data.messages) {
            if (message.speaker?.key !== participant.key) continue;
            message.speaker = {
              ...message.speaker,
              label: participant.label,
              ...(participant.personId ? { personId: participant.personId } : {}),
            };
            if (!participant.personId) delete message.speaker.personId;
            message.updatedAt = now;
          }
          data.meeting = { ...data.meeting, participants: updatedParticipants };
          data.updatedAt = now;
          await writeConv(data);
          const session = convToMeta(data);
          invalidateSessionsCache({ action: "updated", sessionId, session });
          return { participant, participants: updatedParticipants, added: false };
        }
        if (existing.label.trim() || candidate.source !== "machine_diarization") {
          return { participant: existing, participants, added: false };
        }
        const participant = { ...existing, label: nextGenericSpeakerLabel(participants) };
        const updatedParticipants = [...participants];
        updatedParticipants[keyedIndex] = participant;
        data.meeting = { ...data.meeting, participants: updatedParticipants };
        data.updatedAt = new Date().toISOString();
        await writeConv(data);
        const session = convToMeta(data);
        invalidateSessionsCache({ action: "updated", sessionId, session });
        return { participant, participants: updatedParticipants, added: false };
      }
      const legacyIndex = candidate.key
        ? participants.findIndex((participant) =>
            (!participant.key && candidate.personId && participant.personId === candidate.personId) ||
            (!participant.key && candidate.label.trim() && participant.label.toLowerCase() === candidate.label.toLowerCase()),
          )
        : participants.findIndex((participant) => participant.label.toLowerCase() === candidate.label.toLowerCase());
      if (legacyIndex >= 0) {
        const participant = { ...participants[legacyIndex]!, ...candidate, label: candidate.label || participants[legacyIndex]!.label };
        const updatedParticipants = [...participants];
        updatedParticipants[legacyIndex] = participant;
        data.meeting = { ...data.meeting, participants: updatedParticipants };
        data.updatedAt = new Date().toISOString();
        await writeConv(data);
        const session = convToMeta(data);
        invalidateSessionsCache({ action: "updated", sessionId, session });
        return { participant, participants: updatedParticipants, added: false };
      }

      let participant = candidate;
      if (!candidate.label.trim()) {
        participant = {
          ...candidate,
          label: nextGenericSpeakerLabel(participants),
        };
      }
      const updatedParticipants = [...participants, participant];
      data.meeting = { ...data.meeting, participants: updatedParticipants };
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId, session });
      return { participant, participants: updatedParticipants, added: true };
    });
  },

  async initializeMeetingAudioSourcePolicy(
    sessionId: string,
    sourceKey: string,
    mode: MeetingAudioSourceMode,
  ): Promise<FileSession | null> {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data?.meeting || data.type !== "meeting") return null;
      const principal = requireCurrentPrincipal();
      if (
        principal.actorType !== "user" ||
        !principal.userId ||
        !principal.accountId ||
        data.meeting.ownerUserId !== principal.userId ||
        data.meeting.principalAccountId !== principal.accountId
      ) {
        return null;
      }
      if (data.meeting.audioSourcePolicies?.[sourceKey]) return convToMeta(data);
      const updatedAt = new Date().toISOString();
      data.meeting = {
        ...data.meeting,
        audioSourcePolicies: {
          ...(data.meeting.audioSourcePolicies || {}),
          [sourceKey]: { mode, mutationId: `initialize:${sourceKey}`, updatedAt },
        },
      };
      data.updatedAt = updatedAt;
      await writeConv(data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId, session });
      return session;
    });
  },

  async setMeetingAudioSourcePolicy(
    sessionId: string,
    sourceKey: string,
    mode: MeetingAudioSourceMode,
    mutationId: string,
  ): Promise<MeetingAudioSourcePolicyMutation> {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data?.meeting || data.type !== "meeting") return { outcome: "not_found" };
      const principal = requireCurrentPrincipal();
      if (
        principal.actorType !== "user" ||
        !principal.userId ||
        !principal.accountId ||
        data.meeting.ownerUserId !== principal.userId ||
        data.meeting.principalAccountId !== principal.accountId
      ) {
        return { outcome: "not_owned" };
      }
      if (data.meeting.botStatus !== "live") return { outcome: "not_active" };
      const stream = data.meeting.recognition?.streams.find(
        (candidate) => candidate.streamKey === sourceKey,
      );
      if (!stream) return { outcome: "not_found" };
      if (stream.attribution === "excluded") return { outcome: "excluded" };

      const existing = data.meeting.audioSourcePolicies?.[sourceKey];
      if (existing?.mutationId === mutationId || existing?.mode === mode) {
        return { outcome: "unchanged", session: convToMeta(data) };
      }

      const updatedAt = new Date().toISOString();
      data.meeting = {
        ...data.meeting,
        audioSourcePolicies: {
          ...(data.meeting.audioSourcePolicies || {}),
          [sourceKey]: { mode, mutationId, updatedAt },
        },
      };
      data.updatedAt = updatedAt;
      await writeConv(data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId, session });
      return { outcome: "updated", session };
    });
  },

  async assignMeetingParticipantPerson(
    sessionId: string,
    speakerKey: string,
    person: { id: string; name: string } | null,
  ): Promise<MeetingSpeakerAssignment> {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data?.meeting || data.type !== "meeting") return { outcome: "not_found" };

      const principal = requireCurrentPrincipal();
      if (
        principal.actorType !== "user" ||
        !principal.userId ||
        !principal.accountId ||
        data.meeting.ownerUserId !== principal.userId ||
        data.meeting.principalAccountId !== principal.accountId
      ) {
        return { outcome: "not_owned" };
      }

      const participantIndex = data.meeting.participants.findIndex(
        (participant) => participant.key === speakerKey,
      );
      const current = data.meeting.participants[participantIndex];
      if (!current) return { outcome: "not_found" };

      const nextPersonId = person?.id;
      const duplicatePersonIndexes = person
        ? data.meeting.participants.flatMap((participant, index) =>
            index !== participantIndex && participant.personId === person.id ? [index] : [],
          )
        : [];
      if (
        duplicatePersonIndexes.length === 0 &&
        current.personId === nextPersonId &&
        (!person || (current.identitySource === "manual" && current.label === person.name))
      ) {
        return {
          outcome: "unchanged",
          participant: current,
          previousPersonId: current.personId,
          displacedParticipants: [],
          session: convToMeta(data),
        };
      }

      const previousPersonId = current.personId;
      const participant: MeetingParticipant = {
        ...current,
        ...(person
          ? {
              personId: person.id,
              label: person.name,
              providerLabel: current.providerLabel || current.label,
            }
          : {}),
        identitySource: person ? "manual" : current.identitySource,
      };
      if (!person) {
        delete participant.personId;
        participant.label = current.providerLabel || current.label;
        participant.identitySource = current.calendarEmail ? "calendar" : "transport";
      }

      const participants = [...data.meeting.participants];
      const displacedParticipants = duplicatePersonIndexes.map((index) => {
        const duplicate = participants[index];
        const cleared: MeetingParticipant = {
          ...duplicate,
          label: duplicate.providerLabel || duplicate.label,
          identitySource: duplicate.calendarEmail ? "calendar" : "transport",
        };
        delete cleared.personId;
        participants[index] = cleared;
        return { participant: cleared, previousPersonId: person!.id };
      });
      participants[participantIndex] = participant;
      data.meeting = { ...data.meeting, participants };

      const now = new Date().toISOString();
      const changedParticipantsByKey = new Map(
        [participant, ...displacedParticipants.map((entry) => entry.participant)]
          .flatMap((changed) => changed.key ? [[changed.key, changed] as const] : []),
      );
      for (const message of data.messages) {
        const changedParticipant = message.speaker?.key
          ? changedParticipantsByKey.get(message.speaker.key)
          : undefined;
        if (!changedParticipant) continue;
        message.speaker = {
          ...message.speaker,
          label: changedParticipant.label,
          ...(changedParticipant.personId ? { personId: changedParticipant.personId } : {}),
        };
        if (!changedParticipant.personId) delete message.speaker.personId;
        message.updatedAt = now;
      }
      data.updatedAt = now;
      await writeConv(data);
      const session = convToMeta(data);
      invalidateSessionsCache({ action: "updated", sessionId, session });
      return {
        outcome: person ? "assigned" : "cleared",
        participant,
        previousPersonId,
        displacedParticipants,
        session,
      };
    });
  },

  async createMeetingUserMessage(
    sessionId: string,
    content: string,
    speaker: MessageSpeakerMeta,
    turnId?: string,
    enrollment?: {
      sessionKey: string;
      speakerKey: string;
      speakerLabel: string;
      participationMode?: "contextual" | "always";
      executionAffinityBootId?: string;
    },
    recognition?: import("@shared/models/chat").MessageRecognitionMeta,
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) {
        log.warn(
          `[ChatFileStorage] createMeetingUserMessage: session ${sessionId} not found, skipping`,
        );
        return { outcome: "session_not_found" as const };
      }
      const existing = turnId
        ? data.messages.find((message) => message.role === "user" && message.turnId === turnId)
        : undefined;
      if (existing) {
        if (turnId && enrollment) {
          const { ensurePendingMeetingTurnEnrollment } = await import("./meeting/turn-enrollment");
          await ensurePendingMeetingTurnEnrollment({
            sessionId,
            sourceTurnId: turnId,
            sourceMessageId: existing.id,
            ...enrollment,
          });
        }
        log.debug(`[ChatFileStorage] duplicate meeting turn accepted session=${sessionId} turnId=${turnId}`);
        return { outcome: "duplicate" as const, message: existing };
      }
      const now = new Date().toISOString();
      const msg: FileMessage = {
        id: generateId(),
        sessionId,
        role: "user",
        content,
        thinking: null,
        toolCalls: null,
        systemSteps: null,
        model: null,
        createdAt: now,
        updatedAt: now,
        speaker,
        ...(recognition ? { recognition } : {}),
        ...(turnId ? { turnId } : {}),
      };
      data.messages.push(msg);
      data.updatedAt = now;
      await writeConv(data);
      if (turnId && enrollment) {
        const { ensurePendingMeetingTurnEnrollment } = await import("./meeting/turn-enrollment");
        await ensurePendingMeetingTurnEnrollment({
          sessionId,
          sourceTurnId: turnId,
          sourceMessageId: msg.id,
          ...enrollment,
        });
      }
      invalidateSessionsCache();
      return { outcome: "created" as const, message: msg };
    });
  },

  async upsertVoiceUserMessage(
    sessionId: string,
    content: string,
    voice: VoiceMessageMeta,
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) {
        log.warn(
          `[ChatFileStorage] upsertVoiceUserMessage: session ${sessionId} not found, skipping`,
        );
        return null;
      }

      const existing = data.messages.find(
        (m) => m.role === "user" && m.voice?.turnKey === voice.turnKey,
      );
      const now = new Date().toISOString();
      if (existing) {
        if (existing.content !== content) existing.content = content;
        existing.voice = { ...existing.voice, ...voice };
        if (voice.turnId) existing.turnId = voice.turnId;
        existing.updatedAt = now;
        data.updatedAt = now;
        await writeConv(data);
        invalidateSessionsCache();
        return existing;
      }

      const msg: FileMessage = {
        id: generateId(),
        sessionId,
        role: "user",
        content,
        thinking: null,
        toolCalls: null,
        systemSteps: null,
        model: null,
        createdAt: now,
        updatedAt: now,
        cost: null,
        apiCallCount: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        segmentChronology: null,
        voice,
        ...(voice.turnId ? { turnId: voice.turnId } : {}),
      };
      data.messages.push(msg);
      data.updatedAt = now;
      await writeConv(data);
      invalidateSessionsCache();
      return msg;
    });
  },

  async createAssistantDraft(
    sessionId: string,
    opts?: {
      model?: string;
      runId?: string;
      systemSteps?: SystemStepRecord[];
      segmentChronology?: SegmentChronologyEntry[];
    },
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) {
        log.warn(
          `[ChatFileStorage] createAssistantDraft: session ${sessionId} not found, skipping`,
        );
        return null;
      }
      const now = new Date().toISOString();
      let staleDraftsTerminalized = 0;
      if (opts?.runId) {
        for (const message of data.messages) {
          if (
            message.role !== "assistant" ||
            message.assistantState !== "streaming" ||
            message.assistantRunId === opts.runId
          ) {
            continue;
          }
          message.assistantState = "interrupted";
          message.assistantRuntimeOwner = undefined;
          message.assistantInterruptedAt = now;
          message.updatedAt = now;
          staleDraftsTerminalized++;
        }
      }
      const existing = [...data.messages]
        .reverse()
        .find(
          (m) =>
            m.role === "assistant" &&
            m.assistantState === "streaming" &&
            (!opts?.runId || m.assistantRunId === opts.runId),
        );
      const persona = await resolvePersonaSnapshot(data.personaId);
      if (existing) {
        existing.model = opts?.model || existing.model || null;
        existing.assistantRunId = opts?.runId || existing.assistantRunId;
        existing.assistantRuntimeOwner = getRuntimeOwner();
        if (!existing.persona && persona) existing.persona = persona;
        if (opts?.systemSteps)
          existing.systemSteps =
            opts.systemSteps.length > 0 ? opts.systemSteps : null;
        if (opts?.segmentChronology)
          existing.segmentChronology =
            opts.segmentChronology.length > 0 ? opts.segmentChronology : null;
        data.updatedAt = now;
        await writeConv(data);
        invalidateSessionsCache();
        if (staleDraftsTerminalized > 0) {
          log.warn(
            `[ChatFileStorage] terminalized stale assistant drafts before run sessionId=${sessionId} runId=${opts?.runId} count=${staleDraftsTerminalized}`,
          );
        }
        return existing;
      }
      const msg: FileMessage = {
        id: generateId(),
        sessionId,
        role: "assistant",
        content: "",
        thinking: null,
        toolCalls: null,
        systemSteps:
          opts?.systemSteps && opts.systemSteps.length > 0
            ? opts.systemSteps
            : null,
        model: opts?.model || null,
        createdAt: now,
        updatedAt: now,
        segmentChronology:
          opts?.segmentChronology && opts.segmentChronology.length > 0
            ? opts.segmentChronology
            : null,
        assistantState: "streaming",
        assistantRunId: opts?.runId,
        assistantRuntimeOwner: getRuntimeOwner(),
        ...(persona ? { persona } : {}),
      };
      data.messages.push(msg);
      data.updatedAt = now;
      await writeConv(data);
      invalidateSessionsCache();
      if (staleDraftsTerminalized > 0) {
        log.warn(
          `[ChatFileStorage] terminalized stale assistant drafts before run sessionId=${sessionId} runId=${opts?.runId} count=${staleDraftsTerminalized}`,
        );
      }
      return msg;
    });
  },

  async updateAssistantDraft(
    sessionId: string,
    messageId: string,
    updates: {
      content?: string;
      thinking?: string;
      toolCalls?: unknown;
      model?: string;
      persona?: PersonaSnapshot;
      systemSteps?: SystemStepRecord[];
      cost?: number;
      apiCallCount?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      contextPressure?: ContextPressureSnapshot;
      segmentChronology?: SegmentChronologyEntry[];
      assistantState?: AssistantMessageState;
      /** Atomically settle the owning Session with the terminal assistant write. */
      sessionStatus?: "saved" | "failed";
      assistantInterruptedAt?: string;
    },
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) return null;
      const msg = data.messages.find(
        (m) => m.id === messageId && m.role === "assistant",
      );
      if (!msg) return null;
      // Async checkpoint writes can complete after the final save. Once a draft
      // leaves streaming state, only an explicit lifecycle update may mutate it.
      if (
        msg.assistantState &&
        msg.assistantState !== "streaming" &&
        updates.assistantState === undefined
      ) {
        return msg;
      }
      if (updates.content !== undefined)
        msg.content = stripRoleMarkers(updates.content, sessionId);
      if (updates.thinking !== undefined)
        msg.thinking = updates.thinking || null;
      if (updates.toolCalls !== undefined)
        msg.toolCalls = updates.toolCalls || null;
      if (updates.model !== undefined) msg.model = updates.model || null;
      if (updates.persona !== undefined) msg.persona = updates.persona;
      if (updates.systemSteps !== undefined)
        msg.systemSteps =
          updates.systemSteps.length > 0 ? updates.systemSteps : null;
      if (updates.cost !== undefined) msg.cost = updates.cost;
      if (updates.apiCallCount !== undefined)
        msg.apiCallCount = updates.apiCallCount;
      if (updates.inputTokens !== undefined)
        msg.inputTokens = updates.inputTokens;
      if (updates.outputTokens !== undefined)
        msg.outputTokens = updates.outputTokens;
      if (updates.totalTokens !== undefined)
        msg.totalTokens = updates.totalTokens;
      if (updates.contextPressure !== undefined)
        msg.contextPressure = updates.contextPressure;
      if (updates.segmentChronology !== undefined) {
        const alignedSegmentChronology = alignAssistantChronology(
          updates.segmentChronology,
          updates.content !== undefined
            ? stripRoleMarkers(updates.content, sessionId)
            : msg.content,
          sessionId,
        );
        msg.segmentChronology =
          alignedSegmentChronology && alignedSegmentChronology.length > 0
            ? alignedSegmentChronology
            : null;
      }
      if (updates.assistantState !== undefined) {
        msg.assistantState = updates.assistantState;
        if (updates.assistantState !== "streaming") {
          msg.assistantRuntimeOwner = undefined;
        }
      }
      if (updates.sessionStatus !== undefined) {
        data.status = updates.sessionStatus;
        data.activeRuntimeOwner = undefined;
        data.runStatus = updates.sessionStatus === "saved" ? "resolved" : "failed";
      }
      if (updates.assistantInterruptedAt !== undefined)
        msg.assistantInterruptedAt = updates.assistantInterruptedAt;
      if (
        updates.assistantState !== undefined &&
        updates.assistantState !== "streaming" &&
        !hasRenderableAssistantPayload(msg)
      ) {
        data.messages = data.messages.filter((m) => m.id !== msg.id);
        data.updatedAt = new Date().toISOString();
        const durableRevision = await writeConv(data);
        invalidateSessionsCache();
        log.debug(
          `[ChatFileStorage] removed empty assistant draft on terminal state sessionId=${sessionId} messageId=${messageId} state=${updates.assistantState}`,
        );
        return { message: null, durableRevision };
      }
      msg.updatedAt = new Date().toISOString();
      data.updatedAt = msg.updatedAt;
      const durableRevision = await writeConv(data);
      // Streaming checkpoints update message payload only. Invalidating the
      // global session metadata cache on every chunk makes each sidebar poll
      // rescan every chat document and can saturate the DB pool. Creation and
      // terminal lifecycle transitions still invalidate the cache.
      if (updates.assistantState !== undefined) {
        invalidateSessionsCache({
          action: "updated",
          sessionId,
          session: convToMeta(data),
        });
      }
      return { message: msg, durableRevision };
    });
  },

  async terminalizeAssistantDraft(
    sessionId: string,
    messageId: string,
    runId: string,
    state: TerminalAssistantMessageState,
    interruptedAt?: string,
  ): Promise<AssistantDraftTerminalizationOutcome> {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) return { outcome: "not_found" };
      const msg = data.messages.find(
        (candidate) => candidate.id === messageId && candidate.role === "assistant",
      );
      if (!msg) return { outcome: "not_found" };
      if (msg.assistantRunId !== runId) {
        return { outcome: "run_mismatch", actualRunId: msg.assistantRunId };
      }
      if (msg.assistantState !== "streaming") {
        return {
          outcome: "already_terminal",
          state: msg.assistantState,
          durableRevision: normalizeDurableRevision(data.durableRevision),
        };
      }

      msg.assistantState = state;
      msg.assistantRuntimeOwner = undefined;
      if (interruptedAt !== undefined) msg.assistantInterruptedAt = interruptedAt;

      const now = new Date().toISOString();
      data.updatedAt = now;
      if (!hasRenderableAssistantPayload(msg)) {
        data.messages = data.messages.filter((candidate) => candidate.id !== msg.id);
        await writeConv(data);
        invalidateSessionsCache();
        log.warn(
          `[ChatFileStorage] terminalized empty assistant draft by removal sessionId=${sessionId} messageId=${messageId} runId=${runId} state=${state}`,
        );
        return {
          outcome: "removed_empty",
          state,
          durableRevision: normalizeDurableRevision(data.durableRevision),
        };
      }

      msg.updatedAt = now;
      await writeConv(data);
      invalidateSessionsCache();
      log.warn(
        `[ChatFileStorage] terminalized unsettled assistant draft sessionId=${sessionId} messageId=${messageId} runId=${runId} state=${state}`,
      );
      return {
        outcome: "terminalized",
        state,
        durableRevision: normalizeDurableRevision(data.durableRevision),
      };
    });
  },

  async reconcileInterruptedAssistantDrafts(sessionId?: string) {
    const recoveryPrincipal = createNamedSystemPrincipal(CHAT_RECOVERY_JOB);
    const candidates = await runWithPrincipal(recoveryPrincipal, () =>
      documentStorage.discoverInterruptedChatRecoveryCandidates(100),
    );
    const docs = candidates.filter((doc) => {
      if (sessionId && doc.docId !== sessionId) return false;
      return (
        doc.runtimeOwner === null ||
        isOwnedByPriorBootOnThisInstance(doc.runtimeOwner)
      );
    });
    let sessionsScanned = 0;
    let draftsReconciled = 0;
    let failures = 0;
    for (const doc of docs) {
      const id = doc.docId;
      try {
        const result = await runWithChatDocumentOwner(
          id,
          {
            ownerUserId: doc.ownerUserId,
            accountId: doc.accountId,
            vaultId: doc.vaultId,
          },
          () => withConvLock(id, async () => {
            const principal = requireCurrentPrincipal();
            const tx = db;
            await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
            await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);

            const [lockedUser] = await tx
              .select({
                id: users.id,
                activeVaultId: users.activeVaultId,
                visibleVaultIds: users.visibleVaultIds,
              })
              .from(users)
              .where(eq(users.id, doc.ownerUserId))
              .limit(1)
              .for("share");
            const [lockedAccount] = await tx
              .select({ id: accounts.id })
              .from(accounts)
              .where(
                and(
                  eq(accounts.id, doc.accountId),
                  eq(accounts.kind, "personal"),
                  eq(accounts.ownerUserId, doc.ownerUserId),
                ),
              )
              .limit(1)
              .for("share");
            if (!lockedUser || !lockedAccount) {
              throw new Error(`Chat document ownership changed during repair: chat/${id}`);
            }
            if (
              doc.vaultId &&
              lockedUser.activeVaultId !== doc.vaultId &&
              !lockedUser.visibleVaultIds.includes(doc.vaultId)
            ) {
              throw new Error(`Chat document vault access changed during repair: chat/${id}`);
            }

            const [locked] = await tx
              .select({
                id: documentStoreDocuments.id,
                content: documentStoreDocuments.content,
                metadata: documentStoreDocuments.metadata,
              })
              .from(documentStoreDocuments)
              .where(
                combineWithWritableScope(
                  principal,
                  targetChatDocumentScopeColumns,
                  and(
                    eq(documentStoreDocuments.documentType, "chat"),
                    eq(documentStoreDocuments.documentId, id),
                  ),
                ),
              )
              .limit(1)
              .for("update");
            if (!locked) return { changed: false, interruptedDrafts: 0 };

            let data: SessionData;
            try {
              data = JSON.parse(locked.content) as SessionData;
            } catch (error) {
              throw new Error(
                `Chat document content is invalid JSON: chat/${id}: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
            sessionsScanned++;
            if (
              (data.type || "text") !== "text" ||
              (data.sessionType || "user") !== "user" ||
              data.status !== "streaming"
            ) {
              return { changed: false, interruptedDrafts: 0 };
            }
            const persistedOwner =
              data.activeRuntimeOwner ||
              (locked.metadata as Record<string, unknown> | null)?.activeRuntimeOwner;
            if (
              typeof persistedOwner === "string" &&
              !isOwnedByPriorBootOnThisInstance(persistedOwner)
            ) {
              return { changed: false, interruptedDrafts: 0 };
            }

            const now = new Date().toISOString();
            let interruptedDrafts = 0;
            for (const msg of data.messages) {
              if (msg.role !== "assistant" || msg.assistantState !== "streaming") continue;
              if (
                msg.assistantRuntimeOwner &&
                !isOwnedByPriorBootOnThisInstance(msg.assistantRuntimeOwner)
              ) {
                continue;
              }
              msg.assistantState = "interrupted";
              msg.assistantRuntimeOwner = undefined;
              msg.assistantInterruptedAt = now;
              msg.isError = true;
              interruptedDrafts++;
            }

            const interruptedRunIds = data.messages
              .filter(
                (msg) =>
                  msg.role === "assistant" &&
                  msg.assistantState === "interrupted" &&
                  msg.assistantInterruptedAt === now,
              )
              .map((msg) => msg.assistantRunId)
              .filter((runId): runId is string => Boolean(runId));
            const noticeIdentity =
              interruptedRunIds[interruptedRunIds.length - 1] ||
              doc.runtimeOwner ||
              "legacy";
            const noticeKey = `${CHAT_RECOVERY_NOTICE_PREFIX}:${noticeIdentity}`;
            const noticeExists = data.messages.some(
              (msg) => msg.artifactKey === noticeKey,
            );
            if (!noticeExists) {
              const notice = {
                severity: "warning",
                errorType: "response_interrupted",
                description:
                  "The server restarted while this response was in progress. Any completed work above was preserved.",
                actionHint:
                  "Send another message and I'll continue from the last completed step.",
                terminationReason: "process_restart",
              };
              data.messages.push({
                id: generateId(),
                sessionId: id,
                role: "system_notice",
                content: JSON.stringify(notice),
                thinking: null,
                toolCalls: null,
                systemSteps: null,
                model: null,
                createdAt: now,
                updatedAt: now,
                artifactKey: noticeKey,
              });
            }

            const previousStatus = data.status;
            data.status = "failed";
            data.runStatus = "failed";
            data.activeRuntimeOwner = undefined;
            data.endReason = "process_restart";
            data.errorSeverity = "warning";
            data.updatedAt = now;
            data.durableRevision = normalizeDurableRevision(data.durableRevision) + 1;
            const updated = await tx
              .update(documentStoreDocuments)
              .set({
                title: data.title,
                content: JSON.stringify(data),
                metadata: buildConvDocumentMetadata(data),
                updatedByUserId: principal.userId ?? undefined,
                updatedAt: new Date(now),
                sourceContentHash: null,
                sourceMetadataHash: null,
                sourceIdentityHash: null,
              })
              .where(
                combineWithWritableScope(
                  principal,
                  targetChatDocumentScopeColumns,
                  eq(documentStoreDocuments.id, locked.id),
                ),
              )
              .returning({ id: documentStoreDocuments.id });
            if (updated.length !== 1) {
              throw new Error(`Locked chat document update failed: chat/${id}`);
            }
            await enqueueSearchProjectionAfterCanonicalWrite(locked.id, data);
            invalidateSessionsCache({
              action: "updated",
              sessionId: id,
              session: convToMeta(data),
            });
            publishSessionStatusChanged(data, previousStatus, data.status);
            return { changed: true, interruptedDrafts };
          }),
        );
        draftsReconciled += result.interruptedDrafts;
        if (result.changed) {
          log.warn(
            `[ChatFileStorage] reconciled interrupted chat sessionId=${id} assistantDrafts=${result.interruptedDrafts} priorRuntimeOwner=${doc.runtimeOwner || "legacy"}`,
          );
        }
      } catch (error) {
        failures++;
        log.error(
          `[ChatFileStorage] interrupted draft repair failed sessionId=${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { sessionsScanned, draftsReconciled, failures };
  },

  async updateMessageContent(
    messageId: string,
    sessionId: string,
    content: string,
    thinking?: string,
    toolCalls?: unknown,
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) return;
      const msg = data.messages.find((m) => m.id === messageId);
      if (!msg) return;
      msg.content =
        msg.role === "assistant"
          ? stripRoleMarkers(content, sessionId)
          : content;
      if (thinking !== undefined) msg.thinking = thinking;
      if (toolCalls !== undefined) msg.toolCalls = toolCalls;
      msg.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
    });
  },

  async updateMessageSystemSteps(
    messageId: string,
    sessionId: string,
    systemSteps: SystemStepRecord[],
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) return;
      const msg = data.messages.find((m) => m.id === messageId);
      if (!msg) return;
      msg.systemSteps = systemSteps.length > 0 ? systemSteps : null;
      msg.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
    });
  },

  async getInitialContext(id: string) {
    const data = await readConv(id);
    return data?.initialSystemPrompt || null;
  },

  async setInitialContext(id: string, systemPrompt: string) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      data.initialSystemPrompt = systemPrompt;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
    });
  },

  async createAutonomousSession(
    title: string,
    sessionType: SessionType,
    sessionKey?: string,
    modelTier?: string,
    intentionId?: string,
    spawnMeta?: SpawnMetaInput,
  ) {
    const id = generateId();
    const now = new Date().toISOString();
    const provenance = normalizeSessionProvenance(
      spawnMeta,
      provenanceFromSessionType(sessionType, title, intentionId),
    );
    const { rootSessionId, depth } = await computeRootAndDepth(
      spawnMeta?.parentSessionId,
    );
    const personaProvenance = await resolvePersonaProvenance(spawnMeta?.personaId);
    const data: SessionData = {
      id,
      title,
      status: "saved",
      sessionKey: sessionKey || null,
      modelTier: normalizeSessionModelTierOverride(modelTier),
      personaId: spawnMeta?.personaId ?? null,
      ...personaProvenance,
      createdAt: now,
      updatedAt: now,
      messages: [],
      sessionType,
      isPinned: false,
      agenda: spawnMeta?.agenda,
      intentionId: intentionId || undefined,
      parentSessionId: spawnMeta?.parentSessionId,
      spawnReason: spawnMeta?.spawnReason,
      spawnerTool: spawnMeta?.spawnerTool,
      spawnerSkillRun: spawnMeta?.spawnerSkillRun,
      triggerType: provenance.triggerType,
      triggerId: provenance.triggerId,
      triggerName: provenance.triggerName,
      triggerAddress: (await import("./execution-provenance-address")).canonicalSessionTriggerAddress(provenance.triggerType, provenance.triggerId),
      rootSessionId: rootSessionId || id,
      depth,
    };
    await writeConv(data);
    const meta = convToMeta(data);
    invalidateSessionsCache({ action: "created", sessionId: id, session: meta });
    if (spawnMeta?.parentSessionId) {
      treeLog.log(
        `spawn child=${id} parent=${spawnMeta.parentSessionId} type=${sessionType} key=${sessionKey || "-"} reason=${spawnMeta.spawnReason || "-"} tool=${spawnMeta.spawnerTool || "-"} skillRun=${spawnMeta.spawnerSkillRun || "-"} via=createAutonomousSession`,
      );
    }
    return meta;
  },

  async setSessionPinned(
    id: string,
    isPinned: boolean,
    pinReason?: string,
  ) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      data.isPinned = isPinned;
      data.pinReason = isPinned
        ? pinReason || data.pinReason
        : undefined;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
    });
  },

  async archiveSession(id: string) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      memoryMirrorLog.info(
        `[ingest] archive source=chat_journal sessionId=${id} status=${data.status} ` +
        `hasSummary=${Boolean(data.summary?.trim())} messageCount=${data.messages.length} memoryEntryId=${data.memoryEntryId || "none"}`,
      );
      data.archivedAt = new Date().toISOString();
      data.isPinned = false;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session: convToMeta(data) });
      queueVnextSessionSource(data, "archiveSession");
      queueSessionMemoryMirror(data, "archiveSession");
    });
  },

  async unarchiveSession(id: string) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      data.archivedAt = null;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session: convToMeta(data) });
    });
  },

  async updatePageContext(id: string, pageContext: PageContext) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      data.pageContext = pageContext;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
    });
  },

  async setHasUnreadResult(id: string, hasUnreadResult: boolean) {
    return withConvLock(id, async () => {
      const updated = await documentStorage.patchDocumentMetadata("chat", id, {
        hasUnreadResult,
      });
      if (!updated) return;
      invalidateSessionsCache();
    });
  },

  async setParentSessionId(
    id: string,
    parentSessionId: string,
    spawnMeta?: {
      spawnReason?: string;
      spawnerTool?: string;
      spawnerSkillRun?: string;
      triggerType?: TriggerType;
      triggerId?: string;
      triggerName?: string;
    },
  ) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) {
        treeLog.warn(
          `spawn child=${id} parent=${parentSessionId} skipped — session not found`,
        );
        return;
      }
      const wasAlreadyParented = data.parentSessionId === parentSessionId;
      data.parentSessionId = parentSessionId;
      if (spawnMeta?.spawnReason) data.spawnReason = spawnMeta.spawnReason;
      if (spawnMeta?.spawnerTool) data.spawnerTool = spawnMeta.spawnerTool;
      if (spawnMeta?.spawnerSkillRun)
        data.spawnerSkillRun = spawnMeta.spawnerSkillRun;
      if (spawnMeta?.triggerType) data.triggerType = spawnMeta.triggerType;
      if (spawnMeta?.triggerId) data.triggerId = spawnMeta.triggerId;
      if (spawnMeta?.triggerName) data.triggerName = spawnMeta.triggerName;
      const { rootSessionId, depth } = await computeRootAndDepth(parentSessionId);
      data.rootSessionId = rootSessionId || parentSessionId;
      data.depth = depth;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
      if (!wasAlreadyParented) {
        treeLog.log(
          `spawn child=${id} parent=${parentSessionId} type=${data.sessionType || "unknown"} key=${data.sessionKey || "-"} via=setParentSessionId`,
        );
      }
    });
  },

  async clearParentSessionId(id: string) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      const previousParent = data.parentSessionId;
      data.parentSessionId = undefined;
      data.spawnReason = undefined;
      data.spawnerTool = undefined;
      data.spawnerSkillRun = undefined;
      data.rootSessionId = data.id;
      data.depth = 0;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      try {
        const { deleteSessionTreeRow } = await import("./sessions/tree");
        await deleteSessionTreeRow(id);
      } catch (err) {
        log.warn(
          `clearParentSessionId: failed to delete session_tree row for ${id}`,
          err,
        );
      }
      invalidateSessionsCache();
      treeLog.log(
        `clearParent child=${id} previousParent=${previousParent || "-"}`,
      );
    });
  },

  async setEndReason(id: string, endReason: string) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      if (data.endReason === endReason) return;
      data.endReason = endReason;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
      treeLog.log(
        `end child=${id} parent=${data.parentSessionId || "-"} endReason=${endReason} status=${data.status || "-"}`,
      );
    });
  },

  async setChildMissionOutcome(
    id: string,
    outcome: import("@shared/models/chat").ChildMissionTerminalOutcome,
  ) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      if (data.childMissionOutcome === outcome) return;
      data.childMissionOutcome = outcome;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
      treeLog.log(
        `terminal child=${id} parent=${data.parentSessionId || "-"} outcome=${outcome} status=${data.status || "-"}`,
      );
    });
  },

  async setErrorSeverity(id: string, severity: "warning" | "error" | null) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      if (data.errorSeverity === severity) return;
      data.errorSeverity = severity;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
    });
  },

  async setGitWriteOverride(id: string, enabled: boolean) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      data.gitWriteOverride = enabled;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
    });
  },

  async updateSessionContextFlags(id: string, flags: Record<string, boolean>) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      data.contextFlags = { ...(data.contextFlags || {}), ...flags };
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session: convToMeta(data) });
    });
  },

  async readSessionContextFlags(
    id: string,
  ): Promise<Record<string, boolean> | null> {
    const data = await readConv(id);
    if (!data) return null;
    return data.contextFlags || null;
  },

  async setSessionMemoryEntryId(id: string, memoryEntryId: number) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      if (data.memoryEntryId === memoryEntryId) return;
      data.memoryEntryId = memoryEntryId;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session: convToMeta(data) });
    });
  },

  async syncSessionMemoryMirror(id: string) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) {
        memoryMirrorLog.warn(`[ingest] skip source=chat_journal sessionId=${id} reason=session_not_found`);
        return;
      }
      await syncVnextSessionSourceIfReady(data, "syncSessionMemoryMirror:compat_alias");
    });
  },

  async updateSessionMemoryIndex(id: string, oneLiner: string | null, memorySummary?: string | null) {
    return withConvLock(id, async () => {
      const data = await readConv(id);
      if (!data) return;
      data.memoryOneLiner = oneLiner;
      if (memorySummary !== undefined) {
        data.memorySummary = memorySummary;
      }
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache({ action: "updated", sessionId: id, session: convToMeta(data) });
    });
  },

  async createCrossSessionMessage(
    fromSessionId: string,
    toSessionId: string,
    content: string,
    direction: "sibling" | "parent" | "child" | "direct",
    chain?: { chainId: string; depth: number },
  ) {
    // Resolve session titles for display labels
    const [fromConv, toConv] = await Promise.all([
      readConv(fromSessionId),
      fromSessionId === toSessionId ? null : readConv(toSessionId),
    ]);
    const meta: CrossSessionMeta = {
      fromSessionId,
      toSessionId,
      direction,
      fromLabel: fromConv?.title || undefined,
      toLabel:
        (fromSessionId === toSessionId ? fromConv?.title : toConv?.title) ||
        undefined,
      ...(chain ? { chainId: chain.chainId, depth: chain.depth } : {}),
    };

    const writeOne = async (sessionId: string): Promise<FileMessage | null> => {
      return withConvLock(sessionId, async () => {
        const data = await readConv(sessionId);
        if (!data) {
          log.warn(`createCrossSessionMessage: session ${sessionId} not found`);
          return null;
        }
        const msg: FileMessage = {
          id: generateId(),
          sessionId,
          role: "cross_session",
          content,
          thinking: null,
          toolCalls: null,
          systemSteps: null,
          model: null,
          createdAt: new Date().toISOString(),
          crossSession: meta,
        };
        data.messages.push(msg);
        data.updatedAt = msg.createdAt;
        await writeConv(data);
        return msg;
      });
    };

    const fromMessage = await writeOne(fromSessionId);
    const toMessage =
      fromSessionId === toSessionId ? fromMessage : await writeOne(toSessionId);
    invalidateSessionsCache();
    return { fromMessage, toMessage };
  },

  async repairOversizedContextPayloads(
    sessionId: string,
    opts?: { maxInlineTokens?: number; reason?: string },
  ) {
    const maxInlineTokens =
      opts?.maxInlineTokens ??
      Number(process.env.CHAT_REPAIR_MAX_INLINE_TOOL_TOKENS || 8_000);
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data)
        return {
          repaired: false,
          messagesScanned: 0,
          payloadsRepaired: 0,
          tokensBefore: 0,
          tokensAfter: 0,
        };

      let payloadsRepaired = 0;
      let tokensBefore = 0;
      let tokensAfter = 0;
      const { maybeOffloadToolOutput } =
        await import("./tool-output-artifacts");

      for (const msg of data.messages) {
        if (!Array.isArray(msg.toolCalls)) continue;
        for (const rawCall of msg.toolCalls as Array<Record<string, unknown>>) {
          const result = rawCall?.result;
          const before = estimateInlineTokens(result);
          tokensBefore += before;
          if (before <= maxInlineTokens || isArchivedToolOutputString(result)) {
            tokensAfter += before;
            continue;
          }

          const toolName =
            typeof rawCall.toolName === "string" ? rawCall.toolName : "unknown";
          const action = extractToolAction(toolName, rawCall.arguments);
          const toolCallId =
            typeof rawCall.toolCallId === "string" && rawCall.toolCallId.trim()
              ? rawCall.toolCallId.trim()
              : typeof rawCall.id === "string" && rawCall.id.trim()
                ? rawCall.id.trim()
                : undefined;
          const serialized =
            typeof result === "string" ? result : JSON.stringify(result);
          const repairedResult = await maybeOffloadToolOutput({
            toolName,
            action,
            sessionId,
            toolCallId,
            // Exact-once key — same discriminant as live projection paths.
            operationKey: toolCallId
              ? `tool-output:${sessionId}:${toolCallId}`
              : undefined,
            result: serialized,
            error: rawCall.error === true,
            policy: { maxInlineTokens, maxInlineChars: maxInlineTokens * 4 },
          });
          rawCall.result = repairedResult;
          const after = estimateInlineTokens(repairedResult);
          tokensAfter += after;
          payloadsRepaired++;
          log.log(
            `repairOversizedContextPayloads sessionId=${sessionId} messageId=${msg.id} tool=${toolName} tokens=${before}->${after}`,
          );
        }
      }

      if (payloadsRepaired === 0) {
        return {
          repaired: false,
          messagesScanned: data.messages.length,
          payloadsRepaired,
          tokensBefore,
          tokensAfter,
        };
      }

      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      invalidateSessionsCache();
      log.warn(
        `repairOversizedContextPayloads repaired sessionId=${sessionId} payloads=${payloadsRepaired} tokens=${tokensBefore}->${tokensAfter} reason=${opts?.reason || "pre_run_context_pressure"}`,
      );
      return {
        repaired: true,
        messagesScanned: data.messages.length,
        payloadsRepaired,
        tokensBefore,
        tokensAfter,
      };
    });
  },

  async compactSession(
    sessionId: string,
    summaryContent: string,
    removedMessageIds: string[],
    meta?: Partial<CompactionMeta>,
  ) {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data)
        return {
          outcome: "session_not_found" as const,
          compacted: false,
          messagesBefore: 0,
          messagesAfter: 0,
        };
      const messagesBefore = data.messages.length;
      if (
        removedMessageIds.length <= 0 ||
        removedMessageIds.length > messagesBefore
      ) {
        return {
          outcome: "invalid_boundary" as const,
          compacted: false,
          messagesBefore,
          messagesAfter: messagesBefore,
        };
      }
      // Identity boundary: the removed set must be the exact current prefix of
      // the persisted doc. Any divergence (reordering, deletion, unexpected
      // insertion before the boundary) means the archive no longer matches
      // what would be removed — fail closed and preserve active history.
      for (let i = 0; i < removedMessageIds.length; i++) {
        if (data.messages[i]?.id !== removedMessageIds[i]) {
          log.error(
            `compactSession prefix mismatch sessionId=${sessionId} index=${i} expected=${removedMessageIds[i]} actual=${data.messages[i]?.id ?? "missing"} — failing closed`,
          );
          return {
            outcome: "snapshot_changed" as const,
            compacted: false,
            messagesBefore,
            messagesAfter: messagesBefore,
          };
        }
      }
      const markerId = generateId();
      const kept = data.messages.slice(removedMessageIds.length);
      const compactionMarker: FileMessage = {
        id: markerId,
        sessionId,
        role: "system",
        content: summaryContent,
        thinking: null,
        toolCalls: null,
        systemSteps: null,
        model: "compaction-marker",
        createdAt: new Date().toISOString(),
        compaction: {
          type: "between_turn",
          summary: summaryContent,
          summaryLength: summaryContent.length,
          createdAt: new Date().toISOString(),
          ...meta,
          // Doc-side truth: counts are computed from the persisted doc under
          // the write lock, never trusted from the caller's coordinate space.
          replacedMessageCount: removedMessageIds.length,
          keptMessageCount: kept.length,
        },
      };
      data.messages = [compactionMarker, ...kept];
      data.updatedAt = compactionMarker.createdAt;
      await writeConv(data);
      if (meta?.operationId) {
        const principal = requireCurrentPrincipal();
        if (!principal.userId || !principal.accountId) {
          throw new Error("Compaction commit requires explicit operation ownership");
        }
        const attached = await db
          .update(compactionOperations)
          .set({
            status: "committed",
            outcome: "compacted",
            markerId,
            updatedAt: new Date(compactionMarker.createdAt),
            completedAt: new Date(compactionMarker.createdAt),
          })
          .where(
            and(
              eq(compactionOperations.id, meta.operationId),
              eq(compactionOperations.ownerUserId, principal.userId),
              eq(compactionOperations.accountId, principal.accountId),
              eq(compactionOperations.sessionId, sessionId),
              eq(compactionOperations.ownerBootId, BOOT_ID),
              eq(compactionOperations.attemptCount, meta.operationAttempt ?? -1),
              eq(compactionOperations.status, "ready"),
              sql`${compactionOperations.leaseExpiresAt} > ${new Date(compactionMarker.createdAt)}`,
            ),
          )
          .returning({ id: compactionOperations.id });
        if (attached.length !== 1) {
          throw new Error(`Compaction operation attachment failed: ${meta.operationId}`);
        }
      }
      invalidateSessionsCache();
      const messagesAfter = data.messages.length;
      log.log(
        `compactSession sessionId=${sessionId} messagesBefore=${messagesBefore} messagesAfter=${messagesAfter} replaced=${removedMessageIds.length} summaryLen=${summaryContent.length}`,
      );
      return {
        outcome: "compacted" as const,
        compacted: true,
        messagesBefore,
        messagesAfter,
        markerId,
      };
    });
  },

  async createChildSessionBlockMessage(
    parentSessionId: string,
    meta: ChildSessionBlockMeta,
  ): Promise<string | null> {
    return withConvLock(parentSessionId, async () => {
      const data = await readConv(parentSessionId);
      if (!data) {
        log.warn(
          `createChildSessionBlockMessage: session ${parentSessionId} not found`,
        );
        return null;
      }
      const existing = data.messages.find(
        (m) =>
          m.role === "child_session_block" &&
          m.childSession?.childSessionId === meta.childSessionId,
      );
      if (existing && existing.childSession) {
        existing.childSession = { ...existing.childSession, ...meta };
        existing.content = `Child session: ${meta.role || meta.spawnReason || meta.childSessionId}`;
        data.updatedAt = new Date().toISOString();
        await writeConv(data);
        return existing.id;
      }

      const msg: FileMessage = {
        id: generateId(),
        sessionId: parentSessionId,
        role: "child_session_block",
        content: `Child session: ${meta.role || meta.spawnReason || meta.childSessionId}`,
        thinking: null,
        toolCalls: null,
        systemSteps: null,
        model: null,
        createdAt: new Date().toISOString(),
        childSession: meta,
      };
      data.messages.push(msg);
      data.updatedAt = msg.createdAt;
      await writeConv(data);
      return msg.id;
    });
  },

  async updateChildSessionBlockMessage(
    parentSessionId: string,
    childSessionId: string,
    updates: Partial<ChildSessionBlockMeta>,
  ): Promise<boolean> {
    return withConvLock(parentSessionId, async () => {
      const data = await readConv(parentSessionId);
      if (!data) return false;
      const matches = data.messages.filter(
        (m) =>
          m.role === "child_session_block" &&
          m.childSession?.childSessionId === childSessionId,
      );
      if (matches.length === 0) return false;
      const now = new Date().toISOString();
      for (const msg of matches) {
        if (msg.childSession) Object.assign(msg.childSession, { updatedAt: now, ...updates });
      }
      data.updatedAt = now;
      await writeConv(data);
      return true;
    });
  },

  async deleteChildSessionBlockMessage(
    parentSessionId: string,
    childSessionId: string,
  ): Promise<boolean> {
    return withConvLock(parentSessionId, async () => {
      const data = await readConv(parentSessionId);
      if (!data) return false;
      const before = data.messages.length;
      data.messages = data.messages.filter(
        (m) =>
          !(
            m.role === "child_session_block" &&
            m.childSession?.childSessionId === childSessionId
          ),
      );
      if (data.messages.length === before) return false;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      return true;
    });
  },

  async deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
    return withConvLock(sessionId, async () => {
      const data = await readConv(sessionId);
      if (!data) return false;
      const before = data.messages.length;
      data.messages = data.messages.filter((m) => m.id !== messageId);
      if (data.messages.length === before) return false;
      data.updatedAt = new Date().toISOString();
      await writeConv(data);
      return true;
    });
  },
};

export async function getRecentSessionSummaries(
  sinceHours = 24,
  maxResults = 200,
): Promise<
  Array<{ id: string; title: string; updatedAt: string; snippet: string }>
> {
  try {
    const docs = await documentStorage.getDocumentsByType("chat");
    const cutoff = new Date(
      Date.now() - sinceHours * 60 * 60 * 1000,
    ).toISOString();
    const recent = docs
      .filter((d) => {
        const meta = d.metadata as Record<string, unknown>;
        const updatedAt =
          (meta?.updatedAt as string) || d.updatedAt?.toISOString?.() || "";
        return updatedAt >= cutoff && ((meta?.messageCount as number) || 0) > 0;
      })
      .sort((a, b) => {
        const aDate =
          ((a.metadata as Record<string, unknown>)?.updatedAt as string) || "";
        const bDate =
          ((b.metadata as Record<string, unknown>)?.updatedAt as string) || "";
        return new Date(bDate).getTime() - new Date(aDate).getTime();
      })
      .slice(0, maxResults);

    return buildSessionSummaries(recent.map((doc) => ({
      docId: doc.docId,
      title: doc.title,
      metadata: doc.metadata,
      updatedAt: doc.updatedAt,
    })));
  } catch (err) {
    log.warn("getRecentSessionSummaries error:", err);
    return [];
  }
}

export type SessionSearchDiagnostics = {
  status: "success" | "failure";
  queryBuildMs: number;
  resultDbMs: number;
  countDbMs: number;
  snippetHydrationMs: number;
  totalMs: number;
  resultCount: number;
  totalCount: number;
  source: "target" | "legacy";
};

export class SessionSearchError extends Error {
  readonly kind: "timeout" | "unavailable";

  constructor(kind: "timeout" | "unavailable") {
    super(
      kind === "timeout"
        ? "Session search timed out. Please try again."
        : "Session search is temporarily unavailable. Please try again.",
    );
    this.name = "SessionSearchError";
    this.kind = kind;
  }
}

function sessionSearchSqlState(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)
    ? code
    : undefined;
}

const SESSION_SEARCH_STATEMENT_TIMEOUT_MS = 2_500;

async function executeBoundedSessionSearch<T>(operation: () => Promise<T>): Promise<T> {
  return runOutsideDatabaseTransaction(() =>
    db.transaction(async (transaction) => {
      await transaction.execute(
        sql.raw(`SET LOCAL statement_timeout = '${SESSION_SEARCH_STATEMENT_TIMEOUT_MS}ms'`),
      );
      return runWithDatabaseTransaction(transaction, operation);
    }),
  );
}

export async function searchSessionSummaries(
  query: string,
  sinceHours = 24,
  maxResults = 50,
  onDiagnostics?: (diagnostics: SessionSearchDiagnostics) => void,
): Promise<
  Array<{ id: string; title: string; updatedAt: string; snippet: string }>
> {
  const startedAt = performance.now();
  const trimmed = query.trim();
  if (!trimmed) return [];

  let queryBuildMs = 0;
  let resultDbMs = 0;
  let snippetHydrationMs = 0;
  let resultDbStartedAt: number | undefined;
  let snippetHydrationStartedAt: number | undefined;
  let source: SessionSearchDiagnostics["source"] = "target";

  try {
    const queryBuildStartedAt = performance.now();
    const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    buildLiteralSubstringPattern(trimmed);
    const principal = requireCurrentPrincipal();
    queryBuildMs = performance.now() - queryBuildStartedAt;

    resultDbStartedAt = performance.now();
    // Prefer the target index as soon as it exists — full projection readiness is ideal
    // but partial target beats legacy ILIKE under boot/load spikes.
    const [projectionReady, indexPresent] = await Promise.all([
      isSessionSearchProjectionReady(),
      isSessionSearchSegmentIndexPresent(),
    ]);
    const useTarget = projectionReady || indexPresent;
    source = useTarget ? "target" : "legacy";
    const rows = await executeBoundedSessionSearch(() =>
      useTarget
        ? buildTargetSessionSearchQuery(
            principal,
            cutoff.toISOString(),
            trimmed,
            maxResults,
          )
        : buildLegacySessionSearchQuery(
            principal,
            cutoff.toISOString(),
            trimmed,
            maxResults,
          ),
    );
    resultDbMs = performance.now() - resultDbStartedAt;
    resultDbStartedAt = undefined;

    snippetHydrationStartedAt = performance.now();
    const summaries = useTarget
      ? rows
          .filter((row) => Boolean(row.docId))
          .map((row) => ({
            id: row.docId,
            title: row.title || "Untitled Session",
            updatedAt:
              ((row.metadata as Record<string, unknown> | null)?.updatedAt as string | undefined) ||
              row.updatedAt?.toISOString?.() ||
              "",
            snippet: "matchSnippet" in row ? row.matchSnippet : "",
          }))
      : await buildSessionSummaries(rows.filter((row) => "content" in row && Boolean(row.docId)) as Array<{
          docId: string;
          title: string | null;
          content: string;
          metadata: unknown;
          updatedAt: Date | null;
        }>);
    snippetHydrationMs = performance.now() - snippetHydrationStartedAt;
    snippetHydrationStartedAt = undefined;
    onDiagnostics?.({
      status: "success",
      queryBuildMs,
      resultDbMs,
      countDbMs: 0,
      snippetHydrationMs,
      totalMs: performance.now() - startedAt,
      resultCount: summaries.length,
      totalCount: summaries.length,
      source,
    });
    return summaries;
  } catch (err) {
    const failedAt = performance.now();
    if (resultDbStartedAt !== undefined) {
      resultDbMs = failedAt - resultDbStartedAt;
    }
    if (snippetHydrationStartedAt !== undefined) {
      snippetHydrationMs = failedAt - snippetHydrationStartedAt;
    }
    const sqlState = sessionSearchSqlState(err);
    const kind = sqlState === "57014" ? "timeout" : "unavailable";
    // Soft-fail: empty success keeps agent/tools alive during projection lag or legacy timeouts.
    // Hard-throw only remains available via SessionSearchError for direct callers that rethrow.
    onDiagnostics?.({
      status: "failure",
      queryBuildMs,
      resultDbMs,
      countDbMs: 0,
      snippetHydrationMs,
      totalMs: performance.now() - startedAt,
      resultCount: 0,
      totalCount: 0,
      source,
    });
    log.warn("session search soft-failed; returning empty results", {
      kind,
      sqlState,
      source,
      resultDbMs: Number(resultDbMs.toFixed(2)),
      totalMs: Number((performance.now() - startedAt).toFixed(2)),
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function buildSessionSummaries(
  docs: Array<{
    docId: string;
    title: string | null;
    content?: string;
    metadata: unknown;
    updatedAt?: Date | null;
  }>,
): Promise<Array<{ id: string; title: string; updatedAt: string; snippet: string }>> {
  const results: Array<{
    id: string;
    title: string;
    updatedAt: string;
    snippet: string;
  }> = [];
  for (const doc of docs) {
    let data: SessionData | null = null;
    if (doc.content !== undefined) {
      try {
        data = JSON.parse(doc.content) as SessionData;
      } catch (err) {
        log.warn(`buildSessionSummaries parse error id=${doc.docId}:`, err);
      }
    } else {
      data = await readConv(doc.docId);
    }
    if (!data || data.messages.length === 0) continue;
    const userMessages = data.messages
      .filter((m) => m.role === "user")
      .slice(-3);
    const snippet = userMessages
      .map((m) => m.content.slice(0, 150))
      .join(" | ");
    const meta = doc.metadata as Record<string, unknown>;
    results.push({
      id: doc.docId,
      title: doc.title || data.title,
      updatedAt:
        (meta?.updatedAt as string) ||
        doc.updatedAt?.toISOString?.() ||
        data.updatedAt,
      snippet,
    });
  }
  return results;
}

/**
 * Find an existing session linked to a given intentionId.
 * Returns the session ID if found, null otherwise.
 */
export async function findSessionByIntentionId(
  intentionId: string,
): Promise<string | null> {
  try {
    const docs = await documentStorage.getDocumentsByType("chat", {
      intentionId,
    });
    if (docs.length > 0) {
      return docs[0].docId;
    }
    return null;
  } catch (err) {
    log.warn("findSessionByIntentionId error:", err);
    return null;
  }
}

export async function migrateFromDatabase(): Promise<void> {
  const docs = await documentStorage.getDocumentsByType("chat");
  if (docs.length > 0) {
    log.log(`Already have ${docs.length} sessions in DB, skipping migration`);
    return;
  }

  const { db } = await import("./db");
  const { chatSessions, messages } = await import("@shared/schema");
  const { desc, eq } = await import("drizzle-orm");

  try {
    const allSessions = await db
      .select()
      .from(chatSessions)
      .orderBy(desc(chatSessions.updatedAt));
    if (allSessions.length === 0) {
      log.log("No DB sessions to migrate");
      return;
    }

    log.log(`Migrating ${allSessions.length} sessions from database...`);
    let migrated = 0;

    for (const conv of allSessions) {
      const id = String(conv.id);
      const msgs = await db
        .select()
        .from(messages)
        .where(eq(messages.sessionId, conv.id))
        .orderBy(messages.createdAt);

      const data: SessionData = {
        id,
        title: conv.title,
        status: conv.status,
        sessionKey: conv.sessionKey,
        createdAt: conv.createdAt.toISOString(),
        updatedAt: conv.updatedAt.toISOString(),
        sessionType: "user",
        isPinned: false,
        messages: msgs.map((m) => ({
          id: String(m.id),
          sessionId: id,
          role: m.role,
          content: m.content,
          thinking: m.thinking,
          toolCalls: m.toolCalls,
          model: null,
          createdAt: m.createdAt.toISOString(),
        })) as any,
      };

      await writeConv(data);
      migrated++;
    }

    log.log(`Migration complete: ${migrated} sessions written to DB`);
  } catch (err: unknown) {
    log.error(
      "Migration error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
