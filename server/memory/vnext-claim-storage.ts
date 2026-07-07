import { createHash } from "crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope, ownedInsertValues } from "../scoped-storage";
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
import type { ClaimCandidate } from "./memory-enrichment";

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
  sourceMemoryId: number;
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
  sourceMemoryId: number;
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

function vectorLiteral(embedding: number[]): string {
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

    const metadata = {
      ...(input.metadata ?? {}),
      extractedFrom: input.sourceMemoryId,
      schema: "memory_vnext_claim",
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
        content: input.claim.content,
        claimType: normalizeClaimType(input.claim.claimType),
        confidence: input.claim.confidence,
        topics: input.claim.topics ?? [],
        entityMentions: input.claim.entityMentions ?? [],
        sourceClaimIndex: input.claim.sourceClaimIndex ?? null,
        lifecycleStage: MEMORY_VNEXT_LIFECYCLE_STAGE.EXTRACTED,
        lifecycleStageUpdatedAt: new Date(),
        contentHash,
        embedding: input.embedding,
        sourceMemoryId: input.sourceMemoryId,
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
      .orderBy(memoryVnextClaims.createdAt)
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
      eq(memoryVnextClaims.sourceMemoryId, scope.sourceMemoryId),
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

