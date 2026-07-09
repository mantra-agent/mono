import { createHash } from "crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope, ownedInsertValues, writableScopePredicate } from "../scoped-storage";
import {
  MEMORY_VNEXT_LIFECYCLE_STAGE,
  memoryVnextClaimLinks,
  memoryVnextClaims,
  memoryVnextEntityLinks,
  memoryVnextSourceRefs,
  type MemorySource,
  type MemoryVnextClaim,
  type MemoryVnextClaimType,
  type MemoryVnextLifecycleStage,
  type MemoryVnextSourceRef,
  type MemoryVnextEntityLink,
  type MemoryVnextClaimLink,
} from "@shared/schema";
import type { ClaimCandidate } from "./vnext-claim-extraction";
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, generateEmbedding } from "./embedding";
import { cosineSimilarity } from "./graph-walker";
import { resolveVnextEntityMentions } from "./vnext-entity-resolution";

const log = createLogger("MemoryVnextClaims");

const vnextClaimScopeColumns = {
  scope: memoryVnextClaims.scope,
  ownerUserId: memoryVnextClaims.ownerUserId,
  accountId: memoryVnextClaims.accountId,
};

const vnextSourceScopeColumns = {
  scope: memoryVnextSourceRefs.scope,
  ownerUserId: memoryVnextSourceRefs.ownerUserId,
  accountId: memoryVnextSourceRefs.accountId,
};

const vnextEntityScopeColumns = {
  scope: memoryVnextEntityLinks.scope,
  ownerUserId: memoryVnextEntityLinks.ownerUserId,
  accountId: memoryVnextEntityLinks.accountId,
};

const vnextClaimLinkScopeColumns = {
  scope: memoryVnextClaimLinks.scope,
  ownerUserId: memoryVnextClaimLinks.ownerUserId,
  accountId: memoryVnextClaimLinks.accountId,
};

export interface VnextClaimSourceInput {
  sourceType: string;
  sourceId: string;
  relationship?: string;
  context?: string;
  quote?: string | null;
  spanStart?: number | null;
  spanEnd?: number | null;
  strength?: number;
}

export interface CreateVnextClaimInput {
  claim: ClaimCandidate;
  /** Legacy memory entry ID. Null when claim is not extracted from a memory_entries row. */
  sourceMemoryId?: number | null;
  source: MemorySource;
  sourceId?: string | null;
  createdAt?: Date;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  sourceRefs?: VnextClaimSourceInput[];
  writeBudget?: VnextClaimWriteBudgetInput;
}

export interface VnextExtractionBudgetScope {
  budgetKey: string;
  maxClaims: number;
  source: MemorySource;
  sourceId?: string | null;
  /** Legacy memory entry ID. Null/undefined when not extracted from a memory_entries row. */
  sourceMemoryId?: number | null;
}

export interface VnextClaimWriteBudgetInput {
  budget: VnextExtractionBudgetScope;
  acceptedRank: number;
  candidatesSeen: number;
  candidateIndex: number;
  candidateScore: number;
  candidateReasons: string[];
  existingAcceptedAtStart: number;
}


export interface VnextClaimCounts {
  total: number;
  byLifecycleStage: Record<MemoryVnextLifecycleStage, number>;
  byClaimType: Record<MemoryVnextClaimType, number>;
  sourceRefs: number;
  entityLinks: number;
  claimLinks: number;
}

export interface VnextClaimDetail {
  claim: MemoryVnextClaim;
  sources: MemoryVnextSourceRef[];
  entityLinks: MemoryVnextEntityLink[];
  claimLinks: MemoryVnextClaimLink[];
  lifecycle: {
    stage: string;
    stageUpdatedAt: Date;
    recallCount: number;
    lastRecalledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  };
}

export interface VnextLifecycleCandidate {
  claim: MemoryVnextClaim;
  sourceRefCount: number;
  entityLinkCount: number;
  claimLinkCount: number;
  duplicateCount: number;
}

