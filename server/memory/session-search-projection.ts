import { and, eq, isNull, lte, sql } from "drizzle-orm";
import {
  accounts,
  documentStoreDocuments,
  sessionSearchSegments,
  users,
  SESSION_SEARCH_PROJECTION_VERSION,
  SESSION_SEARCH_SEGMENT_INDEX,
  type InsertSessionSearchSegment,
} from "@shared/schema";
import { transactionalOutbox, type TransactionalOutboxRow } from "@shared/models/outbox";
import type { SessionAgenda, ToolCallInfo } from "@shared/models/chat";
import {
  ADVISORY_LOCK_NS,
  acquireAdvisoryTransactionLock,
  db,
  runOutsideDatabaseTransaction,
  runWithDatabaseTransaction,
  type DrizzleTx,
} from "../db";
import { createLogger } from "../log";
import { getPostgresErrorCode } from "../postgres-errors";
import {
  createNamedSystemPrincipal,
  createUserPrincipalFromUser,
  tryResolveUserIdentityFoundation,
  type Principal,
} from "../principal";
import { getUserEffectivePermissions } from "../permissions";
import { runWithPrincipal } from "../principal-context";
import { appendTransactionalOutboxEvent } from "../transactional-outbox";

const log = createLogger("SessionSearchProjection");

const CHUNK_CONTENT_CHARS = 3_584;
const CHUNK_OVERLAP_CHARS = 512;
const MAX_SOURCE_CONTENT_CHARS = 64_000;
const MAX_TOOL_CONTENT_CHARS = 16_000;
const MAX_SEGMENTS_PER_SESSION = 600;
const PROJECTION_INSERT_BATCH_SIZE = 100;
const RECONCILIATION_CLAIM_LIMIT = 4;
const RECONCILIATION_STALE_MS = 5 * 60_000;
const PROJECTION_EVENT_TYPE = "session.search_projection.requested";
const PROJECTION_WORKER_PRINCIPAL = createNamedSystemPrincipal("session-search-projection");
const BACKFILL_BATCH_SIZE = 50;
const BACKFILL_LOOKBACK_DAYS = 30;
const BACKFILL_INITIAL_RETRY_MS = 5_000;
const BACKFILL_MAX_RETRY_MS = 5 * 60_000;
const READINESS_CACHE_MS = 30_000;

type ProjectionOperation =
  | "worker_tick"
  | "reconcile_event"
  | "backfill_batch"
  | "replace_projection"
  | "restore_principal"
  | "boot_start";

type ProjectionOperationError = Error & {
  code?: string;
  operation?: ProjectionOperation;
  postgresCode?: string | null;
  failureCount?: number;
  retryMs?: number;
  projectionVersion?: number;
  eventId?: string;
  attempt?: number;
};

function normalizeProjectionError(
  value: unknown,
  operation: ProjectionOperation,
  fallbackCode: string,
  message?: string,
): ProjectionOperationError {
  let error: ProjectionOperationError;
  if (value instanceof Error) {
    error = value as ProjectionOperationError;
  } else if (typeof value === "string" && value.trim()) {
    error = new Error(message || value) as ProjectionOperationError;
  } else {
    error = new Error(message || "Session search projection failed", { cause: value }) as ProjectionOperationError;
  }
  if (!error.code || !/^[A-Z][A-Z0-9_]{1,47}$/.test(String(error.code))) {
    error.code = fallbackCode;
  }
  error.operation = operation;
  const postgresCode = getPostgresErrorCode(value) || getPostgresErrorCode(error);
  if (postgresCode) error.postgresCode = postgresCode;
  return error;
}

function projectionLogContext(options: {
  operation: ProjectionOperation;
  failureCount?: number;
  retryMs?: number;
  projectionVersion?: number;
  eventId?: string;
  attempt?: number;
  postgresCode?: string | null;
}) {
  return {
    operation: options.operation,
    failureCount: options.failureCount,
    retryMs: options.retryMs,
    projectionVersion: options.projectionVersion,
    eventId: options.eventId,
    attempt: options.attempt,
    postgresCode: options.postgresCode ?? undefined,
  };
}
type SearchableMessage = {
  id?: string | null;
  role?: string | null;
  content?: string | null;
  visibility?: "chat" | "diagnostic";
  toolCalls?: unknown;
};

export type SearchableSession = {
  id?: string | null;
  durableRevision?: number | null;
  title?: string | null;
  agenda?: SessionAgenda;
  messages?: SearchableMessage[] | null;
};

