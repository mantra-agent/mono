import { db } from "../db";
import { memoryEntries, type MemoryEntry } from "@shared/schema";
import { eq, or, and, desc, sql } from "drizzle-orm";
import { createLogger } from "../log";
import { generateId } from "../file-storage/utils";
import { memoryStorage, memoryEntryLightColumns, wrapLightEntry } from "./memory-storage";
import { generateEmbedding, isEmbeddingsAvailable } from "./embedding";
import { cosineSimilarity } from "./graph-walker";
import { isSimilarText } from "../utils/text-similarity";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";

const log = createLogger("MemoryBeliefStorage");

const memoryScopeColumns = {
  scope: memoryEntries.scope,
  ownerUserId: memoryEntries.ownerUserId,
  accountId: memoryEntries.accountId,
  vaultId: memoryEntries.vaultId,
};

export interface BeliefEvidence {
  type: "memory" | "strategy" | "observation";
  id: string;
  summary: string;
}

export interface Belief {
  id: string;
  claim: string;
  domain: string;
  confidence: number;
  evidence: BeliefEvidence[];
  status: "active" | "uncertain" | "invalidated";
  principleRef: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

const BELIEF_LAYER = "long" as const;
const BELIEF_SOURCE = "belief" as const;

function entryToBelief(entry: MemoryEntry): Belief {
  const meta = (entry.metadata || {}) as Record<string, unknown>;
  const validStatuses = new Set(["active", "uncertain", "invalidated"]);
  const rawStatus = String(meta.status || "active");
  const status = validStatuses.has(rawStatus) ? rawStatus : "active";
  return {
    id: entry.sourceId || String(entry.id),
    claim: entry.content || "",
    domain: String(meta.domain || ""),
    confidence: Number(meta.confidence ?? 0.5),
    evidence: (meta.evidence as BeliefEvidence[]) || [],
    status: status as Belief["status"],
    principleRef: String(meta.principleRef || ""),
    tags: ((entry.tags || []) as string[]).filter(t => t !== "belief"),
    createdAt: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : String(entry.createdAt),
    updatedAt: entry.processedAt
      ? (entry.processedAt instanceof Date ? entry.processedAt.toISOString() : String(entry.processedAt))
      : (entry.createdAt instanceof Date ? entry.createdAt.toISOString() : String(entry.createdAt)),
  };
}

export class MemoryBeliefStorage {
  async getAll(): Promise<Belief[]> {
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(getCurrentPrincipalOrSystem(), memoryScopeColumns,
          eq(memoryEntries.layer, BELIEF_LAYER),
          eq(memoryEntries.source, BELIEF_SOURCE)
        )
      )
      .orderBy(desc(memoryEntries.processedAt));

    const beliefs = rows.map(r => entryToBelief(wrapLightEntry(r as Omit<MemoryEntry, "embedding">)));
    log.debug(`getAll count=${beliefs.length}`);
    return beliefs;
  }

