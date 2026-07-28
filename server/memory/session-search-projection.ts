import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  documentStoreDocuments,
  sessionSearchSegments,
  users,
  SESSION_SEARCH_PROJECTION_VERSION,
  SESSION_SEARCH_SEGMENT_INDEX,
  type InsertSessionSearchSegment,
} from "@shared/schema";
import type { SessionAgenda, ToolCallInfo } from "@shared/models/chat";
import {
  ADVISORY_LOCK_NS,
  acquireAdvisoryTransactionLock,
  db,
  runWithDatabaseTransaction,
} from "../db";
import { createLogger } from "../log";
import { createUserPrincipalFromUser } from "../principal";
import { runWithPrincipal } from "../principal-context";

const log = createLogger("SessionSearchProjection");

const CHUNK_CONTENT_CHARS = 3_584;
const CHUNK_OVERLAP_CHARS = 512;
const MAX_SOURCE_CONTENT_CHARS = 64_000;
const MAX_TOOL_CONTENT_CHARS = 16_000;
const MAX_SEGMENTS_PER_SESSION = 600;
const BACKFILL_BATCH_SIZE = 50;
const BACKFILL_LOOKBACK_DAYS = 30;
const BACKFILL_RETRY_MS = 5_000;
const READINESS_CACHE_MS = 30_000;
type SearchableMessage = {
  id: string;
  role: string;
  content?: string | null;
  visibility?: "chat" | "diagnostic";
  toolCalls?: unknown;
};

export type SearchableSession = {
  id: string;
  title: string;
  agenda?: SessionAgenda;
  messages: SearchableMessage[];
};

type ProjectionSegment = Pick<
  InsertSessionSearchSegment,
  "segmentKey" | "segmentKind" | "sourceId" | "ordinal" | "content" | "projectionVersion"
>;

let readinessCache: { ready: boolean; expiresAt: number } | null = null;
let backfillStarted = false;

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

function appendChunks(
  segments: ProjectionSegment[],
  input: {
    kind: ProjectionSegment["segmentKind"];
    sourceId: string;
    text: string;
    maxChars?: number;
  },
): void {
  if (segments.length >= MAX_SEGMENTS_PER_SESSION) return;
  const normalized = input.text.trim().slice(0, input.maxChars ?? MAX_SOURCE_CONTENT_CHARS);
  if (!normalized) return;

  let offset = 0;
  let ordinal = 0;
  while (offset < normalized.length && segments.length < MAX_SEGMENTS_PER_SESSION) {
    const content = normalized.slice(offset, offset + CHUNK_CONTENT_CHARS);
    segments.push({
      segmentKey: `${input.kind}:${input.sourceId}:${ordinal}`,
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
  const sourceId = toolCall.toolCallId || String(index);
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
  appendChunks(segments, { kind: "title", sourceId: "session", text: session.title, maxChars: 1_000 });

  for (const [index, item] of (session.agenda?.items ?? []).entries()) {
    appendChunks(segments, {
      kind: "agenda",
      sourceId: item.id || String(index),
      text: [item.title, item.description, item.resolution].filter(Boolean).join("\n"),
      maxChars: 8_000,
    });
  }

  for (const message of session.messages) {
    if (message.visibility === "diagnostic") continue;
    appendChunks(segments, {
      kind: "message",
      sourceId: message.id,
      text: message.content || "",
    });
    const toolCalls = Array.isArray(message.toolCalls)
      ? (message.toolCalls as ToolCallInfo[])
      : [];
    for (const [index, toolCall] of toolCalls.entries()) {
      if (!toolCall || typeof toolCall !== "object") continue;
      const searchable = toolText(toolCall, index);
      appendChunks(segments, {
        kind: "tool",
        sourceId: `${message.id}:${searchable.sourceId}`,
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
  const segments = buildSessionSearchSegments(session);
  await db
    .delete(sessionSearchSegments)
    .where(eq(sessionSearchSegments.documentStoreId, documentStoreId));
  if (segments.length > 0) {
    await db.insert(sessionSearchSegments).values(
      segments.map((segment) => ({ ...segment, documentStoreId })),
    );
  }
  readinessCache = null;
  return segments.length;
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
      sql`coalesce(${documentStoreDocuments.metadata}->>'updatedAt', ${documentStoreDocuments.updatedAt}::text, ${documentStoreDocuments.createdAt}::text) >= ${cutoff.toISOString()}`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${sessionSearchSegments}
        WHERE ${sessionSearchSegments.documentStoreId} = ${documentStoreDocuments.id}
          AND ${sessionSearchSegments.projectionVersion} = ${SESSION_SEARCH_PROJECTION_VERSION}
      )`,
    ))
    .orderBy(documentStoreDocuments.updatedAt)
    .limit(BACKFILL_BATCH_SIZE) as Promise<BackfillCandidate[]>;
}

async function backfillDocument(candidate: BackfillCandidate): Promise<"projected" | "skipped"> {
  const [owner] = await db
    .select({ user: users })
    .from(users)
    .innerJoin(
      accounts,
      and(
        eq(accounts.id, candidate.accountId),
        eq(accounts.kind, "personal"),
        eq(accounts.ownerUserId, candidate.ownerUserId),
      ),
    )
    .where(eq(users.id, candidate.ownerUserId))
    .limit(1);
  if (!owner?.user) return "skipped";
  const principal = createUserPrincipalFromUser(owner.user, candidate.accountId);

  return runWithPrincipal(principal, () => db.transaction(async (transaction) => runWithDatabaseTransaction(transaction, async () => {
    await acquireAdvisoryTransactionLock(
      transaction,
      ADVISORY_LOCK_NS.CHAT_DOCUMENT,
      candidate.documentId,
    );
    const [document] = await transaction
      .select({ id: documentStoreDocuments.id, content: documentStoreDocuments.content })
      .from(documentStoreDocuments)
      .where(and(
        eq(documentStoreDocuments.id, candidate.id),
        eq(documentStoreDocuments.documentType, "chat"),
      ))
      .limit(1)
      .for("update");
    if (!document) return "skipped";

    const current = await transaction
      .select({ id: sessionSearchSegments.id })
      .from(sessionSearchSegments)
      .where(and(
        eq(sessionSearchSegments.documentStoreId, document.id),
        eq(sessionSearchSegments.projectionVersion, SESSION_SEARCH_PROJECTION_VERSION),
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
    await replaceSessionSearchProjection(document.id, session);
    return "projected";
  })));
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
    try {
      const complete = await runBackfillBatch();
      readinessCache = null;
      if (complete && await isSessionSearchProjectionReady()) {
        log.info("session search projection backfill ready", {
          projectionVersion: SESSION_SEARCH_PROJECTION_VERSION,
          lookbackDays: BACKFILL_LOOKBACK_DAYS,
        });
        return;
      }
    } catch (error) {
      log.error("session search projection backfill failed", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
    setTimeout(run, BACKFILL_RETRY_MS).unref();
  };

  setTimeout(run, 1_000).unref();
}