interface SessionSearchProjectionPayload {
  documentStoreId: number;
  sessionId: string;
  durableRevision: number;
}

type ProjectionSegment = Pick<
  InsertSessionSearchSegment,
  "segmentKey" | "segmentKind" | "sourceId" | "ordinal" | "content" | "projectionVersion"
>;

type ProjectionWrite = ProjectionSegment & { projectionRevision: number };

let readinessCache: { ready: boolean; expiresAt: number } | null = null;
let backfillStarted = false;
let backfillFailureCount = 0;

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function normalizeDurableRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseProjectionPayload(row: TransactionalOutboxRow): SessionSearchProjectionPayload | null {
  const payload = row.payload;
  const documentStoreId = typeof payload.documentStoreId === "number" && Number.isSafeInteger(payload.documentStoreId)
    ? payload.documentStoreId
    : null;
  const sessionId = typeof payload.sessionId === "string" && payload.sessionId.length > 0
    ? payload.sessionId
    : null;
  const durableRevision = normalizeDurableRevision(payload.durableRevision);
  if (documentStoreId === null || sessionId === null || durableRevision === null) return null;
  return { documentStoreId, sessionId, durableRevision };
}

function projectionRetryDelayMs(attempt: number): number {
  return Math.min(BACKFILL_INITIAL_RETRY_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 6), BACKFILL_MAX_RETRY_MS);
}

function boundedSerializable(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.slice(0, MAX_TOOL_CONTENT_CHARS);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (depth >= 4) return "[nested value omitted]";
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((item) => boundedSerializable(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, nested]) => [key, boundedSerializable(nested, depth + 1)]),
    );
  }
  return String(value);
}

function boundedJson(value: unknown): string {
  try {
    return JSON.stringify(boundedSerializable(value)).slice(0, MAX_TOOL_CONTENT_CHARS);
  } catch {
    return "";
  }
}

function normalizeSearchText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.replaceAll("\u0000", "").trim().slice(0, maxChars);
}

function appendChunks(
  segments: ProjectionSegment[],
  input: {
    kind: ProjectionSegment["segmentKind"];
    sourceId: string;
    segmentIdentity: string;
    text: unknown;
    maxChars?: number;
  },
): void {
  if (segments.length >= MAX_SEGMENTS_PER_SESSION) return;
  const normalized = normalizeSearchText(
    input.text,
    input.maxChars ?? MAX_SOURCE_CONTENT_CHARS,
  );
  if (!normalized) return;

  let offset = 0;
  let ordinal = 0;
  while (offset < normalized.length && segments.length < MAX_SEGMENTS_PER_SESSION) {
    const content = normalized.slice(offset, offset + CHUNK_CONTENT_CHARS);
    segments.push({
      segmentKey: `${input.kind}:${input.segmentIdentity}:${ordinal}`,
      segmentKind: input.kind,
      sourceId: input.sourceId,
      ordinal,
      content,
      projectionVersion: SESSION_SEARCH_PROJECTION_VERSION,
    });
    if (offset + CHUNK_CONTENT_CHARS >= normalized.length) break;
    offset += CHUNK_CONTENT_CHARS - CHUNK_OVERLAP_CHARS;
    ordinal += 1;
  }
}

function toolText(toolCall: ToolCallInfo, index: number): { sourceId: string; text: string } {
  const sourceId = normalizeSearchText(toolCall.toolCallId, 1_000) || String(index);
  const parts = [
    toolCall.toolName,
    boundedJson(toolCall.arguments),
    typeof toolCall.output === "string" ? toolCall.output : "",
    boundedJson(toolCall.result),
    boundedJson(toolCall.error),
  ].filter(Boolean);
  return { sourceId, text: parts.join("\n") };
}