  async getEmbeddingRows(): Promise<MemoryEntry[]> {
    // Intentional SELECT * — embedding column required for cosine similarity dedup
    return db
      .select()
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(getCurrentPrincipalOrSystem(), memoryScopeColumns,
          eq(memoryEntries.layer, BELIEF_LAYER),
          eq(memoryEntries.source, BELIEF_SOURCE),
          sql`embedding IS NOT NULL`
        )
      );
  }

  async getById(id: string): Promise<Belief | null> {
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(getCurrentPrincipalOrSystem(), memoryScopeColumns,
          eq(memoryEntries.layer, BELIEF_LAYER),
          eq(memoryEntries.source, BELIEF_SOURCE),
          eq(memoryEntries.sourceId, id)
        )
      )
      .limit(1);

    if (rows.length === 0) {
      log.debug(`getById not-found id=${id}`);
      return null;
    }
    log.debug(`getById found id=${id}`);
    return entryToBelief(wrapLightEntry(rows[0] as Omit<MemoryEntry, "embedding">));
  }

  async create(input: {
    claim: string;
    domain: string;
    confidence?: number;
    evidence?: BeliefEvidence[];
    status?: Belief["status"];
    principleRef?: string;
    tags?: string[];
    title?: string;
    summary?: string;
  }): Promise<Belief> {
    const now = new Date();
    const beliefId = generateId();
    const confidence = input.confidence ?? 0.5;
    const status = input.status || "active";
    const decayRate = confidence > 0.9 ? 0.001 : 0.005;
    const tags = ["belief", ...(input.tags || [])];

    const metadata: Record<string, unknown> = {
      domain: input.domain,
      confidence,
      status,
      evidence: input.evidence || [],
      principleRef: input.principleRef || "",
      decay_rate: decayRate,
      decay_score: 1.0,
    };

    const [entry] = await db
      .insert(memoryEntries)
      .values({
        layer: BELIEF_LAYER,
        content: input.claim,
        source: BELIEF_SOURCE,
        sourceId: beliefId,
        title: input.title || null,
        summary: input.summary || undefined,
        metadata,
        tags,
        processedAt: now,
        ...ownedInsertValues(getCurrentPrincipalOrSystem(), memoryScopeColumns),
      })
      .returning();

    await memoryStorage.appendEvent(entry.id, "created", { source: BELIEF_SOURCE, layer: BELIEF_LAYER });

    log.debug(`create id=${beliefId} domain=${input.domain} status=${status}`);
    return entryToBelief(entry);
  }

  async update(id: string, updates: Partial<Omit<Belief, "id" | "createdAt">>): Promise<Belief | null> {
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(getCurrentPrincipalOrSystem(), memoryScopeColumns,
          eq(memoryEntries.layer, BELIEF_LAYER),
          eq(memoryEntries.source, BELIEF_SOURCE),
          eq(memoryEntries.sourceId, id)
        )
      )
      .limit(1);

    if (rows.length === 0) {
      log.debug(`update not-found id=${id}`);
      return null;
    }

    const existing = wrapLightEntry(rows[0] as Omit<MemoryEntry, "embedding">);
    const meta = { ...(existing.metadata as Record<string, unknown>) };

    if (updates.claim !== undefined) {
      meta.claim = updates.claim;
    }
    if (updates.domain !== undefined) meta.domain = updates.domain;
    if (updates.confidence !== undefined) {
      meta.confidence = updates.confidence;
      meta.decay_rate = updates.confidence > 0.9 ? 0.001 : 0.005;
    }
    if (updates.status !== undefined) {
      meta.status = updates.status;
    }
    if (updates.evidence !== undefined) meta.evidence = updates.evidence;
    if (updates.principleRef !== undefined) meta.principleRef = updates.principleRef;

    const setData: Record<string, unknown> = {
      metadata: meta,
      processedAt: new Date(),
    };

    if (updates.claim !== undefined) {
      setData.content = updates.claim;
      setData.title = null;
      setData.contentHash = null;
      setData.summary = null;
      setData.embedding = null;
    }

    if (updates.tags !== undefined) {
      setData.tags = ["belief", ...updates.tags.filter(t => t !== "belief")];
    }

    const [updated] = await db
      .update(memoryEntries)
      .set(setData)
      .where(combineWithWritableScope(getCurrentPrincipalOrSystem(), memoryScopeColumns,
        eq(memoryEntries.id, existing.id)
      ))
      .returning();

    await memoryStorage.appendEvent(updated.id, "updated", { source: BELIEF_SOURCE, fields: Object.keys(updates) });

    log.debug(`update id=${id} fields=${Object.keys(updates).join(",")}`);
    return entryToBelief(updated);
  }

  async updateConfidence(id: string, confidence: number): Promise<Belief | null> {
    log.debug(`updateConfidence id=${id} confidence=${confidence}`);
    return this.update(id, { confidence });
  }

  async updateStatus(id: string, status: Belief["status"]): Promise<Belief | null> {
    log.debug(`updateStatus id=${id} status=${status}`);
    return this.update(id, { status });
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(memoryEntries)
      .where(
        combineWithWritableScope(getCurrentPrincipalOrSystem(), memoryScopeColumns,
          eq(memoryEntries.layer, BELIEF_LAYER),
          eq(memoryEntries.source, BELIEF_SOURCE),
          eq(memoryEntries.sourceId, id)
        )
      )
      .returning();

    if (result.length === 0) {
      log.debug(`delete not-found id=${id}`);
      return false;
    }

    log.debug(`delete id=${id}`);
    return true;
  }

  async findDuplicate(
    claim: string,
    cachedBeliefs?: Belief[],
    cachedEmbeddingRows?: MemoryEntry[],
  ): Promise<{ belief: Belief; method: "embedding" | "text" } | null> {
    const existingBeliefs = cachedBeliefs ?? await this.getAll();
    if (existingBeliefs.length === 0) return null;

    if (isEmbeddingsAvailable()) {
      try {
        const claimEmbedding = await generateEmbedding(claim);
        if (claimEmbedding && claimEmbedding.length > 0) {
          // Intentional SELECT * — embedding column required for cosine similarity dedup
          const beliefRows = cachedEmbeddingRows ?? await db
            .select()
            .from(memoryEntries)
            .where(
              combineWithVisibleScope(getCurrentPrincipalOrSystem(), memoryScopeColumns,
                eq(memoryEntries.layer, BELIEF_LAYER),
                eq(memoryEntries.source, BELIEF_SOURCE),
                sql`embedding IS NOT NULL`
              )
            );

          for (let i = 0; i < beliefRows.length; i++) {
            if (i > 0 && i % 100 === 0) {
              await new Promise(resolve => setImmediate(resolve));
            }
            const row = beliefRows[i];
            const rowEmbedding = row.embedding as number[] | null;
            if (rowEmbedding) {
              const sim = cosineSimilarity(claimEmbedding, rowEmbedding);
              if (sim > 0.85) {
                return { belief: entryToBelief(row), method: "embedding" };
              }
            }
          }
        }
      } catch (err) {
        log.warn(`Embedding-based dedup failed, falling back to text: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const textDup = existingBeliefs.find(b => isSimilarText(b.claim, claim));
    if (textDup) {
      return { belief: textDup, method: "text" };
    }

    return null;
  }

  async recordRecall(beliefId: string): Promise<void> {
    try {
      const rows = await db
        .select({ id: memoryEntries.id })
        .from(memoryEntries)
        .where(
          combineWithVisibleScope(getCurrentPrincipalOrSystem(), memoryScopeColumns,
            eq(memoryEntries.layer, BELIEF_LAYER),
            eq(memoryEntries.source, BELIEF_SOURCE),
            eq(memoryEntries.sourceId, beliefId)
          )
        )
        .limit(1);

      if (rows.length > 0) {
        await memoryStorage.appendEvent(rows[0].id, "recalled", { source: BELIEF_SOURCE });
      }
    } catch (err) {
      log.warn(`recordRecall failed for beliefId=${beliefId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const memoryBeliefStorage = new MemoryBeliefStorage();

export async function backfillBeliefTitles(): Promise<{ updated: number; skipped: number; errors: string[] }> {
  return backfillLongTitles();
}

export async function backfillLongTitles(options?: { batchDelayMs?: number }): Promise<{ updated: number; skipped: number; errors: string[] }> {
  const WORD_COUNT_THRESHOLD = 5;
  const BATCH_DELAY_MS = options?.batchDelayMs ?? 500;
  const result = { updated: 0, skipped: 0, errors: [] as string[] };

  const BATCH = 50;
  let lastId = 0;
  let hasMore = true;
  let batchNumber = 0;

  while (hasMore) {
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        and(
          or(eq(memoryEntries.layer, "mid"), eq(memoryEntries.layer, "long")),
          sql`COALESCE(${memoryEntries.title}, '') != ''`,
          sql`${memoryEntries.id} > ${lastId}`
        )
      )
      .orderBy(memoryEntries.id)
      .limit(BATCH);

    if (rows.length === 0) break;
    if (rows.length < BATCH) hasMore = false;
    const wrappedRows = rows.map(r => wrapLightEntry(r as Omit<MemoryEntry, "embedding">));
    lastId = wrappedRows[wrappedRows.length - 1].id;
    batchNumber++;

    let batchUpdated = 0;
    for (const row of wrappedRows) {
      const title = (row.title || "").trim();
      const wordCount = title.split(/\s+/).filter(Boolean).length;
      if (wordCount <= WORD_COUNT_THRESHOLD) {
        result.skipped++;
        continue;
      }

      try {
        await db
          .update(memoryEntries)
          .set({
            title: null,
            contentHash: null,
            processedAt: new Date(),
          })
          .where(eq(memoryEntries.id, row.id));

        result.updated++;
        batchUpdated++;
      } catch (err) {
        const msg = `Entry #${row.id}: ${err instanceof Error ? err.message : String(err)}`;
        result.errors.push(msg);
        log.error(`backfillLongTitles error: ${msg}`);
      }
    }

    if (batchUpdated > 0) {
      log.debug(`backfillLongTitles batch #${batchNumber}: nulled ${batchUpdated} titles (running total: ${result.updated} updated, ${result.skipped} skipped)`);
    }

    if (hasMore && BATCH_DELAY_MS > 0) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  log.debug(`backfillLongTitles complete: updated=${result.updated} skipped=${result.skipped} errors=${result.errors.length}`);
  return result;
}

export async function logMemoryDiagnostics(): Promise<void> {
  try {
    const layerCounts = await db
      .select({
        layer: memoryEntries.layer,
        count: sql<number>`count(*)::int`,
      })
      .from(memoryEntries)
      .groupBy(memoryEntries.layer);

    const sourceCounts = await db
      .select({
        source: memoryEntries.source,
        count: sql<number>`count(*)::int`,
      })
      .from(memoryEntries)
      .groupBy(memoryEntries.source)
      .orderBy(sql`count(*) desc`)
      .limit(10);

    const total = layerCounts.reduce((sum, r) => sum + r.count, 0);
    const layerSummary = layerCounts.map(r => `${r.layer}=${r.count}`).join(", ");
    const sourceSummary = sourceCounts.map(r => `${r.source ?? "null"}=${r.count}`).join(", ");

    log.debug(`[diagnostics] Memory entries total=${total} | by layer: ${layerSummary} | top sources: ${sourceSummary}`);
  } catch (err) {
    log.error(`[diagnostics] Failed to query memory counts: ${err instanceof Error ? err.message : String(err)}`);
  }
}
