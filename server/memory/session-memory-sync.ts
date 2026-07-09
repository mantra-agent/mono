import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { MEMORY_INTEGRATION_STAGE, memoryEntries, memorySourceRefs } from "@shared/models/memory";
import type { MemoryEntry } from "@shared/schema";
import {
  computeContentHash,
  memoryEntryLightColumns,
  wrapLightEntry,
} from "./memory-storage";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import { scheduleMemoryLinks } from "./link-scheduling";

const log = createLogger("SessionMemorySync");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const memoryScopeColumns = {
  scope: memoryEntries.scope,
  ownerUserId: memoryEntries.ownerUserId,
  accountId: memoryEntries.accountId,
  vaultId: memoryEntries.vaultId,
};

const memorySourceScopeColumns = {
  scope: memorySourceRefs.scope,
  ownerUserId: memorySourceRefs.ownerUserId,
  accountId: memorySourceRefs.accountId,
};

async function ensureSessionSummarySourceRef(memoryId: number, sourceId: string): Promise<void> {
  const principal = getCurrentPrincipalOrSystem();
  await db
    .insert(memorySourceRefs)
    .values({
      memoryId,
      sourceType: "chat_journal",
      sourceId,
      relationship: "extracted_from",
      context: "Session summary mirror source from legacy memory_entries.source/source_id",
      strength: 1,
      ...ownedInsertValues(principal, memorySourceScopeColumns),
      createdByUserId: principal.userId ?? undefined,
      updatedByUserId: principal.userId ?? undefined,
    })
    .onConflictDoUpdate({
      target: [
        memorySourceRefs.memoryId,
        memorySourceRefs.sourceType,
        memorySourceRefs.sourceId,
        memorySourceRefs.relationship,
      ],
      set: {
        context: "Session summary mirror source from legacy memory_entries.source/source_id",
        strength: 1,
        updatedByUserId: principal.userId ?? undefined,
      },
    });
  log.debug(`[ingest] source_ref_attached source=chat_journal sourceId=${sourceId} memoryEntryId=${memoryId}`);
}

export interface SessionMemoryMirrorInput {
  id: string;
  title?: string | null;
  summary?: string | null;
  status?: string | null;
  sessionType?: string | null;
  type?: string | null;
  archivedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  topics?: string[] | null;
  memoryOneLiner?: string | null;
  memorySummary?: string | null;
  messageCount?: number | null;
  parentSessionId?: string | null;
  spawnReason?: string | null;
  triggerType?: string | null;
  triggerId?: string | null;
  triggerName?: string | null;
}

function summaryContent(session: SessionMemoryMirrorInput): string {
  return (session.summary || "").trim();
}

function summaryTitle(session: SessionMemoryMirrorInput): string | null {
  const title = (session.title || "").trim();
  return title ? title : null;
}

function normalizedSessionTopics(session: SessionMemoryMirrorInput): string[] {
  return [...new Set((session.topics || []).map((topic) => topic.trim()).filter(Boolean))];
}

function hasStageOneSessionFields(session: SessionMemoryMirrorInput, title: string | null): boolean {
  return Boolean(title?.trim() && session.memorySummary?.trim() && normalizedSessionTopics(session).length > 0);
}

/**
 * Upsert a session summary memory entry, converged with the library page pattern.
 * - Content-hash comparison: skip if unchanged
 * - If changed: update in place, reset to layer='short', clear summary/oneLiner/contentHash
 * - If new: create at layer='short'
 * Returns the memory entry ID, or null if no content.
 */