export interface VnextLifecycleTransitionInput {
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface VnextClaimSearchFilters {
  claimType?: string;
  hasEntityLinks?: boolean;
  entityId?: string;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
  lifecycleStage?: string;
}

/**
 * Similarity threshold for semantic deduplication against existing DB claims.
 * Lowered from 0.9 → 0.85: the original 0.9 let through rephrasings that
 * share 85-90% embedding similarity (observed in near-dup clusters like
 * claim ids 326/327/340). At 384-dim MiniLM embeddings, 0.85 still
 * separates genuinely distinct observations from same-meaning paraphrases.
 */
export const CLAIM_DEDUP_SIMILARITY_THRESHOLD = 0.85;

/**
 * Intra-batch semantic dedup threshold. Applied to candidates within the
 * same persist call before any DB writes. Same-source candidates are almost
 * certainly duplicates at 0.85+, so this matches the cross-source threshold.
 * When a pair merges, the higher-confidence claim survives with unioned
 * topics and entity mentions.
 */
export const CLAIM_INTRA_BATCH_DEDUP_THRESHOLD = 0.85;

const MIN_VNEXT_CLAIMS_PER_SESSION = 1;
const MAX_VNEXT_CLAIMS_PER_SESSION = 3;

function clampVnextClaimCap(value: number): number {
  if (!Number.isFinite(value)) return MAX_VNEXT_CLAIMS_PER_SESSION;
  return Math.max(MIN_VNEXT_CLAIMS_PER_SESSION, Math.min(MAX_VNEXT_CLAIMS_PER_SESSION, Math.floor(value)));
}

function computeContentHash(content: string): string {
  return createHash("sha256").update(content.trim().toLowerCase()).digest("hex");
}

function normalizeClaimType(value: string): MemoryVnextClaimType {
  if (value === "state" || value === "cause" || value === "action") return value;
  return "state";
}

function normalizeLifecycleStage(value: string): MemoryVnextLifecycleStage {
  if (value === "extracted" || value === "sourced" || value === "linked" || value === "canonical" || value === "retired") {
    return value;
  }
  return MEMORY_VNEXT_LIFECYCLE_STAGE.EXTRACTED;
}

function nextLifecycleStage(current: string, candidate: MemoryVnextLifecycleStage): MemoryVnextLifecycleStage {
  const order: Record<MemoryVnextLifecycleStage, number> = {
    extracted: 0,
    sourced: 1,
    linked: 2,
    canonical: 3,
    retired: 4,
  };
  const normalizedCurrent = normalizeLifecycleStage(current);
  return order[candidate] > order[normalizedCurrent] ? candidate : normalizedCurrent;
}

export const MEMORY_VNEXT_EMBEDDING_PROFILE = {
  model: EMBEDDING_MODEL,
  dimensions: EMBEDDING_DIMENSIONS,
} as const;

function validateVnextEmbedding(embedding: number[] | undefined, context: string): number[] | undefined {
  if (!embedding) return undefined;
  if (embedding.length !== MEMORY_VNEXT_EMBEDDING_PROFILE.dimensions) {
    throw new Error(
      `vNext embedding dimension mismatch in ${context}: expected ${MEMORY_VNEXT_EMBEDDING_PROFILE.dimensions} ` +
      `for ${MEMORY_VNEXT_EMBEDDING_PROFILE.model}, got ${embedding.length}`,
    );
  }
  return embedding;
}

function vectorLiteral(embedding: number[]): string {
  validateVnextEmbedding(embedding, "semantic_search");
  return `[${embedding.join(",")}]`;
}

export async function executeVnextClaimSemanticSearch(
  queryEmbedding: number[],
  limit: number,
): Promise<Array<{ row: MemoryVnextClaim; similarity: number }>> {
  const embeddingStr = vectorLiteral(queryEmbedding);
  const principal = getCurrentPrincipalOrSystem();
  const visibilityCondition = principal.actorType === "system"
    ? sql``
    : sql`AND (scope = 'global' OR owner_user_id = ${principal.userId} OR account_id = ${principal.accountId})`;
  const results = await db.execute(sql`
    SELECT id, content, claim_type, confidence, topics, entity_mentions, source_claim_index,
      content_hash, embedding, source_memory_id, source, source_id, lifecycle_stage,
      lifecycle_stage_updated_at, scope, owner_user_id, account_id, created_by_user_id, updated_by_user_id, metadata, recall_count,
      last_recalled_at, created_at, updated_at,
      1 - (embedding <=> ${embeddingStr}::vector) AS similarity
    FROM memory_vnext_claims
    WHERE embedding IS NOT NULL ${visibilityCondition}
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `);
  return (results.rows as unknown as Array<MemoryVnextClaim & { similarity?: string | number }>).map((row) => ({
    row,
    similarity: parseFloat(String(row.similarity ?? "0")),
  }));
}

export class MemoryVnextClaimStorage {
  async createClaim(input: CreateVnextClaimInput): Promise<MemoryVnextClaim> {
    const principal = getCurrentPrincipalOrSystem();
    const contentHash = computeContentHash(input.claim.content);
    const createdAt = input.createdAt ?? new Date();
    const writeBudget = input.writeBudget;
    const normalizedMaxClaims = writeBudget ? clampVnextClaimCap(writeBudget.budget.maxClaims) : null;
    if (writeBudget) {
      if (writeBudget.acceptedRank < 1 || writeBudget.acceptedRank > normalizedMaxClaims!) {
        throw new Error(`vNext claim write rejected: accepted rank ${writeBudget.acceptedRank} exceeds cap ${normalizedMaxClaims}`);
      }
      const hasCapacity = await this.claimExtractionBudgetHasCapacity(writeBudget.budget);
      if (!hasCapacity) {
        throw new Error(`vNext claim write rejected: extraction budget ${writeBudget.budget.budgetKey} is full`);
      }
    }

    const validatedEmbedding = validateVnextEmbedding(input.embedding, "create_claim");

    const metadata = {
      ...(input.metadata ?? {}),
      ...(input.sourceMemoryId ? { extractedFrom: input.sourceMemoryId } : {}),
      schema: "memory_vnext_claim",
      embeddingProfile: MEMORY_VNEXT_EMBEDDING_PROFILE,
      embeddingStatus: validatedEmbedding ? "ready" : "unavailable",
      ...(writeBudget
        ? {
            extractionBudget: {
              budgetKey: writeBudget.budget.budgetKey,
              maxClaims: normalizedMaxClaims,
              candidatesSeen: writeBudget.candidatesSeen,
              acceptedRank: writeBudget.acceptedRank,
              candidateIndex: writeBudget.candidateIndex,
              candidateScore: writeBudget.candidateScore,
              candidateReasons: writeBudget.candidateReasons,
              existingAcceptedAtStart: writeBudget.existingAcceptedAtStart,
            },
          }
        : {}),
    };

    const [claim] = await db
      .insert(memoryVnextClaims)
      .values({
        title: input.claim.title || null,
        content: input.claim.content,
        claimType: normalizeClaimType(input.claim.claimType),
        confidence: input.claim.confidence,
        topics: input.claim.topics ?? [],
        entityMentions: input.claim.entityMentions ?? [],
        sourceClaimIndex: input.claim.sourceClaimIndex ?? null,
        lifecycleStage: MEMORY_VNEXT_LIFECYCLE_STAGE.EXTRACTED,
        lifecycleStageUpdatedAt: new Date(),
        contentHash,
        embedding: validatedEmbedding,
        sourceMemoryId: input.sourceMemoryId ?? null,
        source: input.source,
        sourceId: input.sourceId ?? null,
        metadata,
        ...ownedInsertValues(principal, vnextClaimScopeColumns),
        createdByUserId: principal.userId ?? undefined,
        updatedByUserId: principal.userId ?? undefined,
        createdAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: memoryVnextClaims.contentHash,
        set: {
          title: sql`COALESCE(${memoryVnextClaims.title}, ${input.claim.title || null})`,
          recallCount: sql`${memoryVnextClaims.recallCount} + 1`,
          lastRecalledAt: new Date(),
          updatedAt: new Date(),
          metadata,
        },
      })
      .returning();

    for (const sourceRef of input.sourceRefs ?? []) {
      await this.addSourceRef(claim.id, sourceRef);
    }

    if ((input.sourceRefs ?? []).length > 0) {
      return this.advanceLifecycleStage(claim.id, MEMORY_VNEXT_LIFECYCLE_STAGE.SOURCED);
    }

    return claim;
  }



