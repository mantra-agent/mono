import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
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
  hasAmbientDatabaseTransaction,
  runWithDatabaseTransaction,
  type DrizzleTx,
} from "../db";
import { createLogger } from "../log";
import { getPostgresErrorCode } from "../postgres-errors";
import {
  createNamedSystemPrincipal,
  createUserPrincipalFromUser,
  type Principal,
} from "../principal";
import { runWithPrincipal } from "../principal-context";
import { combineWithWritableScope } from "../scoped-storage";
import { appendTransactionalOutboxEvent } from "../transactional-outbox";

const log = createLogger("SessionSearchProjection");

const CHUNK_CONTENT_CHARS = 3_584;
const CHUNK_OVERLAP_CHARS = 512;
const MAX_SOURCE_CONTENT_CHARS = 64_000;
const MAX_TOOL_CONTENT_CHARS = 16_000;
const MAX_SEGMENTS_PER_SESSION = 600;
const SEGMENT_INSERT_BATCH_SIZE = 100;
const BACKFILL_BATCH_SIZE = 50;
const BACKFILL_LOOKBACK_DAYS = 30;
const WORKER_BATCH_SIZE = 10;
const WORKER_CONCURRENCY = 2;
const WORKER_POLL_MS = 2_000;
const WORKER_LEASE_MS = 60_000;
const RETRY_INITIAL_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const READINESS_CACHE_MS = 30_000;
const OUTBOX_EVENT_TYPE = "session.search_projection.requested";
const OUTBOX_AGGREGATE_TYPE = "chat_session";
const PROJECTION_WORKER_PRINCIPAL = createNamedSystemPrincipal("session-search-projection");

type SearchableMessage = {
  id?: string | null;
  role?: string | null;
  content?: string | null;
  visibility?: "chat" | "diagnostic";
  assistantState?: string;
  toolCalls?: unknown;
};

export type SearchableSession = {
  id?: string | null;
  durableRevision?: number;
  updatedAt?: string;
  status?: string | null;
  type?: "text" | "voice" | "meeting";
  sessionType?: string | null;
  title?: string | null;
  agenda?: SessionAgenda;
  messages?: SearchableMessage[] | null;
};

type ProjectionSegment = Pick<
  InsertSessionSearchSegment,
  "segmentKey" | "segmentKind" | "sourceId" | "ordinal" | "content" | "projectionVersion" | "sourceRevision"
>;

type ProjectionOutboxPayload = {
  documentStoreId: number;
  sessionId: string;
  durableRevision: number;
};

type ProjectionOutboxRow = TransactionalOutboxRow & { payload: Record<string, unknown> };

const documentScopeColumns = {
  scope: documentStoreDocuments.scope,
  ownerUserId: documentStoreDocuments.ownerUserId,
  accountId: documentStoreDocuments.accountId,
  vaultId: documentStoreDocuments.vaultId,
};

let readinessCache: { ready: boolean; expiresAt: number } | null = null;
let workerStarted = false;
let backfillReady = false;
let backfillFailureCount = 0;

function requireUserPrincipal(principal: Principal): asserts principal is Principal & { userId: string; accountId: string } {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Session search projection work requires an explicit user principal");
  }
}

