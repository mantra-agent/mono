import type { Express, Request, Response } from "express";
import { z } from "zod";
import { and, eq, or, inArray, sql, desc } from "drizzle-orm";
import {
  MEMORY_VNEXT_LIFECYCLE_STAGE,
  driveResources,
  memoryVnextClaims,
  memoryVnextEntityLinks,
  memoryVnextClaimLinks,
  memoryVnextSourceRefs,
  type MemoryVnextClaim,
  type MemoryVnextSourceRef,
  type MemoryVnextEntityLink,
  type MemoryVnextClaimLink,
  type MemoryVnextSourceQueueRow,
  type Goal,
} from "@shared/schema";
import { eventBus } from "../event-bus";
import { db } from "../db";
import { createLogger } from "../log";
import { searchVnextMemory } from "./vnext-search";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { requireCurrentPrincipal } from "../principal-context";
import { getPrincipal } from "../principal";
import { combineWithVisibleScope } from "../scoped-storage";
import { getSetting, setSetting } from "../system-settings";
import { memoryVnextClaimStorage } from "./vnext-claim-storage";
import type { VnextClaimDimensions } from "./vnext-claim-dimensions";
import { runVnextLifecycle } from "./vnext-lifecycle";
import { listVisibleSources } from "./vnext-source-queue";
import { peopleStorage } from "../people-storage";
import { companyStorage } from "../company-storage";
import { goalsService } from "../goals-service";
import { fileProjectStorage } from "../file-storage/projects";
import { libraryPages } from "@shared/models/info";
import { chatFileStorage } from "../chat-file-storage";
import { listMeetingGraphRecords, type MeetingIndexRecord } from "../meetings/meeting-index";
import { getLibraryAuthoredOccurrences, getLibraryReferenceNeighborhood, scheduleLibraryReferenceReplay } from "../library-reference-index";
import { normalizeProtocolAddress } from "@shared/life-addressing";
import {
  liveObjectGrantPredicate,
  liveVaultGatePredicate,
  objectGrantIdentity,
} from "../authorize";
import { assemblePersonalGraph, libraryFirstGraphEnabled } from "./personal-graph-projection";
import {
  isAcceptedMemoryGraphSettingsSnapshot,
  normalizeMemoryGraphSettings,
} from "@shared/memory-graph-settings";

const log = createLogger("MemoryRoutes");
const MEMORY_GRAPH_SETTINGS_KEY = "memory_graph_settings";

function memoryGraphSettingsKey(userId: string): string {
  return `user:${userId}:${MEMORY_GRAPH_SETTINGS_KEY}`;
}


function serializeDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function serializeVnextClaim(claim: MemoryVnextClaim) {
  return {
    id: claim.id,
    storage: "memory_vnext_claims",
    title: claim.title,
    content: claim.content,
    claimType: claim.claimType,
    confidence: claim.confidence,
    extractionConfidence: claim.confidence,
    observedAt: serializeDate(claim.observedAt),
    validFrom: serializeDate(claim.validFrom),
    validUntil: serializeDate(claim.validUntil),
    occurredAt: serializeDate(claim.occurredAt),
    expectedBy: serializeDate(claim.expectedBy),
    topics: claim.topics ?? [],
    entityMentions: claim.entityMentions ?? [],
    sourceClaimIndex: claim.sourceClaimIndex,
    sourceMemoryId: claim.sourceMemoryId,
    source: claim.source,
    sourceId: claim.sourceId,
    lifecycleStage: claim.lifecycleStage,
    lifecycleStageUpdatedAt: serializeDate(claim.lifecycleStageUpdatedAt),
    metadata: claim.metadata ?? {},
    recallCount: claim.recallCount,
    lastRecalledAt: serializeDate(claim.lastRecalledAt),
    activeTouchedAt: serializeDate(claim.activeTouchedAt),
    createdAt: serializeDate(claim.createdAt),
    updatedAt: serializeDate(claim.updatedAt),
  };
}

function serializeVnextSourceRef(ref: MemoryVnextSourceRef) {
  return {
    id: ref.id, claimId: ref.claimId, sourceType: ref.sourceType, sourceId: ref.sourceId,
    relationship: ref.relationship, context: ref.context, quote: ref.quote, spanStart: ref.spanStart,
    spanEnd: ref.spanEnd, strength: ref.strength, clarity: ref.clarity, certainty: ref.certainty,
    sourceObservedAt: serializeDate(ref.sourceObservedAt), sourceLineageKey: ref.sourceLineageKey,
    independence: ref.independence, producerMethod: ref.producerMethod,
    derivationVersion: ref.derivationVersion, provenance: ref.provenance,
    createdAt: serializeDate(ref.createdAt),
  };
}

function serializeVnextSourceQueueRow(row: MemoryVnextSourceQueueRow) {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    status: row.status,
    lastModifiedAt: serializeDate(row.lastModifiedAt),
    lastExtractedAt: serializeDate(row.lastExtractedAt),
    contentHash: row.contentHash,
    ownerUserId: row.ownerUserId,
    accountId: row.accountId,
    createdAt: serializeDate(row.createdAt),
  };
}

function serializeVnextEntityLink(link: MemoryVnextEntityLink) {
  return { id: link.id, claimId: link.claimId, entityType: link.entityType, entityId: link.entityId, createdAt: serializeDate(link.createdAt) };
}

function serializeVnextClaimLink(link: MemoryVnextClaimLink) {
  return {
    id: link.id, fromClaimId: link.fromClaimId, toClaimId: link.toClaimId,
    relationship: link.relationship, relationshipClass: link.relationshipClass,
    producerKind: link.producerKind, epistemicStatus: link.epistemicStatus,
    edgeKey: link.edgeKey, strength: link.strength, certainty: link.certainty,
    producerMethod: link.producerMethod, derivationVersion: link.derivationVersion,
    provenance: link.provenance, createdAt: serializeDate(link.createdAt),
  };
}

function serializeTransitionPathDetail(detail: import("./vnext-transition-graph").VnextTransitionPathDetail) {
  return {
    path: {
      ...detail.path,
      createdAt: serializeDate(detail.path.createdAt),
      updatedAt: serializeDate(detail.path.updatedAt),
    },
    members: detail.members.map((member) => ({
      ...member,
      createdAt: serializeDate(member.createdAt),
      claim: serializeVnextClaim(member.claim),
    })),
    edges: detail.edges.map((edge) => ({
      ...edge,
      createdAt: serializeDate(edge.createdAt),
      claimLink: serializeVnextClaimLink(edge.claimLink),
      evidence: edge.evidence.map((item) => ({ ...item, createdAt: serializeDate(item.createdAt) })),
    })),
  };
}

function serializePredictionDetail(detail: import("./vnext-prediction-ledger").PredictionLedgerDetail) {
  return {
    prediction: {
      ...detail.prediction,
      expectedAt: serializeDate(detail.prediction.expectedAt),
      generatedAt: serializeDate(detail.prediction.generatedAt),
      createdAt: serializeDate(detail.prediction.createdAt),
    },
    resolutions: detail.resolutions.map((resolution) => ({
      ...resolution,
      resolvedAt: serializeDate(resolution.resolvedAt),
      createdAt: serializeDate(resolution.createdAt),
    })),
    certaintyEvents: detail.certaintyEvents.map((event) => ({
      ...event,
      occurredAt: serializeDate(event.occurredAt),
      createdAt: serializeDate(event.createdAt),
    })),
  };
}