  /**
   * Permanently delete ALL vNext claims owned by the current principal.
   * Source refs, entity links, and claim links cascade via FK. Fails closed
   * for system principals: an explicit user principal is required so one
   * user's nuke can never touch another user's claims.
   */
  async nukeAllClaims(): Promise<{ deleted: number }> {
    const principal = getCurrentPrincipalOrSystem();
    if (!principal.userId) {
      throw new Error("vNext nuke rejected: a user principal is required");
    }
    const deleted = await db
      .delete(memoryVnextClaims)
      .where(writableScopePredicate(principal, vnextClaimScopeColumns))
      .returning({ id: memoryVnextClaims.id });
    log.info(`nukeAllClaims: deleted ${deleted.length} vNext claims for user ${principal.userId}`);
    return { deleted: deleted.length };
  }

  async listLifecycleCandidates(stages: MemoryVnextLifecycleStage[], limit = 50): Promise<VnextLifecycleCandidate[]> {
    const normalizedStages = stages.map((stage) => normalizeLifecycleStage(stage));
    if (normalizedStages.length === 0) return [];
    const principal = getCurrentPrincipalOrSystem();
    const predicate = combineWithVisibleScope(
      principal,
      vnextClaimScopeColumns,
      inArray(memoryVnextClaims.lifecycleStage, normalizedStages),
    );

    const rows = await db
      .select({
        claim: memoryVnextClaims,
        sourceRefCount: sql<number>`count(DISTINCT ${memoryVnextSourceRefs.id})::int`,
        entityLinkCount: sql<number>`count(DISTINCT ${memoryVnextEntityLinks.id})::int`,
        claimLinkCount: sql<number>`count(DISTINCT ${memoryVnextClaimLinks.id})::int`,
        duplicateCount: sql<number>`(
          SELECT count(*)::int
          FROM memory_vnext_claims duplicates
          WHERE duplicates.content_hash = ${memoryVnextClaims.contentHash}
            AND duplicates.id <> ${memoryVnextClaims.id}
        )`,
      })
      .from(memoryVnextClaims)
      .leftJoin(memoryVnextSourceRefs, eq(memoryVnextSourceRefs.claimId, memoryVnextClaims.id))
      .leftJoin(memoryVnextEntityLinks, eq(memoryVnextEntityLinks.claimId, memoryVnextClaims.id))
      .leftJoin(
        memoryVnextClaimLinks,
        sql`${memoryVnextClaimLinks.fromClaimId} = ${memoryVnextClaims.id} OR ${memoryVnextClaimLinks.toClaimId} = ${memoryVnextClaims.id}`,
      )
      .where(predicate)
      .groupBy(memoryVnextClaims.id)
      .orderBy(
        // Process higher lifecycle stages first so canonical claims get decay/retirement checks
        // before early-stage claims that may be stuck at sourced/linked
        sql`CASE ${memoryVnextClaims.lifecycleStage}
          WHEN 'canonical' THEN 0
          WHEN 'linked' THEN 1
          WHEN 'sourced' THEN 2
          WHEN 'extracted' THEN 3
          ELSE 4
        END`,
        memoryVnextClaims.createdAt,
      )
      .limit(Math.min(Math.max(limit, 1), 200));

    return rows.map((row) => ({
      claim: row.claim,
      sourceRefCount: Number(row.sourceRefCount ?? 0),
      entityLinkCount: Number(row.entityLinkCount ?? 0),
      claimLinkCount: Number(row.claimLinkCount ?? 0),
      duplicateCount: Number(row.duplicateCount ?? 0),
    }));
  }