function normalizeDurableRevision(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function parseProjectionPayload(row: ProjectionOutboxRow): ProjectionOutboxPayload {
  const documentStoreId = row.payload.documentStoreId;
  const sessionId = row.payload.sessionId;
  const durableRevision = row.payload.durableRevision;
  if (
    typeof documentStoreId !== "number" ||
    !Number.isSafeInteger(documentStoreId) ||
    documentStoreId <= 0 ||
    typeof sessionId !== "string" ||
    !sessionId ||
    typeof durableRevision !== "number" ||
    !Number.isSafeInteger(durableRevision) ||
    durableRevision <= 0
  ) {
    throw new Error("Session search projection outbox payload is invalid");
  }
  return { documentStoreId, sessionId, durableRevision };
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
    sourceRevision: number;
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
      sourceRevision: input.sourceRevision,
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

export function isSessionSearchProjectionEligible(session: SearchableSession): boolean {
  const messages = session.messages || [];
  const lastMessage = messages[messages.length - 1];
  return (
    !["streaming", "pending"].includes(session.status || "") &&
    !messages.some((message) => message.assistantState === "streaming") &&
    lastMessage?.role !== "user"
  );
}

export function buildSessionSearchSegments(
  session: SearchableSession,
  sourceRevision = normalizeDurableRevision(session.durableRevision),
): ProjectionSegment[] {
  const segments: ProjectionSegment[] = [];
  appendChunks(segments, {
    kind: "title",
    sourceId: "session",
    segmentIdentity: "session",
    text: session.title,
    sourceRevision,
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
      sourceRevision,
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
      sourceRevision,
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
        sourceRevision,
        maxChars: MAX_TOOL_CONTENT_CHARS,
      });
    }
  }

  return segments;
}

async function replaceProjectionInAmbientTransaction(
  documentStoreId: number,
  sourceRevision: number,
  session: SearchableSession,
): Promise<number> {
  const [document] = await db
    .select({ metadata: documentStoreDocuments.metadata })
    .from(documentStoreDocuments)
    .where(eq(documentStoreDocuments.id, documentStoreId))
    .limit(1)
    .for("update");
  const currentRevision = normalizeDurableRevision(
    (document?.metadata as Record<string, unknown> | null)?.durableRevision,
  );
  if (!document || currentRevision !== sourceRevision) {
    throw Object.assign(new Error("Session search projection source revision is stale"), {
      code: "STALE_PROJECTION_REVISION",
    });
  }

  const segments = buildSessionSearchSegments(session, sourceRevision);
  await db
    .delete(sessionSearchSegments)
    .where(eq(sessionSearchSegments.documentStoreId, documentStoreId));
  for (let offset = 0; offset < segments.length; offset += SEGMENT_INSERT_BATCH_SIZE) {
    const batch = segments.slice(offset, offset + SEGMENT_INSERT_BATCH_SIZE);
    await db.insert(sessionSearchSegments).values(
      batch.map((segment) => ({ ...segment, documentStoreId })),
    );
  }
  readinessCache = null;
  return segments.length;
}

export async function replaceSessionSearchProjection(
  documentStoreId: number,
  sourceRevision: number,
  session: SearchableSession,
): Promise<number> {
  if (hasAmbientDatabaseTransaction()) {
    return replaceProjectionInAmbientTransaction(documentStoreId, sourceRevision, session);
  }
  return db.transaction((transaction) =>
    runWithDatabaseTransaction(transaction, () =>
      replaceProjectionInAmbientTransaction(documentStoreId, sourceRevision, session),
    ),
  );
}

export async function enqueueSessionSearchProjection(
  tx: DrizzleTx,
  principal: Principal,
  input: ProjectionOutboxPayload,
): Promise<void> {
  requireUserPrincipal(principal);
  await appendTransactionalOutboxEvent(
    tx,
    principal,
    { userId: principal.userId, accountId: principal.accountId },
    {
      eventType: OUTBOX_EVENT_TYPE,
      aggregateType: OUTBOX_AGGREGATE_TYPE,
      aggregateId: input.sessionId,
      idempotencyKey: `${OUTBOX_EVENT_TYPE}/${input.sessionId}/${input.durableRevision}`,
      payload: input,
    },
  );
  readinessCache = null;
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
        AND coalesce(document.metadata->>'status', '') NOT IN ('streaming', 'pending')
        AND coalesce(document.metadata->>'updatedAt', document.updated_at::text, document.created_at::text) >= ${cutoff.toISOString()}
        AND NOT EXISTS (
          SELECT 1
          FROM ${sessionSearchSegments} AS segment
          WHERE segment.document_store_id = document.id
            AND segment.projection_version = ${SESSION_SEARCH_PROJECTION_VERSION}
            AND segment.source_revision = coalesce((document.metadata->>'durableRevision')::int, 0)
        )
      LIMIT 1
    ) AS ready
  `);
  const row = ((result.rows ?? result) as Array<{ ready: boolean }>)[0];
  const ready = row?.ready === true;
  readinessCache = { ready, expiresAt: Date.now() + READINESS_CACHE_MS };
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
  return db
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
      sql`coalesce(${documentStoreDocuments.metadata}->>'status', '') NOT IN ('streaming', 'pending')`,
      sql`coalesce(${documentStoreDocuments.metadata}->>'updatedAt', ${documentStoreDocuments.updatedAt}::text, ${documentStoreDocuments.createdAt}::text) >= ${cutoff.toISOString()}`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${sessionSearchSegments}
        WHERE ${sessionSearchSegments.documentStoreId} = ${documentStoreDocuments.id}
          AND ${sessionSearchSegments.projectionVersion} = ${SESSION_SEARCH_PROJECTION_VERSION}
          AND ${sessionSearchSegments.sourceRevision} = coalesce((${documentStoreDocuments.metadata}->>'durableRevision')::int, 0)
      )`,
    ))
    .orderBy(documentStoreDocuments.updatedAt)
    .limit(BACKFILL_BATCH_SIZE) as Promise<BackfillCandidate[]>;
}