function serializeVnextDimensions(dimensions: VnextClaimDimensions) {
  return {
    ...dimensions,
    strength: {
      ...dimensions.strength,
      latestEventAt: serializeDate(dimensions.strength.latestEventAt),
      recentEvidence: dimensions.strength.recentEvidence.map((event) => ({
        ...event,
        occurredAt: serializeDate(event.occurredAt),
      })),
    },
    sourceClarity: {
      ...dimensions.sourceClarity,
      evidence: dimensions.sourceClarity.evidence.map((evidence) => ({
        ...evidence,
        sourceObservedAt: serializeDate(evidence.sourceObservedAt),
      })),
    },
    temporalApplicability: {
      ...dimensions.temporalApplicability,
      evaluatedAt: serializeDate(dimensions.temporalApplicability.evaluatedAt),
      observedAt: serializeDate(dimensions.temporalApplicability.observedAt),
      validFrom: serializeDate(dimensions.temporalApplicability.validFrom),
      validUntil: serializeDate(dimensions.temporalApplicability.validUntil),
      occurredAt: serializeDate(dimensions.temporalApplicability.occurredAt),
      expectedBy: serializeDate(dimensions.temporalApplicability.expectedBy),
    },
  };
}


function parsePositiveInt(value: unknown): number | null {
  const parsed = typeof value === "string" ? parseInt(value, 10) : typeof value === "number" ? value : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}


const searchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(20),
  source: z.string().optional(),
  claimType: z.string().optional(),
  lifecycleStage: z.string().optional(),
});