  async getLifecycleEvidence(claimId: number): Promise<Omit<VnextLifecycleCandidate, "claim"> | null> {
    const [row] = await db
      .select({
        sourceRefCount: sql<number>`count(DISTINCT ${memoryVnextSourceRefs.id})::int`,
        entityLinkCount: sql<number>`count(DISTINCT ${memoryVnextEntityLinks.id})::int`,
        claimLinkCount: sql<number>`count(DISTINCT ${memoryVnextClaimLinks.id})::int`,
        duplicateCount: sql<number>`(
          SELECT count(*)::int
          FROM memory_vnext_claims duplicates
          WHERE duplicates.content_hash = ${memoryVnextClaims.contentHash}
            AND duplicates.id <> ${memoryVnextClaims.id}
        )`,
      })
      .from(memoryVnextClaims)
      .leftJoin(memoryVnextSourceRefs, eq(memoryVnextSourceRefs.claimId, memoryVnextClaims.id))
      .leftJoin(memoryVnextEntityLinks, eq(memoryVnextEntityLinks.claimId, memoryVnextClaims.id))
      .leftJoin(
        memoryVnextClaimLinks,
        sql`${memoryVnextClaimLinks.fromClaimId} = ${memoryVnextClaims.id} OR ${memoryVnextClaimLinks.toClaimId} = ${memoryVnextClaims.id}`,
      )
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), vnextClaimScopeColumns, eq(memoryVnextClaims.id, claimId)))
      .groupBy(memoryVnextClaims.id)
      .limit(1);

    if (!row) return null;
    return {
      sourceRefCount: Number(row.sourceRefCount ?? 0),
      entityLinkCount: Number(row.entityLinkCount ?? 0),
      claimLinkCount: Number(row.claimLinkCount ?? 0),
      duplicateCount: Number(row.duplicateCount ?? 0),
    };
  }

  async findDuplicateClaims(claim: MemoryVnextClaim, limit = 5): Promise<MemoryVnextClaim[]> {
    if (!claim.contentHash) return [];
    return db
      .select()
      .from(memoryVnextClaims)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          vnextClaimScopeColumns,
          and(eq(memoryVnextClaims.contentHash, claim.contentHash), sql`${memoryVnextClaims.id} <> ${claim.id}`),
        ),
      )
      .orderBy(desc(memoryVnextClaims.confidence), desc(memoryVnextClaims.recallCount), desc(memoryVnextClaims.createdAt))
      .limit(Math.min(Math.max(limit, 1), 25));
  }

  async getClaim(id: number): Promise<MemoryVnextClaim | null> {
    const [claim] = await db
      .select()
      .from(memoryVnextClaims)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), vnextClaimScopeColumns, eq(memoryVnextClaims.id, id)))
      .limit(1);
    return claim ?? null;
  }

  async getClaimDetail(id: number): Promise<VnextClaimDetail | null> {
    const claim = await this.getClaim(id);
    if (!claim) return null;
    const [sources, entityLinks, claimLinks] = await Promise.all([
      this.listSourceRefs(id),
      this.listEntityLinks(id),
      this.listClaimLinks(id),
    ]);
    return {
      claim,
      sources,
      entityLinks,
      claimLinks,
      lifecycle: {
        stage: claim.lifecycleStage,
        stageUpdatedAt: claim.lifecycleStageUpdatedAt,
        recallCount: claim.recallCount,
        lastRecalledAt: claim.lastRecalledAt,
        createdAt: claim.createdAt,
        updatedAt: claim.updatedAt,
      },
    };
  }

  async getCounts(): Promise<VnextClaimCounts> {
    const principal = getCurrentPrincipalOrSystem();
    const claimVisibility = combineWithVisibleScope(principal, vnextClaimScopeColumns);
    const sourceVisibility = combineWithVisibleScope(principal, vnextSourceScopeColumns);
    const entityVisibility = combineWithVisibleScope(principal, vnextEntityScopeColumns);
    const claimLinkVisibility = combineWithVisibleScope(principal, vnextClaimLinkScopeColumns);

    const [totalRows, stageRows, typeRows, sourceRows, entityRows, claimLinkRows] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(memoryVnextClaims).where(claimVisibility),
      db.select({ stage: memoryVnextClaims.lifecycleStage, count: sql<number>`count(*)::int` }).from(memoryVnextClaims).where(claimVisibility).groupBy(memoryVnextClaims.lifecycleStage),
      db.select({ claimType: memoryVnextClaims.claimType, count: sql<number>`count(*)::int` }).from(memoryVnextClaims).where(claimVisibility).groupBy(memoryVnextClaims.claimType),
      db.select({ count: sql<number>`count(*)::int` }).from(memoryVnextSourceRefs).where(sourceVisibility),
      db.select({ count: sql<number>`count(*)::int` }).from(memoryVnextEntityLinks).where(entityVisibility),
      db.select({ count: sql<number>`count(*)::int` }).from(memoryVnextClaimLinks).where(claimLinkVisibility),
    ]);

    const byLifecycleStage: Record<MemoryVnextLifecycleStage, number> = { extracted: 0, sourced: 0, linked: 0, canonical: 0, retired: 0 };
    for (const row of stageRows) {
      const stage = normalizeLifecycleStage(String(row.stage));
      byLifecycleStage[stage] = Number(row.count ?? 0);
    }
    const byClaimType: Record<MemoryVnextClaimType, number> = { state: 0, cause: 0, action: 0 };
    for (const row of typeRows) {
      const claimType = normalizeClaimType(String(row.claimType));
      byClaimType[claimType] = Number(row.count ?? 0);
    }

    return {
      total: Number(totalRows[0]?.count ?? 0),
      byLifecycleStage,
      byClaimType,
      sourceRefs: Number(sourceRows[0]?.count ?? 0),
      entityLinks: Number(entityRows[0]?.count ?? 0),
      claimLinks: Number(claimLinkRows[0]?.count ?? 0),
    };
  }

  async listSourceRefs(claimId: number): Promise<MemoryVnextSourceRef[]> {
    return db
      .select()
      .from(memoryVnextSourceRefs)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), vnextSourceScopeColumns, eq(memoryVnextSourceRefs.claimId, claimId)))
      .orderBy(desc(memoryVnextSourceRefs.strength), desc(memoryVnextSourceRefs.createdAt));
  }

  async listEntityLinks(claimId: number): Promise<MemoryVnextEntityLink[]> {
    return db
      .select()
      .from(memoryVnextEntityLinks)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), vnextEntityScopeColumns, eq(memoryVnextEntityLinks.claimId, claimId)))
      .orderBy(desc(memoryVnextEntityLinks.createdAt));
  }

  async listClaimLinks(claimId: number): Promise<MemoryVnextClaimLink[]> {
    return db
      .select()
      .from(memoryVnextClaimLinks)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          vnextClaimLinkScopeColumns,
          sql`(${memoryVnextClaimLinks.fromClaimId} = ${claimId} OR ${memoryVnextClaimLinks.toClaimId} = ${claimId})`,
        ),
      )
      .orderBy(desc(memoryVnextClaimLinks.createdAt));
  }

  async getLifecycleStatus(claimId: number): Promise<VnextClaimDetail["lifecycle"] | null> {
    const claim = await this.getClaim(claimId);
    if (!claim) return null;
    return {
      stage: claim.lifecycleStage,
      stageUpdatedAt: claim.lifecycleStageUpdatedAt,
      recallCount: claim.recallCount,
      lastRecalledAt: claim.lastRecalledAt,
      createdAt: claim.createdAt,
      updatedAt: claim.updatedAt,
    };
  }

  async reinforceClaim(id: number): Promise<void> {
    await db
      .update(memoryVnextClaims)
      .set({
        recallCount: sql`${memoryVnextClaims.recallCount} + 1`,
        lastRecalledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(memoryVnextClaims.id, id));
  }

  async advanceLifecycleStage(
    id: number,
    stage: MemoryVnextLifecycleStage,
    input?: VnextLifecycleTransitionInput,
  ): Promise<MemoryVnextClaim> {
    const [current] = await db
      .select()
      .from(memoryVnextClaims)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), vnextClaimScopeColumns, eq(memoryVnextClaims.id, id)))
      .limit(1);

    if (!current) {
      throw new Error(`vNext claim ${id} not found`);
    }

    const targetStage = nextLifecycleStage(current.lifecycleStage, stage);
    if (targetStage === current.lifecycleStage) {
      return current;
    }

    const currentMetadata = (current.metadata as Record<string, unknown> | null) ?? {};
    const now = new Date();
    const transition = {
      from: current.lifecycleStage,
      to: targetStage,
      at: now.toISOString(),
      reason: input?.reason ?? "stage_evidence_present",
    };
    const lifecycleHistory = Array.isArray(currentMetadata.lifecycleHistory)
      ? currentMetadata.lifecycleHistory
      : [];
    const metadata = {
      ...currentMetadata,
      ...(input?.metadata ?? {}),
      lifecycle: {
        ...(typeof currentMetadata.lifecycle === "object" && currentMetadata.lifecycle !== null
          ? currentMetadata.lifecycle as Record<string, unknown>
          : {}),
        lastTransition: transition,
      },
      lifecycleHistory: [...lifecycleHistory.slice(-9), transition],
    };

    const [updated] = await db
      .update(memoryVnextClaims)
      .set({
        lifecycleStage: targetStage,
        lifecycleStageUpdatedAt: now,
        updatedAt: now,
        metadata,
      })
      .where(eq(memoryVnextClaims.id, id))
      .returning();

    log.info(JSON.stringify({
      event: "memory.vnext.lifecycle_advanced",
      claimId: id,
      from: current.lifecycleStage,
      to: targetStage,
      reason: transition.reason,
    }));
    return updated;
  }

  async retireClaim(id: number, input: VnextLifecycleTransitionInput): Promise<MemoryVnextClaim> {
    const [current] = await db
      .select()
      .from(memoryVnextClaims)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), vnextClaimScopeColumns, eq(memoryVnextClaims.id, id)))
      .limit(1);

    if (!current) {
      throw new Error(`vNext claim ${id} not found`);
    }

    if (current.lifecycleStage === MEMORY_VNEXT_LIFECYCLE_STAGE.RETIRED) {
      return current;
    }

    const now = new Date();
    const currentMetadata = (current.metadata as Record<string, unknown> | null) ?? {};
    const transition = {
      from: current.lifecycleStage,
      to: MEMORY_VNEXT_LIFECYCLE_STAGE.RETIRED,
      at: now.toISOString(),
      reason: input.reason,
    };
    const lifecycleHistory = Array.isArray(currentMetadata.lifecycleHistory)
      ? currentMetadata.lifecycleHistory
      : [];
    const metadata = {
      ...currentMetadata,
      ...(input.metadata ?? {}),
      retired: {
        reason: input.reason,
        at: now.toISOString(),
        ...(input.metadata ?? {}),
      },
      lifecycle: {
        ...(typeof currentMetadata.lifecycle === "object" && currentMetadata.lifecycle !== null
          ? currentMetadata.lifecycle as Record<string, unknown>
          : {}),
        lastTransition: transition,
      },
      lifecycleHistory: [...lifecycleHistory.slice(-9), transition],
    };

    const [updated] = await db
      .update(memoryVnextClaims)
      .set({
        lifecycleStage: MEMORY_VNEXT_LIFECYCLE_STAGE.RETIRED,
        lifecycleStageUpdatedAt: now,
        updatedAt: now,
        metadata,
      })
      .where(eq(memoryVnextClaims.id, id))
      .returning();

    log.info(JSON.stringify({
      event: "memory.vnext.lifecycle_retired",
      claimId: id,
      from: current.lifecycleStage,
      reason: input.reason,
    }));
    return updated;
  }

  async addSourceRef(claimId: number, input: VnextClaimSourceInput): Promise<MemoryVnextSourceRef | null> {
    const principal = getCurrentPrincipalOrSystem();
    const [ref] = await db
      .insert(memoryVnextSourceRefs)
      .values({
        claimId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        relationship: input.relationship ?? "extracted_from",
        context: input.context ?? "",
        quote: input.quote ?? null,
        spanStart: input.spanStart ?? null,
        spanEnd: input.spanEnd ?? null,
        strength: input.strength ?? 1,
        ...ownedInsertValues(principal, vnextSourceScopeColumns),
        createdByUserId: principal.userId ?? undefined,
        updatedByUserId: principal.userId ?? undefined,
      })
      .onConflictDoNothing()
      .returning();
    if (ref) {
      await this.advanceLifecycleStage(claimId, MEMORY_VNEXT_LIFECYCLE_STAGE.SOURCED);
    }
    return ref ?? null;
  }

  async linkClaimToEntity(claimId: number, entityType: string, entityId: string): Promise<void> {
    const principal = getCurrentPrincipalOrSystem();
    await db
      .insert(memoryVnextEntityLinks)
      .values({
        claimId,
        entityType,
        entityId,
        ...ownedInsertValues(principal, vnextEntityScopeColumns),
        createdByUserId: principal.userId ?? undefined,
        updatedByUserId: principal.userId ?? undefined,
      })
      .onConflictDoNothing();
    await this.advanceLifecycleStage(claimId, MEMORY_VNEXT_LIFECYCLE_STAGE.LINKED);
  }

  async linkClaims(fromClaimId: number, toClaimId: number, relationship: string, strength = 0.5): Promise<void> {
    const principal = getCurrentPrincipalOrSystem();
    await db
      .insert(memoryVnextClaimLinks)
      .values({
        fromClaimId,
        toClaimId,
        relationship,
        strength,
        ...ownedInsertValues(principal, vnextClaimLinkScopeColumns),
        createdByUserId: principal.userId ?? undefined,
        updatedByUserId: principal.userId ?? undefined,
      })
      .onConflictDoNothing();
    await this.advanceLifecycleStage(fromClaimId, MEMORY_VNEXT_LIFECYCLE_STAGE.LINKED);
    await this.advanceLifecycleStage(toClaimId, MEMORY_VNEXT_LIFECYCLE_STAGE.LINKED);
  }

  private extractionBudgetPredicate(scope: VnextExtractionBudgetScope) {
    const conditions = [
      scope.sourceMemoryId
        ? eq(memoryVnextClaims.sourceMemoryId, scope.sourceMemoryId)
        : isNull(memoryVnextClaims.sourceMemoryId),
      eq(memoryVnextClaims.source, scope.source),
    ];
    if (scope.sourceId) {
      conditions.push(eq(memoryVnextClaims.sourceId, scope.sourceId));
    }
    conditions.push(sql`${memoryVnextClaims.metadata}->'extractionBudget'->>'budgetKey' = ${scope.budgetKey}`);

    return and(...conditions);
  }

  async countClaimsForExtractionBudget(scope: VnextExtractionBudgetScope): Promise<number> {
    const predicate = this.extractionBudgetPredicate(scope);
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(memoryVnextClaims)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), vnextClaimScopeColumns, predicate));
    return Number(row?.count ?? 0);
  }

  async claimExtractionBudgetHasCapacity(scope: VnextExtractionBudgetScope): Promise<boolean> {
    const maxClaims = clampVnextClaimCap(scope.maxClaims);
    const predicate = and(
      this.extractionBudgetPredicate(scope),
      sql`(${memoryVnextClaims.metadata}->'extractionBudget'->>'acceptedRank')::int <= ${maxClaims}`,
    );
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(memoryVnextClaims)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), vnextClaimScopeColumns, predicate));
    return Number(countRow?.count ?? 0) < maxClaims;
  }

  /**
   * Find all claims originally extracted from a specific source.
   * Used by the reconciliation loop to identify claims that may
   * need decay if they are not re-extracted from an edited source.
   */
  async findClaimsBySourceOrigin(
    source: string,
    sourceId: string,
  ): Promise<MemoryVnextClaim[]> {
    const principal = getCurrentPrincipalOrSystem();
    return db
      .select()
      .from(memoryVnextClaims)
      .where(
        combineWithVisibleScope(
          principal,
          vnextClaimScopeColumns,
          and(
            eq(memoryVnextClaims.source, source),
            eq(memoryVnextClaims.sourceId, sourceId),
            sql`${memoryVnextClaims.lifecycleStage} <> ${MEMORY_VNEXT_LIFECYCLE_STAGE.RETIRED}`,
          ),
        ),
      )
      .orderBy(desc(memoryVnextClaims.createdAt));
  }

  /**
   * Decay a claim's confidence by a delta (min 0.1).
   * Returns the updated claim. Used by the reconciliation loop
   * when a previously-extracted claim is not re-produced.
   */
  async decayClaimConfidence(
    id: number,
    delta: number,
  ): Promise<MemoryVnextClaim | null> {
    const minConfidence = 0.1;
    const [updated] = await db
      .update(memoryVnextClaims)
      .set({
        confidence: sql`GREATEST(${minConfidence}, ${memoryVnextClaims.confidence} - ${delta})`,
        updatedAt: new Date(),
        metadata: sql`jsonb_set(
          COALESCE(${memoryVnextClaims.metadata}, '{}'),
          '{lastDecayedAt}',
          to_jsonb(now()::text)
        )`,
      })
      .where(eq(memoryVnextClaims.id, id))
      .returning();
    return updated ?? null;
  }

  async searchClaims(filters: VnextClaimSearchFilters): Promise<MemoryVnextClaim[]> {
    const conditions = [];
    if (typeof filters.claimType === "string") {
      conditions.push(eq(memoryVnextClaims.claimType, filters.claimType));
    }
    if (typeof filters.hasEntityLinks === "boolean") {
      conditions.push(filters.hasEntityLinks
        ? sql`EXISTS (SELECT 1 FROM memory_vnext_entity_links mel WHERE mel.claim_id = ${memoryVnextClaims.id})`
        : sql`NOT EXISTS (SELECT 1 FROM memory_vnext_entity_links mel WHERE mel.claim_id = ${memoryVnextClaims.id})`);
    }
    if (typeof filters.entityId === "string") {
      conditions.push(sql`EXISTS (SELECT 1 FROM memory_vnext_entity_links mel WHERE mel.claim_id = ${memoryVnextClaims.id} AND mel.entity_id = ${filters.entityId})`);
    }
    if (typeof filters.lifecycleStage === "string") {
      conditions.push(eq(memoryVnextClaims.lifecycleStage, normalizeLifecycleStage(filters.lifecycleStage)));
    } else {
      // Exclude retired claims from default search unless explicitly requested
      conditions.push(sql`${memoryVnextClaims.lifecycleStage} <> ${MEMORY_VNEXT_LIFECYCLE_STAGE.RETIRED}`);
    }
    if (typeof filters.createdAfter === "string") {
      conditions.push(sql`${memoryVnextClaims.createdAt} > ${filters.createdAfter}::timestamptz`);
    }
    if (typeof filters.createdBefore === "string") {
      conditions.push(sql`${memoryVnextClaims.createdAt} < ${filters.createdBefore}::timestamptz`);
    }

    const lim = typeof filters.limit === "number" ? Math.min(filters.limit, 100) : 20;
    const off = typeof filters.offset === "number" ? filters.offset : 0;
    const predicate = conditions.length > 0 ? and(...conditions) : undefined;
    log.debug(`vNext claim search filters=${JSON.stringify(filters)} limit=${lim} offset=${off}`);

    return db
      .select()
      .from(memoryVnextClaims)
      .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), vnextClaimScopeColumns, predicate))
      .orderBy(desc(memoryVnextClaims.createdAt))
      .limit(lim)
      .offset(off);
  }
}