async function resolveOwnerPrincipal(
  ownerUserId: string,
  accountId: string,
  vaultId?: string | null,
): Promise<Principal & { userId: string; accountId: string }> {
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
  if (!owner?.user) throw new Error("Session search projection owner is unavailable");
  const principal = createUserPrincipalFromUser(owner.user, accountId);
  return {
    ...principal,
    userId: ownerUserId,
    accountId,
    ...(vaultId ? { activeVaultId: vaultId } : {}),
  };
}

async function backfillDocument(candidate: BackfillCandidate): Promise<"queued" | "skipped"> {
  const principal = await resolveOwnerPrincipal(candidate.ownerUserId, candidate.accountId);
  return runWithPrincipal(principal, () => db.transaction(async (transaction) =>
    runWithDatabaseTransaction(transaction, async () => {
      await acquireAdvisoryTransactionLock(
        transaction,
        ADVISORY_LOCK_NS.CHAT_DOCUMENT,
        candidate.documentId,
      );
      const [document] = await transaction
        .select({
          id: documentStoreDocuments.id,
          documentId: documentStoreDocuments.documentId,
          content: documentStoreDocuments.content,
          metadata: documentStoreDocuments.metadata,
          vaultId: documentStoreDocuments.vaultId,
        })
        .from(documentStoreDocuments)
        .where(combineWithWritableScope(
          principal,
          documentScopeColumns,
          and(
            eq(documentStoreDocuments.id, candidate.id),
            eq(documentStoreDocuments.documentType, "chat"),
          ),
        ))
        .limit(1)
        .for("update");
      if (!document) return "skipped";

      let session: SearchableSession;
      try {
        session = JSON.parse(document.content) as SearchableSession;
      } catch {
        log.warn("session search projection backfill skipped malformed document", {
          documentStoreId: document.id,
        });
        return "skipped";
      }
      const durableRevision = normalizeDurableRevision(
        (document.metadata as Record<string, unknown> | null)?.durableRevision ?? session.durableRevision,
      );
      if (!durableRevision || !isSessionSearchProjectionEligible(session)) return "skipped";
      await enqueueSessionSearchProjection(transaction, principal, {
        documentStoreId: document.id,
        sessionId: document.documentId,
        durableRevision,
      });
      return "queued";
    }),
  ));
}

async function runBackfillBatch(): Promise<boolean> {
  const candidates = await runWithPrincipal(PROJECTION_WORKER_PRINCIPAL, listBackfillCandidates);
  if (candidates.length === 0) return true;
  let queued = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const outcome = await backfillDocument(candidate);
    if (outcome === "queued") queued += 1;
    else skipped += 1;
  }
  log.info("session search projection backfill batch completed", {
    candidates: candidates.length,
    queued,
    skipped,
  });
  return candidates.length < BACKFILL_BATCH_SIZE;
}