export async function upsertSessionSummaryMemory(
  session: SessionMemoryMirrorInput,
): Promise<number | null> {
  const content = summaryContent(session);
  const sourceId = `session-summary-${session.id}`;
  log.debug(`[ingest] start source=chat_journal sourceId=${sourceId} sessionId=${session.id} contentLength=${content.length}`);
  if (!content) {
    log.debug(`[ingest] skip source=chat_journal sourceId=${sourceId} reason=empty_summary`);
    return null;
  }

  try {
    const principal = getCurrentPrincipalOrSystem();
    const title = summaryTitle(session);
    const sessionTopics = normalizedSessionTopics(session);
    const hasStageOne = hasStageOneSessionFields(session, title);
    const currentHash = computeContentHash(content);
    const stage = hasStageOne ? MEMORY_INTEGRATION_STAGE.ENRICHED : MEMORY_INTEGRATION_STAGE.RAW;
    const memoryTags = sessionTopics.length > 0 ? sessionTopics : ["session-summary"];
    const metadata = {
      sessionId: session.id,
      sessionType: session.sessionType || "user",
      type: session.type || "text",
      status: session.status || null,
      archivedAt: session.archivedAt || null,
      createdAt: session.createdAt || null,
      updatedAt: session.updatedAt || null,
      topics: sessionTopics,
      messageCount: session.messageCount || 0,
      parentSessionId: session.parentSessionId || null,
      spawnReason: session.spawnReason || null,
      triggerType: session.triggerType || null,
      triggerId: session.triggerId || null,
      triggerName: session.triggerName || null,
      mirrorKind: "session_summary",
      sourceOfTruth: "chat_session_history",
    };

    const existingRows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          principal,
          memoryScopeColumns,
          and(
            eq(memoryEntries.source, "chat_journal"),
            eq(memoryEntries.sourceId, sourceId),
          ),
        ),
      )
      .limit(1);

    const existing = existingRows[0]
      ? wrapLightEntry(existingRows[0] as Omit<MemoryEntry, "embedding">)
      : null;

    if (existing) {
      // If we have a stored hash, compare hashes. If we don't have one (legacy / partial state),
      // fall back to direct content compare so we never wipe a good summary on a no-op upsert.
      const contentChanged = existing.contentHash
        ? existing.contentHash !== currentHash
        : existing.content !== content;

      if (contentChanged) {
        // Content changed: reset to short layer/stage, clear derived fields for re-consolidation
        await db
          .update(memoryEntries)
          .set({
            content,
            layer: "short",
            integrationStage: stage,
            title,
            metadata,
            tags: memoryTags,
            oneLiner: hasStageOne ? session.memoryOneLiner || null : null,
            summary: hasStageOne ? session.memorySummary || null : null,
            contentHash: hasStageOne ? currentHash : null,
            processedAt: new Date(),
            updatedByUserId: principal.userId ?? undefined,
          })
          .where(
            combineWithWritableScope(
              principal,
              memoryScopeColumns,
              eq(memoryEntries.id, existing.id),
            ),
          );
        log.info(`[ingest] updated_memory_entry source=chat_journal sourceId=${sourceId} memoryEntryId=${existing.id} layer=short integrationStage=${stage} hashChanged=true topics=${memoryTags.join(",")}`);
        log.debug(`[ingest] integration_stage_set source=chat_journal sourceId=${sourceId} memoryEntryId=${existing.id} stage=${stage}`);
      } else {
        // Content unchanged: only refresh title/metadata; preserve existing summary/oneLiner
        const updates: Record<string, unknown> = {
          metadata,
          tags: memoryTags,
          processedAt: new Date(),
          updatedByUserId: principal.userId ?? undefined,
        };
        if ((existing.title || null) !== title) updates.title = title;
        if (hasStageOne) {
          updates.integrationStage = MEMORY_INTEGRATION_STAGE.ENRICHED;
          updates.oneLiner = session.memoryOneLiner || null;
          updates.summary = session.memorySummary || null;
          updates.contentHash = currentHash;
        }
        await db
          .update(memoryEntries)
          .set(updates)
          .where(
            combineWithWritableScope(
              principal,
              memoryScopeColumns,
              eq(memoryEntries.id, existing.id),
            ),
          );
        log.debug(`[ingest] unchanged_hash source=chat_journal sourceId=${sourceId} memoryEntryId=${existing.id} hash=${existing.contentHash || "legacy_content_compare"} topics=${memoryTags.join(",")}`);
      }

      await ensureSessionSummarySourceRef(existing.id, sourceId);
      scheduleMemoryLinks(existing.id).catch((e) =>
        log.warn(`[ingest] link_schedule_failed source=chat_journal sourceId=${sourceId} memoryEntryId=${existing.id} error=${errorMessage(e)}`),
      );
      return existing.id;
    }

    // No existing entry: create new at layer='short'
    const [entry] = await db
      .insert(memoryEntries)
      .values({
        layer: "short",
        integrationStage: stage,
        source: "chat_journal",
        sourceId,
        title,
        content,
        metadata,
        tags: memoryTags,
        oneLiner: hasStageOne ? session.memoryOneLiner || null : null,
        summary: hasStageOne ? session.memorySummary || null : null,
        contentHash: hasStageOne ? currentHash : null,
        processedAt: new Date(),
        ...ownedInsertValues(principal, memoryScopeColumns),
        createdByUserId: principal.userId ?? undefined,
        updatedByUserId: principal.userId ?? undefined,
      })
      .returning();

    log.info(`[ingest] created_memory_entry source=chat_journal sourceId=${sourceId} memoryEntryId=${entry.id} layer=short integrationStage=${stage} topics=${memoryTags.join(",")}`);
    log.debug(`[ingest] integration_stage_set source=chat_journal sourceId=${sourceId} memoryEntryId=${entry.id} stage=${stage}`);
    await ensureSessionSummarySourceRef(entry.id, sourceId);
    scheduleMemoryLinks(entry.id).catch((e) =>
      log.warn(`[ingest] link_schedule_failed source=chat_journal sourceId=${sourceId} memoryEntryId=${entry.id} error=${errorMessage(e)}`),
    );
    return entry.id;
  } catch (error: unknown) {
    log.error(`[ingest] error source=chat_journal sourceId=${sourceId} sessionId=${session.id} error=${errorMessage(error)}`);
    throw error;
  }
}