export const memoryVnextClaimStorage = new MemoryVnextClaimStorage();

// ---------------------------------------------------------------------------
// Canonical claim persistence pipeline
// ---------------------------------------------------------------------------

/**
 * Input for the canonical claim persistence pipeline.
 * Both the source poller and the legacy memory-entry extraction path
 * feed through this single function.
 */
export interface PersistClaimCandidatesInput {
  claims: ClaimCandidate[];
  source: MemorySource;
  sourceId?: string | null;
  /** Legacy memory entry ID. Null when not extracted from a memory_entries row. */
  sourceMemoryId?: number | null;
  /** Source refs to attach to each created claim */
  sourceRefs?: VnextClaimSourceInput[];
  /** Optional per-claim write budget metadata */
  writeBudget?: CreateVnextClaimInput["writeBudget"];
  /** Optional override for createdAt on new claims */
  createdAt?: Date;
  /** Optional additional metadata to merge into each claim */
  metadata?: Record<string, unknown>;
  /** Log prefix for structured logging */
  logPrefix?: string;
}

export interface PersistClaimCandidatesResult {
  created: number;
  reinforced: number;
  skipped: number;
  /** Number of candidates merged during intra-batch semantic dedup */
  mergedInBatch: number;
}

/**
 * Canonical mutation path for creating/reinforcing vNext claims.
 *
 * For each claim candidate:
 * 1. Generate embedding
 * 2. Semantic dedup against existing claims (fail open)
 * 3. If near-duplicate found → reinforce existing claim
 * 4. Otherwise → create new claim via memoryVnextClaimStorage.createClaim
 * 5. Resolve entity mentions and link to claim
 * 6. Create intra-batch causal links between related claims
 *
 * All writes go through memoryVnextClaimStorage.createClaim, which is
 * the single DB insert path for memory_vnext_claims.
 */