export function buildSessionSearchSegments(session: SearchableSession): ProjectionSegment[] {
  const segments: ProjectionSegment[] = [];
  appendChunks(segments, {
    kind: "title",
    sourceId: "session",
    segmentIdentity: "session",
    text: session.title,
    maxChars: 1_000,
  });

  const agendaItems = Array.isArray(session.agenda?.items) ? session.agenda.items : [];
  for (const [agendaIndex, item] of agendaItems.entries()) {
    const agendaSourceId = normalizeSearchText(item.id, 1_000) || String(agendaIndex);
    appendChunks(segments, {
      kind: "agenda",
      sourceId: agendaSourceId,
      segmentIdentity: String(agendaIndex),
      text: [item.title, item.description, item.resolution].filter(Boolean).join("\n"),
      maxChars: 8_000,
    });
  }

  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (const [messageIndex, message] of messages.entries()) {
    if (!message || typeof message !== "object" || message.visibility === "diagnostic") continue;
    const messageSourceId = normalizeSearchText(message.id, 1_000) || String(messageIndex);
    appendChunks(segments, {
      kind: "message",
      sourceId: messageSourceId,
      segmentIdentity: String(messageIndex),
      text: message.content,
    });
    const toolCalls = Array.isArray(message.toolCalls)
      ? (message.toolCalls as ToolCallInfo[])
      : [];
    for (const [toolIndex, toolCall] of toolCalls.entries()) {
      if (!toolCall || typeof toolCall !== "object") continue;
      const searchable = toolText(toolCall, toolIndex);
      appendChunks(segments, {
        kind: "tool",
        sourceId: `${messageSourceId}:${searchable.sourceId}`,
        segmentIdentity: `${messageIndex}:${toolIndex}`,
        text: searchable.text,
        maxChars: MAX_TOOL_CONTENT_CHARS,
      });
    }
  }

  return segments;
}

export async function replaceSessionSearchProjection(
  documentStoreId: number,
  session: SearchableSession,
): Promise<number> {
  const projectionRevision = normalizeDurableRevision(session.durableRevision);
  if (projectionRevision === null) {
    throw new Error("Session search projection requires a durable source revision");
  }
  const segments: ProjectionWrite[] = buildSessionSearchSegments(session).map(segment => ({
    ...segment,
    projectionRevision,
  }));
  await db
    .delete(sessionSearchSegments)
    .where(eq(sessionSearchSegments.documentStoreId, documentStoreId));
  for (const batch of chunks(segments, PROJECTION_INSERT_BATCH_SIZE)) {
    await db.insert(sessionSearchSegments).values(
      batch.map((segment) => ({ ...segment, documentStoreId })),
    );
  }
  readinessCache = null;
  return segments.length;
}

export async function enqueueSessionSearchProjection(
  tx: DrizzleTx,
  principal: Principal,
  input: SessionSearchProjectionPayload,
): Promise<void> {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Session search projection enqueue requires a user principal");
  }
  await appendTransactionalOutboxEvent(
    tx,
    principal,
    { userId: principal.userId, accountId: principal.accountId },
    {
      eventType: PROJECTION_EVENT_TYPE,
      aggregateType: "chat_session",
      aggregateId: input.sessionId,
      idempotencyKey: `${PROJECTION_EVENT_TYPE}/${input.sessionId}/${input.durableRevision}`,
      payload: input,
    },
  );
}

let indexPresenceCache: { present: boolean; expiresAt: number } | null = null;

/** True when the target trigram index exists — enough to prefer target path over legacy ILIKE. */
export async function isSessionSearchSegmentIndexPresent(): Promise<boolean> {
  if (indexPresenceCache && indexPresenceCache.expiresAt > Date.now()) {
    return indexPresenceCache.present;
  }
  const result = await db.execute(sql`
    SELECT to_regclass(${SESSION_SEARCH_SEGMENT_INDEX}) IS NOT NULL AS present
  `);
  const row = ((result.rows ?? result) as Array<{ present: boolean }>)[0];
  const present = row?.present === true;
  indexPresenceCache = { present, expiresAt: Date.now() + READINESS_CACHE_MS };
  return present;
}

export async function isSessionSearchProjectionReady(): Promise<boolean> {
  if (readinessCache && readinessCache.expiresAt > Date.now()) return readinessCache.ready;
  const cutoff = new Date(Date.now() - BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000);
  const result = await db.execute(sql`
    SELECT to_regclass(${SESSION_SEARCH_SEGMENT_INDEX}) IS NOT NULL
      AND NOT EXISTS (
      SELECT 1
      FROM ${documentStoreDocuments} AS document
      WHERE document.document_type = 'chat'
        AND coalesce((document.metadata->>'messageCount')::int, 0) > 0
        AND coalesce(document.metadata->>'updatedAt', document.updated_at::text, document.created_at::text) >= ${cutoff.toISOString()}
        AND NOT EXISTS (
          SELECT 1
          FROM ${sessionSearchSegments} AS segment
          WHERE segment.document_store_id = document.id
            AND segment.projection_version = ${SESSION_SEARCH_PROJECTION_VERSION}
            AND segment.projection_revision = coalesce((document.metadata->>'durableRevision')::int, 0)
        )
      LIMIT 1
    ) AS ready
  `);
  const row = ((result.rows ?? result) as Array<{ ready: boolean }>)[0];
  const ready = row?.ready === true;
  readinessCache = { ready, expiresAt: Date.now() + READINESS_CACHE_MS };
  if (ready) {
    indexPresenceCache = { present: true, expiresAt: Date.now() + READINESS_CACHE_MS };
  }
  return ready;
}

