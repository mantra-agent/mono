// Use createLogger for logging ONLY
import { eventBus } from "./event-bus";
import type { EventCategory } from "@shared/event-catalog";
import { createLogger } from "./log";
import { mkdirSync, existsSync } from "fs";
import { appendFile, readFile } from "fs/promises";
import { join } from "path";
import { abortTrace } from "./abort-trace";
import type { ModelProviderFailureInfo } from "@shared/models/chat";
import type { DiagnosticChildMode, DiagnosticTimingKind, DiagnosticVisibility } from "@shared/streaming-types";

const log = createLogger("Journal");

export type JournalSource = "agent" | "voice" | "system";

export type JournalEntryType =
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
  | "user_message"
  | "system_prompt_message"
  | "model_info"
  | "compacting"
  | "system_step"
  | "system_notice";

export interface JournalEntry {
  ts: number;
  type: JournalEntryType;
  sessionKey: string;
  sessionId: string;
  source?: JournalSource;
  content?: string;
  toolName?: string;
  toolCallId?: string;
  arguments?: Record<string, unknown>;
  narrative?: string;
  result?: unknown;
  error?: string;
  providerFailure?: ModelProviderFailureInfo;
  runId?: string;
  messageId?: string;
  stopReason?: string;
  thinking?: string;
  fullResponse?: string;
  toolCalls?: unknown[];
  model?: string;
  autoTier?: string;
  persona?: { id: number; name: string; icon: string };
  status?: string;
  stepId?: string;
  step?: string;
  detail?: string;
  elapsedMs?: number;
  parentId?: string;
  startedAt?: number;
  endedAt?: number;
  selfTimeMs?: number;
  timingKind?: DiagnosticTimingKind;
  diagnosticVisibility?: DiagnosticVisibility;
  childMode?: DiagnosticChildMode;
  occurredAt?: number;
  metadata?: Record<string, unknown>;
  severity?: string;
  seq?: number;
  terminationReason?: string;
  abortReason?: string;
  iterationsUsed?: number;
  cost?: number | null;
  apiCallCount?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
}

const activeRunJournals = new Map<string, JournalEntry[]>();
const MAX_RUN_JOURNAL_SIZE = 500;
let journalSeq = 0;
let systemStepSeq = 0;
export function nextSystemStepSeq(): number { return systemStepSeq++; }

interface RunState {
  runId: string | null;
  terminalEmitted: boolean;
  terminalType: "done" | "error" | "aborted" | null;
  terminalEntry: JournalEntry | null;
}
const sessionRunState = new Map<string, RunState>();

function getOrInitRunState(sessionId: string): RunState {
  let s = sessionRunState.get(sessionId);
  if (!s) {
    s = { runId: null, terminalEmitted: false, terminalType: null, terminalEntry: null };
    sessionRunState.set(sessionId, s);
  }
  return s;
}

export function getActiveRunJournal(sessionId: string): JournalEntry[] {
  return activeRunJournals.get(sessionId) || [];
}

export function clearActiveRunJournal(sessionId: string): void {
  activeRunJournals.delete(sessionId);
}

export interface SessionRunStatus {
  currentRunId: string | null;
  terminalEmitted: boolean;
  lastTerminalEvent: { type: "done" | "error" | "aborted"; runId: string | null; ts: number; messageId?: string; error?: string } | null;
}

export function getSessionRunStatus(sessionId: string): SessionRunStatus {
  const s = sessionRunState.get(sessionId);
  if (!s) return { currentRunId: null, terminalEmitted: false, lastTerminalEvent: null };
  const t = s.terminalEntry;
  return {
    currentRunId: s.runId,
    terminalEmitted: s.terminalEmitted,
    lastTerminalEvent: t && s.terminalType ? {
      type: s.terminalType,
      runId: t.runId ?? s.runId ?? null,
      ts: t.ts,
      messageId: t.messageId,
      error: t.error,
    } : null,
  };
}