async function claimProjectionWork(): Promise<ProjectionOutboxRow[]> {
  return runWithPrincipal(PROJECTION_WORKER_PRINCIPAL, () => db.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(transactionalOutbox)
      .where(and(
        eq(transactionalOutbox.eventType, OUTBOX_EVENT_TYPE),
        isNull(transactionalOutbox.publishedAt),
        lte(transactionalOutbox.availableAt, new Date()),
      ))
      .orderBy(transactionalOutbox.createdAt)
      .limit(WORKER_BATCH_SIZE)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const claimed = await transaction
      .update(transactionalOutbox)
      .set({
        availableAt: new Date(Date.now() + WORKER_LEASE_MS),
        deliveryAttempts: sql`${transactionalOutbox.deliveryAttempts} + 1`,
        lastErrorCode: null,
      })
      .where(inArray(transactionalOutbox.id, ids))
      .returning();
    return claimed as ProjectionOutboxRow[];
  }));
}

async function resolveProjectionPrincipal(
  row: ProjectionOutboxRow,
  payload: ProjectionOutboxPayload,
): Promise<Principal & { userId: string; accountId: string }> {
  const identity = await runWithPrincipal(PROJECTION_WORKER_PRINCIPAL, async () => {
    const [document] = await db
      .select({
        documentId: documentStoreDocuments.documentId,
        ownerUserId: documentStoreDocuments.ownerUserId,
        accountId: documentStoreDocuments.accountId,
        vaultId: documentStoreDocuments.vaultId,
      })
      .from(documentStoreDocuments)
      .where(and(
        eq(documentStoreDocuments.id, payload.documentStoreId),
        eq(documentStoreDocuments.documentType, "chat"),
        eq(documentStoreDocuments.documentId, payload.sessionId),
      ))
      .limit(1);
    return document;
  });
  if (
    !identity ||
    identity.ownerUserId !== row.ownerUserId ||
    identity.accountId !== row.accountId
  ) {
    throw new Error("Session search projection ownership changed");
  }
  return resolveOwnerPrincipal(row.ownerUserId, row.accountId, identity.vaultId);
}

async function projectClaimedRow(row: ProjectionOutboxRow): Promise<"projected"> {
  const payload = parseProjectionPayload(row);
  const principal = await resolveProjectionPrincipal(row, payload);
  const result = await runWithPrincipal(principal, () => db.transaction(async (transaction) =>
    runWithDatabaseTransaction(transaction, async () => {
      await acquireAdvisoryTransactionLock(
        transaction,
        ADVISORY_LOCK_NS.CHAT_DOCUMENT,
        payload.sessionId,
      );
      const [document] = await transaction
        .select({
          id: documentStoreDocuments.id,
          content: documentStoreDocuments.content,
          metadata: documentStoreDocuments.metadata,
        })
        .from(documentStoreDocuments)
        .where(combineWithWritableScope(
          principal,
          documentScopeColumns,
          and(
            eq(documentStoreDocuments.id, payload.documentStoreId),
            eq(documentStoreDocuments.documentType, "chat"),
            eq(documentStoreDocuments.documentId, payload.sessionId),
          ),
        ))
        .limit(1)
        .for("update");
      if (!document) throw new Error("Session search projection document is unavailable");

      const currentRevision = normalizeDurableRevision(
        (document.metadata as Record<string, unknown> | null)?.durableRevision,
      );
      let session: SearchableSession;
      try {
        session = JSON.parse(document.content) as SearchableSession;
      } catch {
        throw new Error("Session search projection document is malformed");
      }
      if (!isSessionSearchProjectionEligible(session)) {
        throw Object.assign(new Error("Session search projection source is not settled"), {
          code: "PROJECTION_SOURCE_NOT_SETTLED",
        });
      }
      const segmentCount = await replaceSessionSearchProjection(
        document.id,
        currentRevision,
        session,
      );
      return {
        outcome: "projected" as const,
        session,
        segmentCount,
        sourceRevision: currentRevision,
      };
    }),
  ));

  if (result.outcome === "projected") {
    if (result.session.type !== "meeting" && result.session.sessionType !== "meeting") {
      const { indexSettledSessionReferences } = await import("../session-reference-index");
      await runWithPrincipal(principal, () => indexSettledSessionReferences(principal, result.session));
    }
    log.debug("session search projection reconciled", {
      documentStoreId: payload.documentStoreId,
      durableRevision: result.sourceRevision,
      segmentCount: result.segmentCount,
    });
  }
  return result.outcome;
}