export async function persistClaimCandidates(
  input: PersistClaimCandidatesInput,
): Promise<PersistClaimCandidatesResult> {
  const {
    claims,
    source,
    sourceId,
    sourceMemoryId,
    sourceRefs,
    writeBudget,
    createdAt,
    metadata: extraMetadata,
    logPrefix = "persistClaimCandidates",
  } = input;

  let created = 0;
  let reinforced = 0;
  let skipped = 0;
  let mergedInBatch = 0;

  // -----------------------------------------------------------------------
  // Phase 1: Embed all candidates
  // -----------------------------------------------------------------------
  const embeddings: (number[] | null)[] = [];
  for (const claim of claims) {
    try {
      embeddings.push(await generateEmbedding(claim.content));
    } catch (err) {
      log.warn(
        `${logPrefix}: embedding failed for "${claim.content.slice(0, 80)}": ${err instanceof Error ? err.message : String(err)}`,
      );
      embeddings.push(null);
    }
  }

  // -----------------------------------------------------------------------
  // Phase 2: Intra-batch semantic dedup
  // Merge pairs above CLAIM_INTRA_BATCH_DEDUP_THRESHOLD. The higher-confidence
  // claim survives with unioned topics/entities. Merged indices are skipped
  // during the persist loop.
  // -----------------------------------------------------------------------
  const mergedInto = new Map<number, number>(); // mergedIndex → survivorIndex
  for (let i = 0; i < claims.length; i++) {
    if (mergedInto.has(i)) continue;
    const embI = embeddings[i];
    if (!embI) continue;
    for (let j = i + 1; j < claims.length; j++) {
      if (mergedInto.has(j)) continue;
      const embJ = embeddings[j];
      if (!embJ) continue;
      const sim = cosineSimilarity(embI, embJ);
      if (sim >= CLAIM_INTRA_BATCH_DEDUP_THRESHOLD) {
        // Merge j into i (or i into j if j has higher confidence)
        const survivorIdx = claims[i].confidence >= claims[j].confidence ? i : j;
        const mergedIdx = survivorIdx === i ? j : i;
        const survivor = claims[survivorIdx];
        const merged = claims[mergedIdx];

        // Union topics and entity mentions
        const topicSet = new Set([...(survivor.topics ?? []), ...(merged.topics ?? [])]);
        survivor.topics = [...topicSet];
        const existingEntities = new Set(survivor.entityMentions?.map((e) => `${e.entityType}:${e.name}`) ?? []);
        for (const ent of merged.entityMentions ?? []) {
          if (!existingEntities.has(`${ent.entityType}:${ent.name}`)) {
            survivor.entityMentions.push(ent);
          }
        }
        // Take the higher confidence
        survivor.confidence = Math.max(survivor.confidence, merged.confidence);

        mergedInto.set(mergedIdx, survivorIdx);
        mergedInBatch++;
        log.debug(
          `${logPrefix}: intra-batch merge: "${merged.content.slice(0, 50)}" → "${survivor.content.slice(0, 50)}" (similarity=${sim.toFixed(3)}, kept confidence=${survivor.confidence.toFixed(2)})`,
        );
      }
    }
  }

  if (mergedInBatch > 0) {
    log.debug(`${logPrefix}: intra-batch dedup merged ${mergedInBatch} candidate(s)`);
  }

  // Track created claim IDs by original batch index for intra-batch linking
  const createdClaimIds = new Map<number, number>();

  for (let i = 0; i < claims.length; i++) {
    // Skip candidates that were merged into another
    if (mergedInto.has(i)) {
      skipped++;
      continue;
    }

    const claim = claims[i];
    const embedding = embeddings[i];
    try {
      // Semantic dedup against existing vNext claims (fail open)
      let nearDuplicate: { id: number; similarity: number } | undefined;
      if (embedding) {
        try {
          const similar = await executeVnextClaimSemanticSearch(embedding, 3);
          const match = similar.find(
            (s) => s.similarity >= CLAIM_DEDUP_SIMILARITY_THRESHOLD,
          );
          if (match) {
            nearDuplicate = { id: match.row.id, similarity: match.similarity };
          }
        } catch (err) {
          log.warn(
            `${logPrefix}: semantic dedup failed open for "${claim.content.slice(0, 80)}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (nearDuplicate) {
        await memoryVnextClaimStorage.reinforceClaim(nearDuplicate.id);
        log.debug(
          `${logPrefix}: reinforced existing claim #${nearDuplicate.id} (similarity=${nearDuplicate.similarity.toFixed(3)}) for "${claim.content.slice(0, 60)}"`,
        );
        reinforced++;
        continue;
      }

      // Build source refs (default: extracted_from the source)
      const claimSourceRefs: VnextClaimSourceInput[] = sourceRefs?.length
        ? sourceRefs
        : [
            {
              sourceType: sourceMemoryId ? "memory" : "queue",
              sourceId: sourceMemoryId ? String(sourceMemoryId) : (sourceId || "unknown"),
              relationship: "extracted_from",
              context: `Extracted from ${source}`,
              strength: 1,
            },
          ];

      const claimEntry = await memoryVnextClaimStorage.createClaim({
        claim,
        sourceMemoryId,
        source,
        sourceId,
        createdAt,
        embedding: embedding ?? undefined,
        metadata: {
          confidence: claim.confidence,
          claimType: claim.claimType,
          ...(extraMetadata ?? {}),
        },
        sourceRefs: claimSourceRefs,
        writeBudget,
      });

      // Entity linking
      const resolvedEntities = await resolveVnextEntityMentions(claim.entityMentions);
      for (const entity of resolvedEntities) {
        try {
          await memoryVnextClaimStorage.linkClaimToEntity(
            claimEntry.id,
            entity.entityType,
            entity.entityId,
          );
        } catch (entityErr) {
          log.debug(
            `${logPrefix}: entity link failed claim #${claimEntry.id} → ${entity.entityType}:${entity.entityId}: ${entityErr instanceof Error ? entityErr.message : String(entityErr)}`,
          );
        }
      }

      // Intra-batch causal linking
      if (claim.sourceClaimIndex != null && createdClaimIds.has(claim.sourceClaimIndex)) {
        const parentClaimId = createdClaimIds.get(claim.sourceClaimIndex)!;
        try {
          const relationship =
            claim.claimType === "action"
              ? "caused_by"
              : claim.claimType === "state"
                ? "resulted_from"
                : "related_to";
          await memoryVnextClaimStorage.linkClaims(parentClaimId, claimEntry.id, relationship, 0.9);
          log.debug(
            `${logPrefix}: linked claim #${parentClaimId} → #${claimEntry.id} via ${relationship}`,
          );
        } catch (linkErr) {
          log.debug(
            `${logPrefix}: causal link failed #${parentClaimId} → #${claimEntry.id}: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`,
          );
        }
      }

      createdClaimIds.set(i, claimEntry.id);
      created++;
    } catch (err) {
      log.warn(
        `${logPrefix}: failed claim "${claim.content.slice(0, 80)}": ${err instanceof Error ? err.message : String(err)}`,
      );
      skipped++;
    }
  }

  return { created, reinforced, skipped, mergedInBatch };
}