const triggerVnextLifecycleSchema = z.object({
  limit: z.number().int().positive().max(200).optional(),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function handleSearchVnextMemory(req: Request, res: Response): Promise<void> {
  try {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      return;
    }

    const { query, limit, source, claimType, lifecycleStage } = parsed.data;
    const response = await searchVnextMemory({ query, limit, source, claimType, lifecycleStage });
    res.json({
      storage: response.storage,
      total: response.total,
      results: response.results.map(({ claim, score, embeddingSimilarity, lexicalSimilarity, textMatch, linkCount, retrievalPath }) => ({
        ...serializeVnextClaim(claim),
        score,
        embeddingSimilarity,
        lexicalSimilarity,
        textMatch,
        linkCount,
        retrievalPath,
      })),
    });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}


interface VnextGraphNode {
  id: number;
  content: string;
  title?: string;
  summary?: string;
  layer: "long";
  source: string;
  sourceId?: string;
  tags?: string[];
  graphed: true;
  metadata: Record<string, unknown>;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** Derived active recency heat in [0, 1], using authoritative timestamps for the node kind. */
  recency: number;
}

interface VnextGraphLink {
  id: number;
  fromId: number;
  toId: number;
  relationship: string;
  strength: number;
  createdAt?: string | null;
  relationshipType: string;
}

const RECENCY_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const GRAPH_RELATION_BATCH_SIZE = 500;
const GRAPH_ENTITY_READ_BATCH_SIZE = 10;

function chunkValues<T>(values: T[], batchSize = GRAPH_RELATION_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    chunks.push(values.slice(index, index + batchSize));
  }
  return chunks;
}

/**
 * Recency heat for a graph node from its authoritative active timestamps.
 * Missing timestamps are cold rather than silently fresh.
 */
function computeNodeRecency(
  ...timestamps: Array<Date | string | null | undefined>
): number {
  const mostRecentMs = timestamps.reduce((latest, timestamp) => {
    if (!timestamp) return latest;
    const candidate = new Date(timestamp).getTime();
    return Number.isFinite(candidate) ? Math.max(latest, candidate) : latest;
  }, 0);
  if (mostRecentMs <= 0) return 0;
  const daysSince = Math.max(0, (Date.now() - mostRecentMs) / MS_PER_DAY);
  return Math.pow(2, -daysSince / RECENCY_HALF_LIFE_DAYS);
}

function maxTimestamp(
  ...timestamps: Array<Date | string | null | undefined>
): Date | null {
  const latestMs = timestamps.reduce((latest, timestamp) => {
    if (!timestamp) return latest;
    const candidate = new Date(timestamp).getTime();
    return Number.isFinite(candidate) ? Math.max(latest, candidate) : latest;
  }, 0);
  return latestMs > 0 ? new Date(latestMs) : null;
}

async function handleGetMemoryGraphSettings(req: Request, res: Response): Promise<void> {
  try {
    const principal = getPrincipal(req);
    if (!principal.userId) {
      res.status(401).json({ error: "User session required" });
      return;
    }
    const persisted = await getSetting(memoryGraphSettingsKey(principal.userId));
    res.json({ settings: normalizeMemoryGraphSettings(persisted) });
  } catch {
    res.status(500).json({ error: "Failed to read Memory Graph settings" });
  }
}

async function handleSetMemoryGraphSettings(req: Request, res: Response): Promise<void> {
  try {
    const principal = getPrincipal(req);
    if (!principal.userId) {
      res.status(401).json({ error: "User session required" });
      return;
    }
    if (!isAcceptedMemoryGraphSettingsSnapshot(req.body?.settings)) {
      res.status(400).json({ error: "Invalid Memory Graph settings" });
      return;
    }
    const settings = normalizeMemoryGraphSettings(req.body.settings);
    await setSetting(memoryGraphSettingsKey(principal.userId), settings);
    res.json({ settings });
  } catch {
    res.status(500).json({ error: "Failed to update Memory Graph settings" });
  }
}

async function handleGetVnextGraph(req: Request, res: Response): Promise<void> {
  // Library-first bounded projection is the canonical read path. LIBRARY_FIRST_GRAPH_ENABLED=false
  // rolls back to the retained claim-first assembler below without a redeploy.
  if (!libraryFirstGraphEnabled()) {
    return handleGetVnextGraphLegacy(req, res);
  }
  try {
    const principal = requireCurrentPrincipal();
    const selected = typeof req.query.selected === "string"
      ? req.query.selected.split(",").map(value => value.trim()).filter(Boolean).slice(0, 5)
      : [];
    const projection = await assemblePersonalGraph(principal, { selectedAddresses: selected });
    res.json(projection);
    void scheduleLibraryReferenceReplay(principal, projection.projection.unprojectedLibraryPageCount)
      .then(replay => {
        log.debug("[personal-graph] Library reference replay scheduling", {
          outcome: replay.outcome,
          unprojectedPageCount: replay.unprojectedPageCount,
        });
      })
      .catch((error: unknown) => {
        log.warn("[personal-graph] Library reference replay scheduling degraded", {
          errorType: error instanceof Error ? error.name : "unknown",
        });
      });
  } catch (error: unknown) {
    log.error(`[personal-graph] graph failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    res.status(500).json({ error: errorMessage(error) });
  }
}

// Retained claim-first assembly, wired as the LIBRARY_FIRST_GRAPH_ENABLED=false rollback path.
async function handleGetVnextGraphLegacy(_req: Request, res: Response): Promise<void> {
  try {
    const principal = requireCurrentPrincipal();
    const claimScopeColumns = {
      scope: memoryVnextClaims.scope,
      ownerUserId: memoryVnextClaims.ownerUserId,
      accountId: memoryVnextClaims.accountId,
      instanceId: memoryVnextClaims.instanceId,
    };
    const entityLinkScopeColumns = {
      scope: memoryVnextEntityLinks.scope,
      ownerUserId: memoryVnextEntityLinks.ownerUserId,
      accountId: memoryVnextEntityLinks.accountId,
      instanceId: memoryVnextEntityLinks.instanceId,
    };
    const sourceRefScopeColumns = {
      scope: memoryVnextSourceRefs.scope,
      ownerUserId: memoryVnextSourceRefs.ownerUserId,
      accountId: memoryVnextSourceRefs.accountId,
      instanceId: memoryVnextSourceRefs.instanceId,
    };
    const claimLinkScopeColumns = {
      scope: memoryVnextClaimLinks.scope,
      ownerUserId: memoryVnextClaimLinks.ownerUserId,
      accountId: memoryVnextClaimLinks.accountId,
      instanceId: memoryVnextClaimLinks.instanceId,
    };

    const [claims, currentGoalIndex, currentProjects, meetingRecords] = await Promise.all([
      db
        .select()
        .from(memoryVnextClaims)
        .where(combineWithVisibleScope(
          principal,
          claimScopeColumns,
          sql`${memoryVnextClaims.lifecycleStage} <> ${MEMORY_VNEXT_LIFECYCLE_STAGE.RETIRED}`,
        ))
        .orderBy(desc(memoryVnextClaims.createdAt)),
      goalsService.listAll(),
      fileProjectStorage.getProjects(),
      listMeetingGraphRecords(),
    ]);
    const currentGoalIds = currentGoalIndex
      .filter((goal) => goal.status !== "achieved")
      .map((goal) => goal.id);
    const currentGoals: Goal[] = [];
    for (const batch of chunkValues(currentGoalIds, GRAPH_ENTITY_READ_BATCH_SIZE)) {
      const goals = await Promise.all(batch.map((id) => goalsService.get(id)));
      currentGoals.push(...goals.filter((goal): goal is Goal => goal !== null));
    }
    const currentProjectRows = currentProjects.filter((project) => project.status !== "completed");

    const claimIds = claims.map((claim) => claim.id);
    const visibleClaimIds = new Set(claimIds);
    const claimLinksById = new Map<number, typeof memoryVnextClaimLinks.$inferSelect>();
    const entityLinks: Array<typeof memoryVnextEntityLinks.$inferSelect> = [];
    const sourceRefs: Array<typeof memoryVnextSourceRefs.$inferSelect> = [];
    for (const batch of chunkValues(claimIds)) {
      const [batchClaimLinks, batchEntityLinks, batchSourceRefs] = await Promise.all([
        db.select().from(memoryVnextClaimLinks).where(combineWithVisibleScope(
          principal,
          claimLinkScopeColumns,
          or(
            inArray(memoryVnextClaimLinks.fromClaimId, batch),
            inArray(memoryVnextClaimLinks.toClaimId, batch),
          ),
        )),
        db.select().from(memoryVnextEntityLinks).where(
          combineWithVisibleScope(principal, entityLinkScopeColumns, inArray(memoryVnextEntityLinks.claimId, batch)),
        ),
        db.select().from(memoryVnextSourceRefs).where(
          combineWithVisibleScope(principal, sourceRefScopeColumns, inArray(memoryVnextSourceRefs.claimId, batch)),
        ),
      ]);
      for (const link of batchClaimLinks) claimLinksById.set(link.id, link);
      entityLinks.push(...batchEntityLinks);
      sourceRefs.push(...batchSourceRefs);
    }
    const claimLinks = [...claimLinksById.values()];

    // Resolve human-readable titles for entity and source nodes in bounded batches.
    const entityTitleByKey = new Map<string, string>();
    const entityTimestampByKey = new Map<string, { createdAt: Date | string | null; updatedAt: Date | string | null }>();
    const personEntityIds = [...new Set(entityLinks.filter((l) => l.entityType === "person").map((l) => l.entityId))];
    const companyEntityIds = new Set(entityLinks.filter((link) => link.entityType === "company").map((link) => link.entityId));
    const pageEntityIds = [...new Set(entityLinks.filter((l) => l.entityType === "page" || l.entityType === "library_page").map((l) => l.entityId))];
    const entitySummaryByKey = new Map<string, string>();
    if (personEntityIds.length > 0) {
      const people: Awaited<ReturnType<typeof peopleStorage.getPeopleByIds>> = [];
      for (const batch of chunkValues(personEntityIds)) {
        people.push(...await peopleStorage.getPeopleByIds(batch));
      }
      for (const person of people) {
        entityTitleByKey.set(`person:${person.id}`, person.name);
        const fallbackSummary = [person.role, person.company, person.relation].filter(Boolean).join(" · ");
        const personSummary = person.quickSummary || person.aiSummary || person.identityContent || fallbackSummary;
        if (personSummary) entitySummaryByKey.set(`person:${person.id}`, personSummary);
        entityTimestampByKey.set(`person:${person.id}`, {
          createdAt: person.createdAt,
          updatedAt: person.updatedAt,
        });
      }
    }
    if (companyEntityIds.size > 0) {
      const companies = await companyStorage.list();
      for (const company of companies) {
        if (!companyEntityIds.has(company.id)) continue;
        const key = `company:${company.id}`;
        entityTitleByKey.set(key, company.name);
        const companySummary = company.description || [company.industry, company.location].filter(Boolean).join(" · ");
        if (companySummary) entitySummaryByKey.set(key, companySummary);
        entityTimestampByKey.set(key, { createdAt: company.createdAt, updatedAt: company.updatedAt });
      }
    }
    if (pageEntityIds.length > 0) {
      const pageScope = { ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, scope: libraryPages.scope };
      const pageRows: Array<{ id: string; slug: string; title: string; createdAt: Date; updatedAt: Date }> = [];
      for (const batch of chunkValues(pageEntityIds)) {
        pageRows.push(...await db
          .select({ id: libraryPages.id, slug: libraryPages.slug, title: libraryPages.title, createdAt: libraryPages.createdAt, updatedAt: libraryPages.updatedAt })
          .from(libraryPages)
          .where(combineWithVisibleScope(principal, pageScope, or(inArray(libraryPages.id, batch), inArray(libraryPages.slug, batch)))));
      }
      for (const row of pageRows) {
        if (row.title) {
          entityTitleByKey.set(`page:${row.id}`, row.title);
          entityTitleByKey.set(`library_page:${row.id}`, row.title);
          entityTitleByKey.set(`page:${row.slug}`, row.title);
          entityTitleByKey.set(`library_page:${row.slug}`, row.title);
        }
        const timestamps = { createdAt: row.createdAt, updatedAt: row.updatedAt };
        entityTimestampByKey.set(`page:${row.id}`, timestamps);
        entityTimestampByKey.set(`library_page:${row.id}`, timestamps);
        entityTimestampByKey.set(`page:${row.slug}`, timestamps);
        entityTimestampByKey.set(`library_page:${row.slug}`, timestamps);
      }
    }
    for (const goal of currentGoals) {
      const key = `goal:${goal.id}`;
      entityTitleByKey.set(key, goal.shortName);
      entitySummaryByKey.set(key, goal.description || `${goal.horizon} goal · ${goal.status}`);
      entityTimestampByKey.set(key, { createdAt: goal.createdAt, updatedAt: goal.updatedAt });
    }
    for (const project of currentProjectRows) {
      const key = `project:${project.id}`;
      entityTitleByKey.set(key, project.title);
      entitySummaryByKey.set(key, project.description || `${project.status} project`);
      entityTimestampByKey.set(key, { createdAt: project.createdAt, updatedAt: project.updatedAt });
    }
    // Resolve titles/summaries for meeting attendees so people who appear only as
    // meeting participants (not yet mentioned by any claim) still render named nodes.
    for (const meeting of meetingRecords) {
      for (const participant of meeting.participants) {
        if (!participant.personId) continue;
        const key = `person:${participant.personId}`;
        if (participant.name && !entityTitleByKey.has(key)) entityTitleByKey.set(key, participant.name);
        if (participant.profileSummary && !entitySummaryByKey.has(key)) {
          entitySummaryByKey.set(key, participant.profileSummary);
        }
      }
    }

    const sourcePageIds = [...new Set(sourceRefs.filter((ref) => ref.sourceType === "library_page" || ref.sourceType === "library").map((ref) => ref.sourceId))];
    const sourceSessionIds = [...new Set(sourceRefs.filter((ref) => ref.sourceType === "session").map((ref) => ref.sourceId))];
    const sourceDriveFileIds = [...new Set(
      sourceRefs
        .filter((ref) => ref.sourceType === "drive_file" || ref.sourceType === "file")
        .map((ref) => ref.sourceId)
        .filter(Boolean),
    )];
    const pageScope = { ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, scope: libraryPages.scope };
    const [sourcePageRows, sessionBatches, sourceDriveFileRows] = await Promise.all([
      (async () => {
        const pages: Array<{ id: string; slug: string; title: string; summary: string | null; oneLiner: string | null; createdAt: Date; updatedAt: Date }> = [];
        for (const batch of chunkValues(sourcePageIds)) {
          pages.push(...await db
            .select({ id: libraryPages.id, slug: libraryPages.slug, title: libraryPages.title, summary: libraryPages.summary, oneLiner: libraryPages.oneLiner, createdAt: libraryPages.createdAt, updatedAt: libraryPages.updatedAt })
            .from(libraryPages)
            .where(combineWithVisibleScope(principal, pageScope, or(inArray(libraryPages.id, batch), inArray(libraryPages.slug, batch)))));
        }
        return pages;
      })(),
      (async () => {
        const sessions: Array<Awaited<ReturnType<typeof chatFileStorage.getSession>>> = [];
        for (const batch of chunkValues(sourceSessionIds)) {
          sessions.push(...await chatFileStorage.getSessions(batch));
        }
        return sessions;
      })(),
      (async () => {
        if (sourceDriveFileIds.length === 0 || !principal.accountId) return [] as Array<{
          id: string;
          name: string;
          provider: string;
          providerFileId: string;
          mimeType: string | null;
          vaultId: string;
          createdAt: Date;
        }>;
        const driveGrantIdentity = objectGrantIdentity("drive_resource", {
          objectId: driveResources.id,
          ownerUserId: driveResources.addedByUserId,
          accountId: driveResources.accountId,
          vaultId: driveResources.vaultId,
        });
        const files: Array<{
          id: string;
          name: string;
          provider: string;
          providerFileId: string;
          mimeType: string | null;
          vaultId: string;
          createdAt: Date;
        }> = [];
        for (const batch of chunkValues(sourceDriveFileIds)) {
          files.push(...await db
            .select({
              id: driveResources.id,
              name: driveResources.name,
              provider: driveResources.provider,
              providerFileId: driveResources.providerFileId,
              mimeType: driveResources.mimeType,
              vaultId: driveResources.vaultId,
              createdAt: driveResources.createdAt,
            })
            .from(driveResources)
            .where(
              and(
                inArray(driveResources.id, batch),
                or(
                  eq(driveResources.accountId, principal.accountId),
                  liveObjectGrantPredicate(principal, driveGrantIdentity, "read"),
                  liveVaultGatePredicate(principal, driveResources.vaultId, "read"),
                ),
              ),
            ));
        }
        return files;
      })(),
    ]);
    const allSessions = sessionBatches.flat().filter((session) => session !== undefined);
    const sourcePageById = new Map<string, typeof sourcePageRows[number]>();
    for (const page of sourcePageRows) {
      sourcePageById.set(page.id, page);
      sourcePageById.set(page.slug, page);
    }
    const sourceDriveFileById = new Map(sourceDriveFileRows.map((file) => [file.id, file]));

    const librarySeedPageIds = sourcePageRows.map((page) => page.id);
    const [libraryNeighborhood, libraryAuthoredOccurrences] = await Promise.all([
      getLibraryReferenceNeighborhood(principal, librarySeedPageIds),
      getLibraryAuthoredOccurrences(principal, librarySeedPageIds),
    ]);
    const libraryLinks = libraryNeighborhood.links;
    const linkedPageIds = [...new Set(libraryLinks.flatMap((link) => [link.sourcePageId, link.targetPageId]).filter((id) => !sourcePageById.has(id)))];
    for (const batch of chunkValues(linkedPageIds)) {
      const linkedPages = await db.select({ id: libraryPages.id, slug: libraryPages.slug, title: libraryPages.title, summary: libraryPages.summary, oneLiner: libraryPages.oneLiner, createdAt: libraryPages.createdAt, updatedAt: libraryPages.updatedAt })
        .from(libraryPages)
        .where(combineWithVisibleScope(principal, pageScope, inArray(libraryPages.id, batch)));
      for (const page of linkedPages) {
        sourcePageById.set(page.id, page);
        sourcePageById.set(page.slug, page);
      }
    }
    const sourceSessionById = new Map(
      allSessions
        .filter((session) => sourceSessionIds.includes(session.id) && session.sessionType !== "agent" && session.sessionType !== "autonomous")
        .map((session) => [session.id, session]),
    );

    const claimById = new Map(claims.map((claim) => [claim.id, claim]));
    const newestClaimTimestampByEntityKey = new Map<string, Date>();
    for (const link of entityLinks) {
      const claim = claimById.get(link.claimId);
      const linkedAt = maxTimestamp(claim?.createdAt, claim?.activeTouchedAt, link.createdAt);
      if (!linkedAt) continue;
      const key = `${link.entityType}:${link.entityId}`;
      const current = newestClaimTimestampByEntityKey.get(key);
      if (!current || linkedAt > current) newestClaimTimestampByEntityKey.set(key, linkedAt);
    }

    const entityNodeIds = new Map<string, number>();
    const sourceNodeIds = new Map<string, number>();
    const meetingNodeIds = new Map<string, number>();
    let nextSyntheticNodeId = -1;
    const entries: VnextGraphNode[] = claims.map((claim) => ({
      id: claim.id,
      content: claim.content,
      title: claim.title || (claim.content.length > 80 ? `${claim.content.slice(0, 77)}...` : claim.content),
      summary: `${claim.claimType} claim · ${(claim.confidence * 100).toFixed(0)}% confidence · ${claim.lifecycleStage}`,
      layer: "long",
      source: claim.claimType || "claim",
      sourceId: claim.sourceId ?? undefined,
      tags: claim.topics ?? [],
      graphed: true,
      metadata: {
        ...(claim.metadata && typeof claim.metadata === "object" ? claim.metadata as Record<string, unknown> : {}),
        graphStorage: "vnext",
        nodeKind: "claim",
        claimType: claim.claimType,
        confidence: claim.confidence,
        lifecycleStage: claim.lifecycleStage,
        sourceMemoryId: claim.sourceMemoryId,
        recallCount: claim.recallCount,
      },
      createdAt: serializeDate(claim.createdAt),
      updatedAt: serializeDate(claim.updatedAt),
      recency: computeNodeRecency(claim.createdAt, claim.activeTouchedAt),
    }));

    function ensureEntityNode(entityType: string, entityId: string, fallbackTimestamp?: Date | string | null): number {
      const key = `${entityType}:${entityId}`;
      const existingNodeId = entityNodeIds.get(key);
      if (existingNodeId !== undefined) return existingNodeId;
      const entityNodeId = nextSyntheticNodeId--;
      entityNodeIds.set(key, entityNodeId);
      const entityTitle = entityTitleByKey.get(key) || entityId;
      const entitySummary = entitySummaryByKey.get(key) || `${entityType} in your memory graph`;
      const resolvedTimestamps = entityTimestampByKey.get(key);
      const createdAt = resolvedTimestamps?.createdAt ?? fallbackTimestamp ?? null;
      const updatedAt = resolvedTimestamps?.updatedAt ?? fallbackTimestamp ?? null;
      entries.push({
        id: entityNodeId,
        content: entitySummary,
        title: entityTitle,
        summary: entitySummary,
        layer: "long",
        source: entityType,
        sourceId: entityId,
        tags: [entityType],
        graphed: true,
        metadata: {
          graphStorage: "vnext",
          nodeKind: "entity",
          entityType,
          entityId,
          reference: `@${entityType}:${entityId}`,
        },
        createdAt: serializeDate(createdAt),
        updatedAt: serializeDate(updatedAt),
        recency: computeNodeRecency(createdAt, updatedAt),
      });
      return entityNodeId;
    }

    for (const link of entityLinks) {
      if (!visibleClaimIds.has(link.claimId)) continue;
      ensureEntityNode(
        link.entityType,
        link.entityId,
        newestClaimTimestampByEntityKey.get(`${link.entityType}:${link.entityId}`) ?? link.createdAt,
      );
    }
    for (const goal of currentGoals) ensureEntityNode("goal", goal.id, goal.updatedAt);
    for (const project of currentProjectRows) ensureEntityNode("project", String(project.id), project.updatedAt);

    // Project the meeting session itself and its attendee people as first-class
    // nodes. Meetings are chat sessions; when a claim also references the meeting
    // session, the shared `session:<id>` key routes provenance edges to this same
    // node instead of creating a duplicate source node.
    function ensureMeetingNode(meeting: MeetingIndexRecord): number {
      const key = `meeting:${meeting.id}`;
      const existingNodeId = meetingNodeIds.get(key);
      if (existingNodeId !== undefined) return existingNodeId;
      const meetingNodeId = nextSyntheticNodeId--;
      meetingNodeIds.set(key, meetingNodeId);
      sourceNodeIds.set(`session:${meeting.id}`, meetingNodeId);
      const attendeeNames = meeting.participants.map((participant) => participant.name).filter(Boolean);
      const attendeeSummary = attendeeNames.length > 0 ? `Meeting · ${attendeeNames.join(", ")}` : "Meeting";
      entries.push({
        id: meetingNodeId,
        content: meeting.summary || attendeeSummary,
        title: meeting.title,
        summary: meeting.summary || attendeeSummary,
        layer: "long",
        source: "meeting",
        sourceId: meeting.id,
        tags: ["meeting"],
        graphed: true,
        metadata: {
          graphStorage: "vnext",
          nodeKind: "meeting",
          reference: `@meeting:${meeting.id}`,
          botStatus: meeting.botStatus,
          transcriptCount: meeting.transcriptCount,
        },
        createdAt: serializeDate(meeting.startedAt),
        updatedAt: serializeDate(meeting.endedAt || meeting.startedAt),
        recency: computeNodeRecency(meeting.startedAt, meeting.endedAt),
      });
      return meetingNodeId;
    }

    for (const meeting of meetingRecords) {
      ensureMeetingNode(meeting);
      for (const participant of meeting.participants) {
        if (!participant.personId) continue;
        ensureEntityNode("person", participant.personId, meeting.endedAt || meeting.startedAt);
      }
    }

    function ensureSourceNode(
      normalizedType: "page" | "session" | "file",
      sourceId: string,
      createdAt?: Date | string | null,
    ): number | null {
      const page = normalizedType === "page" ? sourcePageById.get(sourceId) : undefined;
      const session = normalizedType === "session" ? sourceSessionById.get(sourceId) : undefined;
      const file = normalizedType === "file" ? sourceDriveFileById.get(sourceId) : undefined;
      if (!page && !session && !file) return null;
      const canonicalId = page?.id || session?.id || file?.id || sourceId;
      const key = `${normalizedType}:${canonicalId}`;
      const existing = sourceNodeIds.get(key) ?? sourceNodeIds.get(`${normalizedType}:${sourceId}`);
      if (existing) return existing;
      const sourceNodeId = nextSyntheticNodeId--;
      sourceNodeIds.set(key, sourceNodeId);
      sourceNodeIds.set(`${normalizedType}:${sourceId}`, sourceNodeId);
      const title = page?.title || session?.title || file?.name || sourceId;
      const fileSummary = file
        ? [file.provider, file.mimeType].filter(Boolean).join(" · ") || "Indexed file"
        : "";
      const content = page?.summary || page?.oneLiner || session?.summary || fileSummary || "";
      const sessionLastMessageAt = (session?.messages ?? []).reduce<Date | null>((latest, message) => {
        const candidate = maxTimestamp(message.updatedAt, message.createdAt);
        return !candidate || (latest && latest >= candidate) ? latest : candidate;
      }, null);
      const sourceCreatedAt = page?.createdAt || session?.createdAt || file?.createdAt || createdAt;
      const sourceUpdatedAt = page?.updatedAt || maxTimestamp(session?.updatedAt, sessionLastMessageAt) || file?.createdAt || createdAt;
      entries.push({
        id: sourceNodeId,
        content,
        title,
        summary: page?.summary || session?.summary || (file ? fileSummary : undefined),
        layer: "long",
        source: normalizedType,
        sourceId: page?.slug || session?.id || file?.id || sourceId,
        tags: file ? ["file", file.provider].filter(Boolean) : [normalizedType],
        graphed: true,
        metadata: {
          graphStorage: "vnext",
          nodeKind: "source",
          nodeType: normalizedType,
          ...(file
            ? {
                driveResourceId: file.id,
                provider: file.provider,
                providerFileId: file.providerFileId,
                vaultId: file.vaultId,
                reference: `file:${file.id}`,
              }
            : {
                reference: `@${normalizedType}:${page?.id || session?.id || sourceId}`,
              }),
        },
        createdAt: serializeDate(sourceCreatedAt),
        updatedAt: serializeDate(sourceUpdatedAt),
        recency: computeNodeRecency(sourceCreatedAt, sourceUpdatedAt),
      });
      return sourceNodeId;
    }

    for (const ref of sourceRefs) {
      if (!visibleClaimIds.has(ref.claimId)) continue;
      const normalizedType =
        ref.sourceType === "library_page" || ref.sourceType === "library"
          ? "page"
          : ref.sourceType === "drive_file"
            ? "file"
            : ref.sourceType;
      if (normalizedType !== "page" && normalizedType !== "session" && normalizedType !== "file") continue;
      ensureSourceNode(normalizedType, ref.sourceId, ref.createdAt);
    }

    for (const link of libraryLinks) {
      ensureSourceNode("page", link.sourcePageId, link.createdAt);
      ensureSourceNode("page", link.targetPageId, link.createdAt);
    }

    const links: VnextGraphLink[] = claimLinks
      .filter((link) => visibleClaimIds.has(link.fromClaimId) && visibleClaimIds.has(link.toClaimId))
      .map((link) => ({
        id: link.id,
        fromId: link.fromClaimId,
        toId: link.toClaimId,
        relationship: link.relationship,
        strength: link.strength,
        createdAt: serializeDate(link.createdAt),
        relationshipType: "claim_link",
      }));

    for (const ref of sourceRefs) {
      const normalizedType =
        ref.sourceType === "library_page" || ref.sourceType === "library"
          ? "page"
          : ref.sourceType === "drive_file"
            ? "file"
            : ref.sourceType;
      const page = normalizedType === "page" ? sourcePageById.get(ref.sourceId) : undefined;
      const sourceNodeId = sourceNodeIds.get(`${normalizedType}:${page?.id || ref.sourceId}`) ?? sourceNodeIds.get(`${normalizedType}:${ref.sourceId}`);
      if (!sourceNodeId || !visibleClaimIds.has(ref.claimId)) continue;
      links.push({
        id: -(1_000_000 + ref.id),
        fromId: sourceNodeId,
        toId: ref.claimId,
        relationship: ref.relationship,
        strength: ref.strength,
        createdAt: serializeDate(ref.createdAt),
        relationshipType: "source_ref",
      });
    }

    let nextLibraryLinkId = -2_000_000;
    for (const link of libraryLinks) {
      const fromId = sourceNodeIds.get(`page:${link.sourcePageId}`);
      const toId = sourceNodeIds.get(`page:${link.targetPageId}`);
      if (!fromId || !toId) continue;
      links.push({
        id: nextLibraryLinkId--,
        fromId,
        toId,
        relationship: "references",
        strength: 0.6,
        createdAt: serializeDate(link.createdAt),
        relationshipType: "library_page_link",
      });
    }

    for (const link of entityLinks) {
      const entityNodeId = entityNodeIds.get(`${link.entityType}:${link.entityId}`);
      if (!entityNodeId) continue;
      links.push({
        id: -link.id,
        fromId: link.claimId,
        toId: entityNodeId,
        relationship: `mentions_${link.entityType}`,
        strength: 0.7,
        createdAt: serializeDate(link.createdAt),
        relationshipType: "entity_link",
      });
    }

    // Deterministic structural edges derived from existing domain relationships,
    // rather than waiting for probabilistic claim-links: project→goal from
    // project.goalId and meeting→attendee from meeting participants. Both endpoints
    // must already be projected as nodes; dangling references are skipped.
    let nextStructuralLinkId = -3_000_000;
    let structuralLinkCount = 0;
    for (const project of currentProjectRows) {
      if (!project.goalId) continue;
      const fromId = entityNodeIds.get(`project:${project.id}`);
      const toId = entityNodeIds.get(`goal:${project.goalId}`);
      if (!fromId || !toId) continue;
      links.push({
        id: nextStructuralLinkId--,
        fromId,
        toId,
        relationship: "pursues_goal",
        strength: 1,
        createdAt: serializeDate(project.updatedAt),
        relationshipType: "project_goal",
      });
      structuralLinkCount++;
    }
    for (const meeting of meetingRecords) {
      const fromId = meetingNodeIds.get(`meeting:${meeting.id}`);
      if (!fromId) continue;
      const seenAttendee = new Set<string>();
      for (const participant of meeting.participants) {
        if (!participant.personId || seenAttendee.has(participant.personId)) continue;
        seenAttendee.add(participant.personId);
        const toId = entityNodeIds.get(`person:${participant.personId}`);
        if (!toId) continue;
        links.push({
          id: nextStructuralLinkId--,
          fromId,
          toId,
          relationship: "has_attendee",
          strength: 1,
          createdAt: serializeDate(meeting.endedAt || meeting.startedAt),
          relationshipType: "meeting_attendee",
        });
        structuralLinkCount++;
      }
    }

    // Page → referenced-entity edges come exclusively from the transactional
    // occurrence projection. Foreground graph reads never parse Library bodies.
    function resolveReferenceNodeId(address: string): { type: string; nodeId: number } | null {
      const normalized = normalizeProtocolAddress(address);
      if (normalized.outcome !== "valid") return null;
      switch (normalized.type) {
        case "person": return { type: normalized.type, nodeId: entityNodeIds.get(`person:${normalized.id}`) ?? 0 };
        case "goal": return { type: normalized.type, nodeId: entityNodeIds.get(`goal:${normalized.id}`) ?? 0 };
        case "project": return { type: normalized.type, nodeId: entityNodeIds.get(`project:${normalized.id}`) ?? 0 };
        case "meeting": return { type: normalized.type, nodeId: meetingNodeIds.get(`meeting:${normalized.id}`) ?? sourceNodeIds.get(`session:${normalized.id}`) ?? 0 };
        case "session": return { type: normalized.type, nodeId: sourceNodeIds.get(`session:${normalized.id}`) ?? 0 };
        default: return null;
      }
    }

    let nextReferenceLinkId = -4_000_000;
    let referenceLinkCount = 0;
    for (const occurrence of libraryAuthoredOccurrences) {
      if (occurrence.targetAddress.startsWith("@page:")) continue;
      const sourcePageId = occurrence.sourceAddress.slice(6);
      const fromId = sourceNodeIds.get(`page:${sourcePageId}`);
      const target = resolveReferenceNodeId(occurrence.targetAddress);
      if (!fromId || !target?.nodeId || fromId === target.nodeId) continue;
      links.push({
        id: nextReferenceLinkId--,
        fromId,
        toId: target.nodeId,
        relationship: `references_${target.type}`,
        strength: 0.55,
        createdAt: serializeDate(occurrence.observedAt),
        relationshipType: "page_reference",
      });
      referenceLinkCount++;
    }

    log.debug(`[vnext] graph claims=${claims.length} goals=${currentGoals.length} projects=${currentProjectRows.length} meetings=${meetingRecords.length} claimLinks=${claimLinks.length} entityLinks=${entityLinks.length} sourceRefs=${sourceRefs.length} structuralLinks=${structuralLinkCount} pageReferenceLinks=${referenceLinkCount} nodes=${entries.length} links=${links.length}`);
    res.json({ storage: "memory_vnext", entries, links, linkSource: "claim_links", semantics: "personal-intelligence" });
  } catch (error: unknown) {
    log.error(`[vnext] graph failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    res.status(500).json({ error: errorMessage(error) });
  }
}


async function handleTriggerVnextLifecycle(req: Request, res: Response): Promise<void> {
  try {
    const parsed = triggerVnextLifecycleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid vNext lifecycle trigger request" });
      return;
    }
    const result = await runVnextLifecycle({ limit: parsed.data.limit, trigger: "manual_api" });
    eventBus.publish({
      category: "memory",
      event: "entries_changed",
      payload: { action: "vnext_lifecycle", storage: "memory_vnext_claims", ...result, level: result.errors > 0 ? "warn" : "info" },
    });
    log.info(`[vnext] lifecycle_trigger runId=${result.runId} scanned=${result.scanned} sourced=${result.sourced} linked=${result.linked} canonicalized=${result.canonicalized} retired=${result.retired} skipped=${result.skipped} errors=${result.errors}`);
    res.json({ triggered: true, storage: "memory_vnext_claims", ...result });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleNukeVnextClaims(req: Request, res: Response): Promise<void> {
  try {
    const confirm = typeof req.body?.confirm === "string" ? req.body.confirm : "";
    if (confirm !== "NUKE") {
      res.status(400).json({ error: 'vNext nuke requires body {"confirm":"NUKE"}' });
      return;
    }
    const result = await memoryVnextClaimStorage.nukeAllClaims();
    eventBus.publish({
      category: "memory",
      event: "entries_changed",
      payload: { action: "vnext_nuke", storage: "memory_vnext_claims", deleted: result.deleted, level: "warn" },
    });
    log.warn(`[vnext] nuke deleted=${result.deleted} claims (user-initiated reset)`);
    res.json({ nuked: true, storage: "memory_vnext_claims", deleted: result.deleted });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetVnextSources(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(parsePositiveInt(req.query.limit) ?? 100, 500);
    const status = typeof req.query.status === "string" && req.query.status.trim() ? req.query.status.trim() : undefined;
    const principal = requireCurrentPrincipal();
    const sources = await listVisibleSources(principal, { status, limit });
    const byStatus = { pending: 0, processing: 0, completed: 0, total: sources.length };
    for (const source of sources) {
      if (source.status === "pending") byStatus.pending++;
      else if (source.status === "processing") byStatus.processing++;
      else if (source.status === "completed") byStatus.completed++;
    }
    log.debug(`[vnext] source_queue total=${sources.length} limit=${limit} status=${status || "all"}`);
    res.json({
      storage: "memory_vnext_source_queue",
      total: sources.length,
      byStatus,
      sources: sources.map(serializeVnextSourceQueueRow),
    });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetVnextClaimCounts(_req: Request, res: Response): Promise<void> {
  try {
    const counts = await memoryVnextClaimStorage.getCounts();
    log.debug(`[vnext] claim_counts total=${counts.total} sourceRefs=${counts.sourceRefs} entityLinks=${counts.entityLinks} claimLinks=${counts.claimLinks}`);
    res.json({ storage: "memory_vnext_claims", ...counts });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleSearchVnextClaims(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(parsePositiveInt(req.query.limit) ?? 20, 100);
    const offset = Math.max(parsePositiveInt(req.query.offset) ?? 0, 0);
    const claims = await memoryVnextClaimStorage.searchClaims({
      id: parsePositiveInt(req.query.id) ?? undefined,
      claimType: typeof req.query.claimType === "string" ? req.query.claimType : undefined,
      hasEntityLinks: req.query.hasEntityLinks === "true" ? true : req.query.hasEntityLinks === "false" ? false : undefined,
      entityId: typeof req.query.entityId === "string" ? req.query.entityId : undefined,
      lifecycleStage: typeof req.query.lifecycleStage === "string" ? req.query.lifecycleStage : undefined,
      createdAfter: typeof req.query.createdAfter === "string" ? req.query.createdAfter : undefined,
      createdBefore: typeof req.query.createdBefore === "string" ? req.query.createdBefore : undefined,
      limit,
      offset,
    });
    log.debug(`[vnext] claim_search total=${claims.length} limit=${limit} offset=${offset}`);
    res.json({ storage: "memory_vnext_claims", total: claims.length, claims: claims.map(serializeVnextClaim) });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleDeleteVnextClaim(req: Request, res: Response): Promise<void> {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid claim id" }); return; }
    const deleted = await memoryVnextClaimStorage.deleteClaim(id);
    if (!deleted) { res.status(404).json({ error: "vNext claim not found" }); return; }
    eventBus.publish({ category: "memory", event: "entries_changed", payload: { action: "vnext_claim_deleted", claimId: id, level: "info" } });
    res.json({ deleted: true, claimId: id });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetVnextClaim(req: Request, res: Response): Promise<void> {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid claim id" }); return; }
    const detail = await memoryVnextClaimStorage.getClaimDetail(id);
    if (!detail) { res.status(404).json({ error: "vNext claim not found" }); return; }
    await memoryVnextClaimStorage.touchClaim(id);
    const activeTouchedAt = new Date();
    log.debug(`[vnext] claim_detail claimId=${id}`);
    res.json({
      storage: "memory_vnext_claims",
      claim: serializeVnextClaim({ ...detail.claim, activeTouchedAt }),
      sources: detail.sources.map(serializeVnextSourceRef),
      entityLinks: detail.entityLinks.map(serializeVnextEntityLink),
      claimLinks: detail.claimLinks.map(serializeVnextClaimLink),
      claimLinkEvidence: detail.claimLinkEvidence.map((item) => ({ ...item, createdAt: serializeDate(item.createdAt) })),
      transitionPaths: detail.transitionPaths.map(serializeTransitionPathDetail),
      dimensions: serializeVnextDimensions(detail.dimensions),
      lifecycle: {
        ...detail.lifecycle,
        stageUpdatedAt: serializeDate(detail.lifecycle.stageUpdatedAt),
        lastRecalledAt: serializeDate(detail.lifecycle.lastRecalledAt),
        activeTouchedAt: serializeDate(activeTouchedAt),
        createdAt: serializeDate(detail.lifecycle.createdAt),
        updatedAt: serializeDate(detail.lifecycle.updatedAt),
      },
    });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetVnextClaimSources(req: Request, res: Response): Promise<void> {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid claim id" }); return; }
    const refs = await memoryVnextClaimStorage.listSourceRefs(id);
    res.json({ storage: "memory_vnext_sources", claimId: id, total: refs.length, sources: refs.map(serializeVnextSourceRef) });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetVnextClaimEntityLinks(req: Request, res: Response): Promise<void> {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid claim id" }); return; }
    const links = await memoryVnextClaimStorage.listEntityLinks(id);
    res.json({ storage: "memory_vnext_entity_links", claimId: id, total: links.length, entityLinks: links.map(serializeVnextEntityLink) });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetVnextClaimLinks(req: Request, res: Response): Promise<void> {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid claim id" }); return; }
    const links = await memoryVnextClaimStorage.listClaimLinks(id);
    res.json({ storage: "memory_vnext_claim_links", claimId: id, total: links.length, claimLinks: links.map(serializeVnextClaimLink) });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetVnextTransitionPaths(req: Request, res: Response): Promise<void> {
  try {
    const claimId = parsePositiveInt(req.query.claimId);
    const pathId = parsePositiveInt(req.query.pathId);
    const limit = Math.min(parsePositiveInt(req.query.limit) ?? 25, 100);
    const { inspectTransitionPaths } = await import("./vnext-transition-graph");
    const paths = await inspectTransitionPaths({ claimId: claimId ?? undefined, pathId: pathId ?? undefined, limit });
    res.json({ storage: "memory_vnext_transition_paths", total: paths.length, paths: paths.map(serializeTransitionPathDetail) });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleRecomputeVnextTransitionPaths(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(parsePositiveInt(req.body?.limit) ?? 250, 250);
    const { recomputeTransitionPaths } = await import("./vnext-transition-graph");
    const result = await recomputeTransitionPaths(limit);
    eventBus.publish({ category: "memory", event: "entries_changed", payload: { action: "vnext_transition_recompute", storage: "memory_vnext_transition_paths", ...result, level: "info" } });
    res.json({ recomputed: true, storage: "memory_vnext_transition_paths", ...result });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetVnextPredictions(req: Request, res: Response): Promise<void> {
  try {
    const predictionId = parsePositiveInt(req.query.predictionId);
    const limit = Math.min(parsePositiveInt(req.query.limit) ?? 25, 100);
    const { inspectPredictionLedger, inspectPredictionRuns } = await import("./vnext-prediction-ledger");
    const [predictions, runs] = await Promise.all([
      inspectPredictionLedger({ predictionId: predictionId ?? undefined, limit }),
      inspectPredictionRuns(Math.min(limit, 25)),
    ]);
    res.json({
      storage: "memory_vnext_predictions",
      shadowOnly: true,
      total: predictions.length,
      predictions: predictions.map(serializePredictionDetail),
      runs: runs.map((run) => ({ ...run, startedAt: serializeDate(run.startedAt), completedAt: serializeDate(run.completedAt), createdAt: serializeDate(run.createdAt) })),
    });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleRunVnextShadowPredictions(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(parsePositiveInt(req.body?.limit) ?? 25, 25);
    const runKey = typeof req.body?.runKey === "string" && req.body.runKey.trim() ? req.body.runKey.trim().slice(0, 300) : undefined;
    const { runShadowPredictionLoop } = await import("./vnext-prediction-ledger");
    const result = await runShadowPredictionLoop({ trigger: "manual_api", limit, runKey });
    eventBus.publish({
      category: "memory",
      event: "entries_changed",
      payload: { action: "vnext_shadow_prediction_loop", storage: "memory_vnext_predictions", ...result, level: "info" },
    });
    res.json({ shadowOnly: true, storage: "memory_vnext_predictions", ...result });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetVnextRetrievalEvaluation(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(parsePositiveInt(req.query.limit) ?? 25, 100);
    const { inspectRetrievalEvaluation } = await import("./vnext-shadow-evaluation");
    res.json(await inspectRetrievalEvaluation(limit));
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleSetVnextRetrievalMode(req: Request, res: Response): Promise<void> {
  try {
    const mode = req.body?.mode;
    if (mode !== "compatibility" && mode !== "corrected") { res.status(400).json({ error: "mode must be compatibility or corrected" }); return; }
    const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
    const replayKey = typeof req.body?.replayKey === "string" ? req.body.replayKey : "";
    const { setRetrievalMode } = await import("./vnext-shadow-evaluation");
    res.json(await setRetrievalMode({ mode, reason, replayKey }));
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleSetVnextRetrievalLabel(req: Request, res: Response): Promise<void> {
  try {
    const claimId = parsePositiveInt(req.body?.claimId);
    const relevance = req.body?.relevance;
    if (!claimId || (relevance !== "relevant" && relevance !== "irrelevant")) { res.status(400).json({ error: "claimId and relevance are required" }); return; }
    const contextKey = typeof req.body?.contextKey === "string" ? req.body.contextKey : "";
    if (!contextKey.trim()) { res.status(400).json({ error: "contextKey is required" }); return; }
    const { upsertRetrievalLabel } = await import("./vnext-shadow-evaluation");
    res.json(await upsertRetrievalLabel({ contextKey, claimId, relevance, durableFact: req.body?.durableFact === true, note: typeof req.body?.note === "string" ? req.body.note : undefined }));
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleRunVnextPredictionEvaluation(req: Request, res: Response): Promise<void> {
  try {
    const { evaluatePredictions } = await import("./vnext-shadow-evaluation");
    const replayKey = typeof req.body?.replayKey === "string" ? req.body.replayKey : undefined;
    res.json({ predictionOutputMode: "shadow", run: await evaluatePredictions({ replayKey }) });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetVnextPredictionEvaluation(req: Request, res: Response): Promise<void> {
  try {
    const limit = Math.min(parsePositiveInt(req.query.limit) ?? 25, 100);
    const { inspectPredictionEvaluation } = await import("./vnext-shadow-evaluation");
    res.json(await inspectPredictionEvaluation(limit));
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleSetVnextCausalPathReview(req: Request, res: Response): Promise<void> {
  try {
    const predictionId = parsePositiveInt(req.body?.predictionId);
    const judgment = req.body?.judgment;
    if (!predictionId || !["correct", "incorrect", "unclear"].includes(judgment)) { res.status(400).json({ error: "predictionId and valid judgment are required" }); return; }
    const { upsertCausalPathReview } = await import("./vnext-shadow-evaluation");
    res.json(await upsertCausalPathReview({ predictionId, judgment, note: typeof req.body?.note === "string" ? req.body.note : undefined }));
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetVnextClaimLifecycle(req: Request, res: Response): Promise<void> {
  try {
    const id = parsePositiveInt(req.params.id);
    if (!id) { res.status(400).json({ error: "Invalid claim id" }); return; }
    const lifecycle = await memoryVnextClaimStorage.getLifecycleStatus(id);
    if (!lifecycle) { res.status(404).json({ error: "vNext claim not found" }); return; }
    await memoryVnextClaimStorage.touchClaim(id);
    res.json({
      storage: "memory_vnext_claims",
      claimId: id,
      lifecycle: {
        ...lifecycle,
        stageUpdatedAt: serializeDate(lifecycle.stageUpdatedAt),
        lastRecalledAt: serializeDate(lifecycle.lastRecalledAt),
        activeTouchedAt: new Date().toISOString(),
        createdAt: serializeDate(lifecycle.createdAt),
        updatedAt: serializeDate(lifecycle.updatedAt),
      },
    });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

export function registerMemoryRoutes(app: Express) {
  app.use("/api/memory", requireAuth);

  app.get("/api/memory/vnext/graph", handleGetVnextGraph);
  app.get("/api/memory/vnext/graph/settings", handleGetMemoryGraphSettings);
  app.post("/api/memory/vnext/graph/settings", handleSetMemoryGraphSettings);
  app.post("/api/memory/vnext/lifecycle/run", handleTriggerVnextLifecycle);
  app.post("/api/memory/vnext/claims/nuke", handleNukeVnextClaims);
  app.get("/api/memory/vnext/sources", handleGetVnextSources);
  app.get("/api/memory/vnext/claims/counts", handleGetVnextClaimCounts);
  app.get("/api/memory/vnext/transition-paths", handleGetVnextTransitionPaths);
  app.post("/api/memory/vnext/transition-paths/recompute", handleRecomputeVnextTransitionPaths);
  app.get("/api/memory/vnext/predictions", requirePermission("system:read"), handleGetVnextPredictions);
  app.post("/api/memory/vnext/predictions/run-shadow", requirePermission("system:write"), handleRunVnextShadowPredictions);
  app.get("/api/memory/vnext/evaluation/retrieval", requirePermission("system:read"), handleGetVnextRetrievalEvaluation);
  app.post("/api/memory/vnext/evaluation/retrieval/mode", requirePermission("system:write"), handleSetVnextRetrievalMode);
  app.post("/api/memory/vnext/evaluation/retrieval/labels", requirePermission("system:write"), handleSetVnextRetrievalLabel);
  app.get("/api/memory/vnext/evaluation/predictions", requirePermission("system:read"), handleGetVnextPredictionEvaluation);
  app.post("/api/memory/vnext/evaluation/predictions/run", requirePermission("system:write"), handleRunVnextPredictionEvaluation);
  app.post("/api/memory/vnext/evaluation/predictions/reviews", requirePermission("system:write"), handleSetVnextCausalPathReview);
  app.get("/api/memory/vnext/claims", handleSearchVnextClaims);
  app.get("/api/memory/vnext/claims/:id", handleGetVnextClaim);
  app.delete("/api/memory/vnext/claims/:id", handleDeleteVnextClaim);
  app.get("/api/memory/vnext/claims/:id/sources", handleGetVnextClaimSources);
  app.get("/api/memory/vnext/claims/:id/entity-links", handleGetVnextClaimEntityLinks);
  app.get("/api/memory/vnext/claims/:id/claim-links", handleGetVnextClaimLinks);
  app.get("/api/memory/vnext/claims/:id/lifecycle", handleGetVnextClaimLifecycle);
  app.post("/api/memory/search", handleSearchVnextMemory);
}