type BackfillCandidate = {
  id: number;
  documentId: string;
  ownerUserId: string;
  accountId: string;
};

async function listBackfillCandidates(): Promise<BackfillCandidate[]> {
  const cutoff = new Date(Date.now() - BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000);
  return runWithPrincipal(PROJECTION_WORKER_PRINCIPAL, () => db
    .select({
      id: documentStoreDocuments.id,
      documentId: documentStoreDocuments.documentId,
      ownerUserId: documentStoreDocuments.ownerUserId,
      accountId: documentStoreDocuments.accountId,
    })
    .from(documentStoreDocuments)
    .where(and(
      eq(documentStoreDocuments.documentType, "chat"),
      sql`${documentStoreDocuments.ownerUserId} IS NOT NULL`,
      sql`${documentStoreDocuments.accountId} IS NOT NULL`,
      sql`coalesce((${documentStoreDocuments.metadata}->>'messageCount')::int, 0) > 0`,
      sql`coalesce(${documentStoreDocuments.metadata}->>'updatedAt', ${documentStoreDocuments.updatedAt}::text, ${documentStoreDocuments.createdAt}::text) >= ${cutoff.toISOString()}`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${sessionSearchSegments}
        WHERE ${sessionSearchSegments.documentStoreId} = ${documentStoreDocuments.id}
          AND ${sessionSearchSegments.projectionVersion} = ${SESSION_SEARCH_PROJECTION_VERSION}
          AND ${sessionSearchSegments.projectionRevision} = coalesce((${documentStoreDocuments.metadata}->>'durableRevision')::int, 0)
      )`,
    ))
    .orderBy(documentStoreDocuments.updatedAt)
    .limit(BACKFILL_BATCH_SIZE)) as Promise<BackfillCandidate[]>;
}

async function restoreProjectionPrincipal(ownerUserId: string, accountId: string): Promise<Principal> {
  const [owner] = await db
    .select({ user: users })
    .from(users)
    .innerJoin(
      accounts,
      and(
        eq(accounts.id, accountId),
        eq(accounts.kind, "personal"),
        eq(accounts.ownerUserId, ownerUserId),
      ),
    )
    .where(eq(users.id, ownerUserId))
    .limit(1);
  if (!owner?.user) throw new Error("Session search projection owner/account identity is no longer valid");
  const foundation = await tryResolveUserIdentityFoundation(owner.user.id);
  return {
    ...createUserPrincipalFromUser(
      owner.user,
      accountId,
      foundation?.accountId === accountId ? foundation.instanceId : null,
    ),
    permissions: await getUserEffectivePermissions(owner.user.id),
  };
}

async function backfillDocument(candidate: BackfillCandidate): Promise<"projected" | "skipped"> {
  let principal: Principal;
  try {
    principal = await restoreProjectionPrincipal(candidate.ownerUserId, candidate.accountId);
  } catch {
    return "skipped";
  }

  return runWithPrincipal(principal, () => db.transaction(async (transaction) => runWithDatabaseTransaction(transaction, async () => {
    await acquireAdvisoryTransactionLock(
      transaction,
      ADVISORY_LOCK_NS.SESSION_SEARCH_PROJECTION,
      candidate.documentId,
    );
    const [document] = await transaction
      .select({
        id: documentStoreDocuments.id,
        content: documentStoreDocuments.content,
        metadata: documentStoreDocuments.metadata,
      })
      .from(documentStoreDocuments)
      .where(and(
        eq(documentStoreDocuments.id, candidate.id),
        eq(documentStoreDocuments.documentType, "chat"),
      ))
      .limit(1);
    if (!document) return "skipped";

    const sourceRevision = normalizeDurableRevision(
      (document.metadata as Record<string, unknown> | null)?.durableRevision,
    );
    if (sourceRevision === null) return "skipped";
    const current = await transaction
      .select({ id: sessionSearchSegments.id })
      .from(sessionSearchSegments)
      .where(and(
        eq(sessionSearchSegments.documentStoreId, document.id),
        eq(sessionSearchSegments.projectionVersion, SESSION_SEARCH_PROJECTION_VERSION),
        eq(sessionSearchSegments.projectionRevision, sourceRevision),
      ))
      .limit(1);
    if (current.length > 0) return "skipped";

    let session: SearchableSession;
    try {
      session = JSON.parse(document.content) as SearchableSession;
    } catch {
      log.warn("session search projection backfill skipped malformed document", {
        documentStoreId: document.id,
      });
      return "skipped";
    }
    if (normalizeDurableRevision(session.durableRevision) !== sourceRevision) return "skipped";
    await replaceSessionSearchProjection(document.id, session);
    return "projected";
  })));
}

async function claimProjectionEvents(): Promise<TransactionalOutboxRow[]> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + RECONCILIATION_STALE_MS);
  return runWithPrincipal(PROJECTION_WORKER_PRINCIPAL, () => db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(transactionalOutbox)
      .where(and(
        eq(transactionalOutbox.eventType, PROJECTION_EVENT_TYPE),
        isNull(transactionalOutbox.publishedAt),
        lte(transactionalOutbox.availableAt, now),
      ))
      .orderBy(transactionalOutbox.createdAt)
      .limit(RECONCILIATION_CLAIM_LIMIT)
      .for("update", { skipLocked: true });
    const claimed: TransactionalOutboxRow[] = [];
    for (const row of due) {
      const [updated] = await tx
        .update(transactionalOutbox)
        .set({
          deliveryAttempts: row.deliveryAttempts + 1,
          availableAt: leaseUntil,
          lastErrorCode: null,
        })
        .where(and(
          eq(transactionalOutbox.id, row.id),
          isNull(transactionalOutbox.publishedAt),
        ))
        .returning();
      if (updated) claimed.push(updated);
    }
    return claimed;
  }));
}

async function markProjectionEventPublished(id: string): Promise<void> {
  await runWithPrincipal(PROJECTION_WORKER_PRINCIPAL, () => db
    .update(transactionalOutbox)
    .set({ publishedAt: new Date(), lastErrorCode: null })
    .where(and(eq(transactionalOutbox.id, id), isNull(transactionalOutbox.publishedAt))));
}

async function retryProjectionEvent(row: TransactionalOutboxRow, error: unknown): Promise<void> {
  const retryMs = projectionRetryDelayMs(row.deliveryAttempts);
  const normalized = normalizeProjectionError(
    error,
    "reconcile_event",
    "SESSION_SEARCH_PROJECTION_RECONCILE_FAILED",
  );
  const errorCode = (
    normalized.postgresCode
    || normalized.code
    || normalized.name
    || "SESSION_SEARCH_PROJECTION_RECONCILE_FAILED"
  ).slice(0, 120);
  await runWithPrincipal(PROJECTION_WORKER_PRINCIPAL, () => db
    .update(transactionalOutbox)
    .set({
      availableAt: new Date(Date.now() + retryMs),
      lastErrorCode: errorCode,
    })
    .where(and(eq(transactionalOutbox.id, row.id), isNull(transactionalOutbox.publishedAt))));
  normalized.eventId = row.id;
  normalized.attempt = row.deliveryAttempts;
  normalized.retryMs = retryMs;
  // Deferred retries remain warn-level: the worker continues and will reclaim the event.
  log.warn(
    "session search projection reconciliation deferred",
    projectionLogContext({
      operation: "reconcile_event",
      eventId: row.id,
      attempt: row.deliveryAttempts,
      retryMs,
      postgresCode: normalized.postgresCode,
      projectionVersion: SESSION_SEARCH_PROJECTION_VERSION,
    }),
  );
}

async function reconcileProjectionEvent(row: TransactionalOutboxRow): Promise<void> {
  const payload = parseProjectionPayload(row);
  if (!payload) {
    await markProjectionEventPublished(row.id);
    log.warn("session search projection event discarded invalid payload", { eventId: row.id });
    return;
  }
  const principal = await restoreProjectionPrincipal(row.ownerUserId, row.accountId);
  const outcome = await runWithPrincipal(principal, () => db.transaction(async (transaction) => runWithDatabaseTransaction(transaction, async () => {
    await acquireAdvisoryTransactionLock(
      transaction,
      ADVISORY_LOCK_NS.SESSION_SEARCH_PROJECTION,
      payload.sessionId,
    );
    const [document] = await transaction
      .select({
        id: documentStoreDocuments.id,
        documentId: documentStoreDocuments.documentId,
        content: documentStoreDocuments.content,
        metadata: documentStoreDocuments.metadata,
      })
      .from(documentStoreDocuments)
      .where(and(
        eq(documentStoreDocuments.id, payload.documentStoreId),
        eq(documentStoreDocuments.documentType, "chat"),
        eq(documentStoreDocuments.documentId, payload.sessionId),
        eq(documentStoreDocuments.ownerUserId, row.ownerUserId),
        eq(documentStoreDocuments.accountId, row.accountId),
      ))
      .limit(1);
    if (!document) return "missing" as const;
    const metadata = document.metadata as Record<string, unknown> | null;
    const currentRevision = normalizeDurableRevision(metadata?.durableRevision);
    if (currentRevision !== payload.durableRevision) return "superseded" as const;
    let session: SearchableSession;
    try {
      session = JSON.parse(document.content) as SearchableSession;
    } catch {
      return "malformed" as const;
    }
    if (normalizeDurableRevision(session.durableRevision) !== payload.durableRevision) {
      return "superseded" as const;
    }
    const segmentCount = await replaceSessionSearchProjection(document.id, session);
    return { outcome: "projected" as const, segmentCount };
  })));
  if (outcome === "malformed") throw new Error("Session search projection source document is malformed");
  await markProjectionEventPublished(row.id);
  log.debug("session search projection reconciliation completed", {
    eventId: row.id,
    aggregateId: row.aggregateId,
    durableRevision: payload.durableRevision,
    outcome: typeof outcome === "string" ? outcome : outcome.outcome,
    segmentCount: typeof outcome === "string" ? 0 : outcome.segmentCount,
  });
}

async function reconcilePendingProjectionEvents(): Promise<number> {
  const claimed = await claimProjectionEvents();
  for (const row of claimed) {
    try {
      await reconcileProjectionEvent(row);
    } catch (error) {
      await retryProjectionEvent(row, error);
    }
  }
  return claimed.length;
}

async function runBackfillBatch(): Promise<boolean> {
  const candidates = await listBackfillCandidates();
  if (candidates.length === 0) return true;
  let projected = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const outcome = await backfillDocument(candidate);
    if (outcome === "projected") projected += 1;
    else skipped += 1;
  }
  log.info("session search projection backfill batch completed", {
    candidates: candidates.length,
    projected,
    skipped,
  });
  return candidates.length < BACKFILL_BATCH_SIZE;
}

export function startSessionSearchProjectionBackfill(): void {
  if (backfillStarted) return;
  backfillStarted = true;
  const run = async (): Promise<void> => {
    let retryMs = BACKFILL_INITIAL_RETRY_MS;
    try {
      const reconciliationCount = await runOutsideDatabaseTransaction(
        reconcilePendingProjectionEvents,
      );
      const complete = await runOutsideDatabaseTransaction(runBackfillBatch);
      backfillFailureCount = 0;
      readinessCache = null;
      if (reconciliationCount > 0) {
        log.debug("session search projection reconciliation batch completed", {
          events: reconciliationCount,
        });
      }
      if (complete && await isSessionSearchProjectionReady()) {
        retryMs = BACKFILL_MAX_RETRY_MS;
      }
    } catch (error) {
      backfillFailureCount += 1;
      retryMs = projectionRetryDelayMs(backfillFailureCount);
      const normalized = normalizeProjectionError(
        error,
        "worker_tick",
        "SESSION_SEARCH_PROJECTION_WORKER_FAILED",
      );
      normalized.failureCount = backfillFailureCount;
      normalized.retryMs = retryMs;
      normalized.projectionVersion = SESSION_SEARCH_PROJECTION_VERSION;
      log.error(
        "session search projection worker failed",
        normalized,
        projectionLogContext({
          operation: "worker_tick",
          failureCount: backfillFailureCount,
          retryMs,
          projectionVersion: SESSION_SEARCH_PROJECTION_VERSION,
          postgresCode: normalized.postgresCode,
        }),
      );
    }
    setTimeout(run, retryMs).unref();
  };

  setTimeout(run, 1_000).unref();
}