async function markProjectionPublished(row: ProjectionOutboxRow): Promise<void> {
  await runWithPrincipal(PROJECTION_WORKER_PRINCIPAL, () => db
    .update(transactionalOutbox)
    .set({ publishedAt: new Date(), lastErrorCode: null })
    .where(and(
      eq(transactionalOutbox.id, row.id),
      eq(transactionalOutbox.ownerUserId, row.ownerUserId),
      eq(transactionalOutbox.accountId, row.accountId),
      isNull(transactionalOutbox.publishedAt),
    )));
}

function retryDelayMs(attempts: number): number {
  return Math.min(
    RETRY_INITIAL_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 6),
    RETRY_MAX_MS,
  );
}

async function rescheduleProjection(row: ProjectionOutboxRow, error: unknown): Promise<void> {
  const postgresCode = getPostgresErrorCode(error);
  const errorName = error instanceof Error ? error.name : typeof error;
  const retryMs = retryDelayMs(row.deliveryAttempts);
  await runWithPrincipal(PROJECTION_WORKER_PRINCIPAL, () => db
    .update(transactionalOutbox)
    .set({
      availableAt: new Date(Date.now() + retryMs),
      lastErrorCode: (postgresCode || errorName).slice(0, 100),
    })
    .where(and(
      eq(transactionalOutbox.id, row.id),
      eq(transactionalOutbox.ownerUserId, row.ownerUserId),
      eq(transactionalOutbox.accountId, row.accountId),
      isNull(transactionalOutbox.publishedAt),
    )));
  log.warn("session search projection reconciliation failed", {
    errorName,
    postgresCode,
    deliveryAttempts: row.deliveryAttempts,
    retryMs,
    projectionVersion: SESSION_SEARCH_PROJECTION_VERSION,
  });
}

async function processProjectionRow(row: ProjectionOutboxRow): Promise<void> {
  try {
    await projectClaimedRow(row);
    await markProjectionPublished(row);
  } catch (error) {
    await rescheduleProjection(row, error);
  }
}

async function processProjectionWorkBatch(): Promise<number> {
  const rows = await claimProjectionWork();
  if (rows.length === 0) return 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(WORKER_CONCURRENCY, rows.length) }, async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      await processProjectionRow(row);
    }
  });
  await Promise.all(workers);
  return rows.length;
}

export function startSessionSearchProjectionBackfill(): void {
  if (workerStarted) return;
  workerStarted = true;

  const run = async (): Promise<void> => {
    try {
      const processed = await processProjectionWorkBatch();
      if (!backfillReady) {
        const noMoreCandidates = await runBackfillBatch();
        backfillFailureCount = 0;
        readinessCache = null;
        if (noMoreCandidates && await isSessionSearchProjectionReady()) {
          backfillReady = true;
          log.info("session search projection backfill ready", {
            projectionVersion: SESSION_SEARCH_PROJECTION_VERSION,
            lookbackDays: BACKFILL_LOOKBACK_DAYS,
          });
        }
      }
      setTimeout(run, processed > 0 ? 0 : WORKER_POLL_MS).unref();
    } catch (error) {
      backfillFailureCount += 1;
      const retryMs = retryDelayMs(backfillFailureCount);
      log.error("session search projection worker failed", {
        errorName: error instanceof Error ? error.name : typeof error,
        postgresCode: getPostgresErrorCode(error),
        failureCount: backfillFailureCount,
        retryMs,
        projectionVersion: SESSION_SEARCH_PROJECTION_VERSION,
      });
      setTimeout(run, retryMs).unref();
    }
  };

  setTimeout(run, 1_000).unref();
}