const JOURNAL_DIR = join(process.cwd(), "logs", "journals");
try { mkdirSync(JOURNAL_DIR, { recursive: true }); } catch {}

const JOURNAL_FLUSH_INTERVAL_MS = 500;
const JOURNAL_FLUSH_BATCH_SIZE = 20;
let journalWriteBuffer: JournalEntry[] = [];
let journalFlushTimer: ReturnType<typeof setTimeout> | null = null;
let journalFlushInProgress: Promise<void> | null = null;

const deletedSessionIds = new Set<string>();

export function markSessionDeleted(sessionId: string): void {
  deletedSessionIds.add(sessionId);
  journalWriteBuffer = journalWriteBuffer.filter(e => e.sessionId !== sessionId);
  sessionRunState.delete(sessionId);
  setTimeout(() => deletedSessionIds.delete(sessionId), 60_000);
}

function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function getJournalFilePath(sessionId: string): string {
  return join(JOURNAL_DIR, `${sanitizeSessionId(sessionId)}.jsonl`);
}

export async function readJournalFile(sessionId: string): Promise<JournalEntry[]> {
  const filePath = getJournalFilePath(sessionId);
  if (!existsSync(filePath)) return [];
  try {
    const content = await readFile(filePath, "utf-8");
    return content.split("\n")
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line) as JournalEntry; } catch { return null; } })
      .filter((e): e is JournalEntry => e !== null);
  } catch (err) {
    log.error(`readJournalFile error sessionId=${sessionId}:`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function flushJournalBuffer(): Promise<void> {
  if (journalFlushInProgress) {
    await journalFlushInProgress;
    if (journalWriteBuffer.length > 0) {
      return flushJournalBuffer();
    }
    return;
  }

  if (journalWriteBuffer.length === 0) return;

  const rawBatch = journalWriteBuffer.splice(0);
  if (journalFlushTimer) {
    clearTimeout(journalFlushTimer);
    journalFlushTimer = null;
  }

  const batch = rawBatch.filter(entry => {
    if (deletedSessionIds.has(entry.sessionId)) {
      log.debug(`Draining entry for deleted session ${entry.sessionId} type=${entry.type}`);
      return false;
    }
    return true;
  });

  if (batch.length === 0) return;

  const doFlush = async () => {
    const bySession = new Map<string, JournalEntry[]>();
    for (const entry of batch) {
      let arr = bySession.get(entry.sessionId);
      if (!arr) { arr = []; bySession.set(entry.sessionId, arr); }
      arr.push(entry);
    }
    for (const [sessionId, entries] of bySession) {
      try {
        const filePath = getJournalFilePath(sessionId);
        const lines = entries.map(e => JSON.stringify(e)).join("\n") + "\n";
        await appendFile(filePath, lines, "utf-8");
        log.verbose(() => `Flushed ${entries.length} entries to file sessionId=${sessionId}`);
      } catch (err: unknown) {
        log.error(`file write error sessionId=${sessionId}:`, err instanceof Error ? err.message : String(err));
      }
    }
  };

  const flushId = `jf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let trackStart: ((id: string, batchSize: number, sessionsTouched: number) => void) | null = null;
  let trackEnd: ((id: string) => void) | null = null;
  try {
    const ww = require("./wedge-watchdog");
    trackStart = ww.trackJournalFlushStart;
    trackEnd = ww.trackJournalFlushEnd;
  } catch { /* watchdog not available */ }
  const sessionsTouched = new Set(batch.map(e => e.sessionId)).size;
  trackStart?.(flushId, batch.length, sessionsTouched);
  // Trace journal flush completion. The 2026-04-28 wedge runbook calls out
  // journal-flush latency as a leading indicator: a flush that takes hundreds
  // of ms means the abort path was likely also stalling on the same disk
  // contention that wedged the route. Emitting this even on success makes
  // post-mortems mechanical instead of guesswork.
  const flushStart = Date.now();
  // Errors and "done" terminals are the closest journal-side proxy for
  // an abort having flushed; the journal itself never sees a literal
  // "aborted" entry type because aborts surface as either an error or a
  // graceful done (with abortReason on the run-result side). We only
  // emit the abort-trace marker when at least one terminal flushed in
  // this batch — that's enough to reconstruct timing in post-mortems
  // without spamming the trace on every delta flush.
  const terminals = batch.filter(e => e.type === "error" || e.type === "done");
  journalFlushInProgress = doFlush();
  try {
    await journalFlushInProgress;
    if (terminals.length > 0) {
      const sessionId = terminals[0].sessionId;
      abortTrace("journal_flushed", {
        sessionId,
        ms: Date.now() - flushStart,
        count: terminals.length,
      });
    }
  } finally {
    journalFlushInProgress = null;
    trackEnd?.(flushId);
  }
}

function scheduleJournalFlush(): void {
  if (journalFlushTimer) return;
  journalFlushTimer = setTimeout(() => {
    journalFlushTimer = null;
    flushJournalBuffer().catch((err: unknown) => {
      log.error("flush error (non-fatal):", err instanceof Error ? err.message : String(err));
    });
  }, JOURNAL_FLUSH_INTERVAL_MS);
}

function queueJournalEntry(entry: JournalEntry): void {
  journalWriteBuffer.push(entry);
  if (journalWriteBuffer.length >= JOURNAL_FLUSH_BATCH_SIZE) {
    flushJournalBuffer().catch((err: unknown) => {
      log.error("flush error (non-fatal):", err instanceof Error ? err.message : String(err));
    });
  } else {
    scheduleJournalFlush();
  }
}

export function appendJournalEntry(entry: JournalEntry): void {
  queueJournalEntry(entry);
}

export function getJournalPath(sessionId: string): string {
  return `chat/journal/${sessionId}`;
}

export function writeJournal(entry: JournalEntry): void {
  const convId = entry.sessionId;

  if (convId) {
    const state = getOrInitRunState(convId);

    if (entry.type === "run_start") {
      state.runId = entry.runId ?? null;
      state.terminalEmitted = false;
      state.terminalType = null;
      state.terminalEntry = null;
    }

    const isTerminal = entry.type === "done" || entry.type === "error";
    if (isTerminal) {
      const sameRun = !entry.runId || !state.runId || entry.runId === state.runId;
      // Stale-run guard: if the terminal belongs to a different (older) run
      // than the current one, do not mutate per-run state. Still let the entry
      // be published so any client cached on that runId can settle.
      if (!sameRun) {
        log.warn(`writeJournal: terminal for stale run sessionId=${convId} eventRun=${entry.runId} currentRun=${state.runId} — publishing without mutating run state`);
      } else {
        if (state.terminalEmitted) {
          // Allow `error` to override a prior `done` for the same run so that
          // persistence failures (executor emits `done`, then route catches an
          // error during persistence) still reach the client. Otherwise suppress
          // duplicates to enforce one terminal per run.
          const isUpgrade = entry.type === "error" && state.terminalType === "done";
          if (!isUpgrade) {
            log.warn(`writeJournal: suppressing duplicate terminal event type=${entry.type} sessionId=${convId} runId=${entry.runId ?? "?"} (already emitted ${state.terminalType})`);
            return;
          }
          log.warn(`writeJournal: upgrading terminal event done -> error sessionId=${convId} runId=${entry.runId ?? "?"} (persistence failure)`);
        }
        state.terminalEmitted = true;
        state.terminalType = entry.type as "done" | "error";
        state.terminalEntry = entry;
      }
    }
  }

  publishJournalToUI(entry);

  if (convId) {
    let buffer = activeRunJournals.get(convId);
    if (!buffer) {
      buffer = [];
      activeRunJournals.set(convId, buffer);
    }
    buffer.push(entry);
    if (buffer.length > MAX_RUN_JOURNAL_SIZE) {
      buffer.splice(0, buffer.length - MAX_RUN_JOURNAL_SIZE);
    }
    if (entry.type === "done" || entry.type === "saved" || entry.type === "error") {
      setTimeout(() => clearActiveRunJournal(convId), 30_000);
    }
  }

  queueJournalEntry(entry);
}

export function publishJournalToUI(entry: JournalEntry, category: EventCategory = "chat"): void {
  log.verbose(() => `publish type=${entry.type} category=${category} session=${entry.sessionId} key=${entry.sessionKey}`);

  // Feed chat events into the server-authoritative SessionManager.
  // Both paths (eventBus + sessionManager) run during migration.
  if (category === "chat" && entry.sessionId) {
    try {
      const { sessionManager } = require("./session-manager");
      sessionManager.applyEvent(entry.sessionId, entry);
    } catch (err) {
      // SessionManager not loaded yet or error — non-fatal, eventBus still works
      log.debug(`sessionManager.applyEvent skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const payload: Record<string, unknown> = { type: entry.type, sessionKey: entry.sessionKey, sessionId: entry.sessionId, runId: entry.runId, ts: entry.ts };

  switch (entry.type) {
    case "thinking":
    case "thinking_complete":
    case "delta":
    case "compacting":
      payload.content = entry.content;
      if (entry.status) payload.status = entry.status;
      if (entry.stepId) payload.stepId = entry.stepId;
      break;
    case "tool_call":
      payload.toolName = entry.toolName;
      payload.arguments = entry.arguments;
      payload.toolCallId = entry.toolCallId;
      if (entry.narrative) payload.narrative = entry.narrative;
      log.verbose(() => `tool_call toolCallId=${entry.toolCallId} toolName=${entry.toolName} sessionKey=${entry.sessionKey}`);
      break;
    case "tool_result":
      payload.toolCallId = entry.toolCallId;
      payload.toolName = entry.toolName;
      payload.result = entry.result;
      payload.error = entry.error;
      break;
    case "tool_use_pause":
      payload.content = entry.content;
      break;
    case "system_step":
      payload.step = entry.step;
      payload.status = entry.status || "done";
      payload.elapsedMs = entry.elapsedMs;
      payload.detail = entry.detail;
      if (entry.metadata) payload.metadata = entry.metadata;
      payload.stepId = entry.stepId;
      payload.parentId = entry.parentId;
      payload.startedAt = entry.startedAt;
      payload.endedAt = entry.endedAt;
      payload.selfTimeMs = entry.selfTimeMs;
      payload.timingKind = entry.timingKind;
      payload.diagnosticVisibility = entry.diagnosticVisibility;
      payload.childMode = entry.childMode;
      payload.occurredAt = entry.occurredAt;
      payload.seq = entry.seq;
      break;
    case "run_start":
      payload.runId = entry.runId;
      break;
    case "model_info":
      payload.model = entry.model;
      payload.autoTier = entry.autoTier;
      payload.persona = entry.persona;
      break;
    case "done":
      payload.messageId = entry.messageId;
      break;
    case "saved":
      payload.messageId = entry.messageId;
      payload.cost = entry.cost;
      payload.apiCallCount = entry.apiCallCount;
      payload.inputTokens = entry.inputTokens;
      payload.outputTokens = entry.outputTokens;
      payload.totalTokens = entry.totalTokens;
      break;
    case "error":
      payload.error = entry.error;
      if (entry.providerFailure) payload.providerFailure = entry.providerFailure;
      break;
    case "system_notice":
      payload.severity = entry.severity;
      payload.notice = entry.content;
      break;
    default:
      log.warn(`unhandled event type in publishJournalToUI: ${entry.type} — publishing with base payload`);
      break;
  }

  const eventName = category === "thought" ? "thought.stream" : "chat.stream";

  eventBus.publish({
    category,
    event: eventName,
    payload,
    sessionKey: entry.sessionKey,
  });
}
