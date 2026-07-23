import type { Express, Request, Response } from "express";
import { z } from "zod";
import { eq, and, or, inArray, sql, desc } from "drizzle-orm";
import { documentStorage } from "./document-storage";
import { memoryStorage } from "./memory-storage";
import {
  docTypes,
  memoryLayers,
  memorySources,
  memoryEntries,
  memorySourceRefs,
  MEMORY_VNEXT_LIFECYCLE_STAGE,
  memoryVnextClaims,
  memoryVnextEntityLinks,
  memoryVnextClaimLinks,
  memoryVnextSourceRefs,
  relationshipTypes,
  type MemoryLayer,
  type DocType,
  type MemoryVnextClaim,
  type MemoryVnextSourceRef,
  type MemoryVnextEntityLink,
  type MemoryVnextClaimLink,
  type MemoryVnextSourceQueueRow,
  type Goal,
} from "@shared/schema";
import { eventBus } from "../event-bus";
import { chatCompletion } from "../model-client";
import { ACTIVITY_MEMORY } from "../job-profiles";
import { db } from "../db";
import { createLogger } from "../log";
import { searchVnextMemory } from "./vnext-search";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope } from "../scoped-storage";
import { storageBackend } from "../object_storage/objectStorage";
import { vaultObjectKeyAuto } from "../object_storage/vault-keys";
import { randomUUID, createHash } from "crypto";
import { memoryVnextClaimStorage } from "./vnext-claim-storage";
import type { VnextClaimDimensions } from "./vnext-claim-dimensions";
import { runVnextLifecycle } from "./vnext-lifecycle";
import { listVisibleSources } from "./vnext-source-queue";
import { peopleStorage } from "../people-storage";
import { companyStorage } from "../company-storage";
import { goalsService } from "../goals-service";
import { fileProjectStorage } from "../file-storage/projects";
import { libraryPages, libraryPageLinks } from "@shared/models/info";
import { chatFileStorage } from "../chat-file-storage";

const log = createLogger("MemoryRoutes");


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
    relationship: link.relationship, strength: link.strength, certainty: link.certainty,
    producerMethod: link.producerMethod, derivationVersion: link.derivationVersion,
    provenance: link.provenance, createdAt: serializeDate(link.createdAt),
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


function sendRetiredLegacyMemoryRoute(res: Response, route: string, migration: string): void {
  res.status(410).json({
    deprecated: true,
    storage: "memory_entries",
    route,
    error: "Legacy memory_entries runtime access is retired.",
    migration,
  });
}

function parsePositiveInt(value: unknown): number | null {
  const parsed = typeof value === "string" ? parseInt(value, 10) : typeof value === "number" ? value : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}


const memorySourceScopeColumns = {
  scope: memorySourceRefs.scope,
  ownerUserId: memorySourceRefs.ownerUserId,
  accountId: memorySourceRefs.accountId,
};

async function attachSourceCounts<T extends { id: number }>(entries: T[]): Promise<Array<T & { sourceCount: number }>> {
  if (entries.length === 0) return [];
  const ids = entries.map((entry) => entry.id);
  const rows = await db
    .select({
      memoryId: memorySourceRefs.memoryId,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(memorySourceRefs)
    .where(
      combineWithVisibleScope(
        getCurrentPrincipalOrSystem(),
        memorySourceScopeColumns,
        and(
          inArray(memorySourceRefs.memoryId, ids),
          sql`${memorySourceRefs.sourceType} <> 'raw_system'`,
        ),
      ),
    )
    .groupBy(memorySourceRefs.memoryId);
  const counts = new Map(rows.map((row) => [row.memoryId, Number(row.count ?? 0)]));
  return entries.map((entry) => ({ ...entry, sourceCount: counts.get(entry.id) ?? 0 }));
}

async function getSourceRefsForEntry(memoryId: number) {
  return db
    .select({
      id: memorySourceRefs.id,
      memoryId: memorySourceRefs.memoryId,
      sourceType: memorySourceRefs.sourceType,
      sourceId: memorySourceRefs.sourceId,
      relationship: memorySourceRefs.relationship,
      context: memorySourceRefs.context,
      quote: memorySourceRefs.quote,
      strength: memorySourceRefs.strength,
      createdAt: memorySourceRefs.createdAt,
    })
    .from(memorySourceRefs)
    .where(
      combineWithVisibleScope(
        getCurrentPrincipalOrSystem(),
        memorySourceScopeColumns,
        and(
          eq(memorySourceRefs.memoryId, memoryId),
          sql`${memorySourceRefs.sourceType} <> 'raw_system'`,
        ),
      ),
    )
    .orderBy(desc(memorySourceRefs.strength), desc(memorySourceRefs.createdAt));
}

const createEntrySchema = z.object({
  content: z.string().min(1),
  source: z.enum(memorySources).default("manual"),
  sourceId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

const updateEntrySchema = z.object({
  content: z.string().optional(),
  summary: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
  layer: z.enum(memoryLayers).optional(),
  graphed: z.boolean().optional(),
});

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

const createLinkSchema = z.object({
  fromId: z.number().int(),
  toId: z.number().int(),
  relationship: z.string().min(1),
  strength: z.number().min(0).max(1).default(0.5),
  relationshipType: z.enum(relationshipTypes).default("related"),
});

const entityLinkSchema = z.object({
  memoryId: z.number(),
  entityType: z.enum(["person", "project", "strategy"]),
  entityId: z.string(),
});

const retentionPurgeSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime(),
  layers: z.array(z.enum(memoryLayers)).optional(),
  sources: z.array(z.enum(memorySources)).optional(),
  protectionMode: z.enum(["standard", "aggressive", "exact"]).default("standard"),
});

const retentionExecuteSchema = retentionPurgeSchema.extend({
  archiveHash: z.string().min(16),
  confirmationPhrase: z.string().min(1),
});

function parseRetentionRequest(body: unknown) {
  const parsed = retentionPurgeSchema.safeParse(body);
  if (!parsed.success) return { error: parsed.error.errors[0]?.message || "Invalid input" } as const;
  const endDate = new Date(parsed.data.endDate);
  const startDate = parsed.data.startDate ? new Date(parsed.data.startDate) : undefined;
  if (!Number.isFinite(endDate.getTime())) return { error: "Invalid end date" } as const;
  if (startDate && !Number.isFinite(startDate.getTime())) return { error: "Invalid start date" } as const;
  if (endDate > new Date()) return { error: "End date cannot be in the future" } as const;
  if (startDate && startDate >= endDate) return { error: "Start date must be before end date" } as const;
  return { request: { ...parsed.data, startDate, endDate } } as const;
}

async function handleRetentionPurgeDryRun(req: Request, res: Response): Promise<void> {
  try {
    const parsed = parseRetentionRequest(req.body);
    if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const dryRun = await memoryStorage.dryRunRetentionPurge(parsed.request);
    res.json({ ...dryRun, confirmationPhrase: `PURGE ${dryRun.candidates} MEMORIES` });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function createRetentionArchive(request: Parameters<typeof memoryStorage.buildRetentionPurgeArchive>[0]) {
  const archive = await memoryStorage.buildRetentionPurgeArchive(request);
  const body = JSON.stringify(archive, null, 2);
  const { createdAt: _createdAt, ...stableArchive } = archive;
  const archiveHash = createHash("sha256").update(JSON.stringify(stableArchive)).digest("hex");
  const objectId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const key = vaultObjectKeyAuto("memory-retention-purge", `${objectId}.json`);
  await storageBackend.putObject(key, Buffer.from(body, "utf8"), { contentType: "application/json; charset=utf-8" });
  return { archive, archiveHash, archiveObjectPath: `/objects/memory-retention-purge/${objectId}.json` };
}

async function handleRetentionPurgeArchive(req: Request, res: Response): Promise<void> {
  try {
    const parsed = parseRetentionRequest(req.body);
    if ("error" in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const { archive, archiveHash, archiveObjectPath } = await createRetentionArchive(parsed.request);
    res.json({ archiveHash, archiveObjectPath, candidateCount: archive.candidates, confirmationPhrase: `PURGE ${archive.candidates} MEMORIES` });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleRetentionPurgeExecute(req: Request, res: Response): Promise<void> {
  try {
    const parsedBase = parseRetentionRequest(req.body);
    if ("error" in parsedBase) { res.status(400).json({ error: parsedBase.error }); return; }
    const parsed = retentionExecuteSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" }); return; }
    const { archiveHash, archiveObjectPath, archive } = await createRetentionArchive(parsedBase.request);
    if (archiveHash !== parsed.data.archiveHash) {
      res.status(409).json({ error: "Archive hash changed. Run archive again before executing.", archiveHash, archiveObjectPath });
      return;
    }
    const phrase = `PURGE ${archive.candidates} MEMORIES`;
    if (parsed.data.confirmationPhrase !== phrase) {
      res.status(400).json({ error: "Confirmation phrase mismatch", confirmationPhrase: phrase });
      return;
    }
    const result = await memoryStorage.executeRetentionPurge(parsedBase.request);
    res.json({ ...result, archiveHash, archiveObjectPath, integrity: { graphNeighborhoodsRecomputed: result.peerCleanupScheduled, sqlCascades: true } });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

async function handleGetEntries(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries", "Use /api/memory/vnext/claims?limit=... or POST /api/memory/search for vNext claim search.");
}

async function handleGetEntry(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries/:id", "Use /api/memory/vnext/claims/:id for vNext claim detail.");
}


async function handleGetEntrySources(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries/:id/sources", "Use /api/memory/vnext/claims/:id/sources for vNext claim source refs.");
}

async function handleCreateEntry(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries", "Direct legacy entry creation is retired. Create source artifacts and run /api/memory/vnext/lifecycle/run.");
}

async function handleUpdateEntry(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries/:id", "Legacy entry updates are retired. vNext claims progress through lifecycle maintenance.");
}

async function handleDeleteEntry(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries/:id", "Legacy entry deletion is retired; archived memory_entries rows are preserved.");
}

async function handleSearchEntries(req: Request, res: Response): Promise<void> {
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

async function handleGetLinks(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/links/:entryId", "Use /api/memory/vnext/claims/:id/claim-links for vNext claim links.");
}

async function handleCreateLink(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/links", "Legacy memory_links writes are retired. Use /api/memory/vnext/lifecycle/run to build vNext links.");
}

async function handleDeleteLink(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/links/:id", "Legacy memory_links deletion is retired. vNext claim links are lifecycle-managed.");
}

async function handleGetStats(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/stats", "Use /api/memory/vnext/claims/counts for active vNext claim counts.");
}

async function handleGetTransitions(
  req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/transitions", "Legacy layer transition history is retired. Use vNext claim lifecycle endpoints.");
}

async function handleTriggerTransition(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(410).json({
    deprecated: true,
    triggered: false,
    message: "Legacy memory layer propagation is disabled; use the vNext lifecycle",
  });
}

async function handleGetPalace(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/palace", "Use /api/memory/vnext/graph for the active memory graph.");
}

async function handleClearGraph(_req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/graph/clear", "Legacy graph reset is retired. Use vNext lifecycle maintenance instead.");
}

async function handleUpdateEntryGraph(
  req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries/:id/graph", "Legacy graph promotion is retired. Use vNext lifecycle maintenance instead.");
}

async function handleGetBlocks(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries/:id/blocks", "No faithful vNext equivalent exists for legacy content blocks; use /api/memory/vnext/claims/:id.");
}

async function handleGetLinkedEntries(
  req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries/:id/linked", "Use /api/memory/vnext/claims/:id/claim-links for linked vNext claims.");
}

async function handleGetLinksWithEntries(
  req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries/:id/links", "Use /api/memory/vnext/claims/:id/claim-links for linked vNext claims.");
}

async function handleFlushLayer(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/flush/:layer", "Legacy layer flush is retired; archived memory_entries rows are preserved.");
}

async function handleDedup(_req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/dedup", "Legacy dedup is retired. vNext deduplication runs in extraction/lifecycle.");
}

async function handleGetWorkspace(req: Request, res: Response): Promise<void> {
  try {
    const path = (req.query.path as string) || "";
    const docs = await documentStorage.listDirectory(path || "");

    const dirSet = new Set<string>();
    const files: Array<{
      name: string;
      path: string;
      type: "file" | "directory";
      docType?: string;
      docId?: string;
      title?: string;
    }> = [];

    for (const doc of docs) {
      const docPath = doc.path;
      const relativePath = path
        ? docPath.replace(
            new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`),
            "",
          )
        : docPath;
      const parts = relativePath.split("/").filter(Boolean);

      if (parts.length > 1) {
        const dirName = parts[0];
        const dirPath = path ? `${path}/${dirName}` : dirName;
        if (!dirSet.has(dirPath)) {
          dirSet.add(dirPath);
          files.push({ name: dirName, path: dirPath, type: "directory" });
        }
      } else if (parts.length === 1) {
        files.push({
          name: parts[0],
          path: docPath,
          type: "file",
          docType: doc.docType,
          docId: doc.docId,
          title: doc.title ?? undefined,
        });
      }
    }

    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json(files);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetDocument(req: Request, res: Response): Promise<void> {
  try {
    const { docType, docId } = req.params;

    if (!docTypes.includes(docType as DocType)) {
      res
        .status(400)
        .json({
          error: "Invalid docType. Must be one of: " + docTypes.join(", "),
        });
      return;
    }

    const doc = await documentStorage.getDocument(
      docType as any,
      docId as string,
    );
    if (!doc) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    res.json(doc);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetDocuments(req: Request, res: Response): Promise<void> {
  try {
    const docType = req.query.docType as string | undefined;
    if (docType && !docTypes.includes(docType as DocType)) {
      res.status(400).json({ error: "Invalid docType" });
      return;
    }

    if (docType) {
      const docs = await documentStorage.getDocumentsByType(docType as DocType);
      res.json(docs);
      return;
    }

    const stats = await documentStorage.getStats();
    res.json({ stats });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetMigrationStatus(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const dbStats = await documentStorage.getStats();
    const allTypes = Object.keys(dbStats);
    const comparison: Array<{
      docType: string;
      db: number;
      filesystem: number;
      synced: boolean;
    }> = [];
    for (const t of allTypes) {
      comparison.push({
        docType: t,
        db: dbStats[t] || 0,
        filesystem: 0,
        synced: true,
      });
    }
    comparison.sort((a, b) => a.docType.localeCompare(b.docType));

    const totalDb = Object.values(dbStats).reduce((a, b) => a + b, 0);

    res.json({ comparison, totalDb, totalFs: 0, complete: true });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleMigrateToUnified(
  _req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/migrate-to-unified", "Legacy workspace-to-memory_entries migration is retired. Workspace documents remain in document storage and vNext extraction is source-backed.");
}

async function handleGetMyelinationStats(
  _req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/myelination/stats", "Legacy myelination stats are retired. Use /api/memory/vnext/claims/counts and /api/memory/vnext/graph.");
}

async function handleTriggerMyelination(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(410).json({
    deprecated: true,
    started: false,
    message: "Legacy myelination is disabled; use vNext claim and bridge lifecycle operations",
  });
}

async function handleGetMyelinationProgress(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const { getMyelinationStatus } = await import("./memory-enrichment");
    res.json(getMyelinationStatus());
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleFlushMyelination(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(410).json({
    deprecated: true,
    message: "Legacy myelination mutation is disabled",
  });
}

async function handleMyeIinateSingle(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(410).json({
    deprecated: true,
    started: false,
    message: "Legacy entry myelination is disabled",
  });
}

async function handleDocumentSearch(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { query, docType, limit } = req.body;
    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "query is required" });
      return;
    }
    const results = await documentStorage.searchText(
      query,
      docType && docTypes.includes(docType) ? docType : undefined,
      limit ?? 20,
    );
    res.json(results);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetConsolidationStatus(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const { getConsolidationStatus } = await import("./consolidation");
    const status = await getConsolidationStatus();
    res.json(status);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleTriggerConsolidation(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(410).json({
    deprecated: true,
    triggered: false,
    message: "Legacy short-to-mid consolidation is disabled",
  });
}

async function handleUpdateConsolidationThresholds(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(410).json({ deprecated: true, message: "Legacy consolidation thresholds are retired" });
}

async function handleGetIntegrationStatus(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const { getIntegrationStatus } = await import("./consolidation");
    const status = await getIntegrationStatus();
    res.json(status);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleTriggerIntegration(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(410).json({
    deprecated: true,
    triggered: false,
    message: "Legacy mid-to-long integration is disabled",
  });
}

async function handleUpdateIntegrationThresholds(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(410).json({ deprecated: true, message: "Legacy integration thresholds are retired" });
}

async function handleGetGraphMyelinationStatus(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const { getGraphMyelinationStatus } = await import("./consolidation");
    const status = await getGraphMyelinationStatus();
    res.json(status);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleTriggerGraphMyelination(
  _req: Request,
  res: Response,
): Promise<void> {
  res.status(410).json({
    deprecated: true,
    triggered: false,
    message: "Legacy graph enrichment is disabled; vNext bridges are maintained by the vNext lifecycle",
  });
}

async function handleGetLog(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/log", "Legacy memory event log is retired; inspect vNext claim sources or system events instead.");
}

async function handleGetLogSummary(req: Request, res: Response): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/log/summary", "Legacy memory activity summaries are retired; context activity uses neutral EventBus counts and vNext source data.");
}

async function handleGetEntryEvents(
  req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries/:id/events", "Legacy entry event lookup is retired; inspect source refs through /api/memory/vnext/claims/:id/sources.");
}

async function handleGetDaysWithEvents(
  req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/log/days-with-events", "Legacy memory event calendar is retired; use vNext claim createdAt/source filters for memory timelines.");
}

async function handleGetEntriesByDay(
  req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/log/entries-by-day", "Use /api/memory/vnext/claims with createdAfter/createdBefore filters.");
}

async function handleGetEntityLinks(
  req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entity-links/:entityType/:entityId", "Legacy memory entity lookups are retired. Use /api/memory/vnext/claims with entity filters or search_claims with entityId.");
}

async function handleGetEntryEntityLinks(
  req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entries/:id/entity-links", "Use /api/memory/vnext/claims/:id/entity-links for vNext claim entity links.");
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

async function handleGetVnextGraph(_req: Request, res: Response): Promise<void> {
  try {
    const principal = getCurrentPrincipalOrSystem();
    const claimScopeColumns = {
      scope: memoryVnextClaims.scope,
      ownerUserId: memoryVnextClaims.ownerUserId,
      accountId: memoryVnextClaims.accountId,
    };
    const entityLinkScopeColumns = {
      scope: memoryVnextEntityLinks.scope,
      ownerUserId: memoryVnextEntityLinks.ownerUserId,
      accountId: memoryVnextEntityLinks.accountId,
    };
    const sourceRefScopeColumns = {
      scope: memoryVnextSourceRefs.scope,
      ownerUserId: memoryVnextSourceRefs.ownerUserId,
      accountId: memoryVnextSourceRefs.accountId,
    };
    const claimLinkScopeColumns = {
      scope: memoryVnextClaimLinks.scope,
      ownerUserId: memoryVnextClaimLinks.ownerUserId,
      accountId: memoryVnextClaimLinks.accountId,
    };

    const [claims, currentGoalIndex, currentProjects] = await Promise.all([
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

    const sourcePageIds = [...new Set(sourceRefs.filter((ref) => ref.sourceType === "library_page" || ref.sourceType === "library").map((ref) => ref.sourceId))];
    const sourceSessionIds = [...new Set(sourceRefs.filter((ref) => ref.sourceType === "session").map((ref) => ref.sourceId))];
    const pageScope = { ownerUserId: libraryPages.ownerUserId, accountId: libraryPages.accountId, scope: libraryPages.scope };
    const [sourcePageRows, sessionBatches] = await Promise.all([
      (async () => {
        const pages: Array<{ id: string; slug: string; title: string; plainTextContent: string; summary: string | null; createdAt: Date; updatedAt: Date }> = [];
        for (const batch of chunkValues(sourcePageIds)) {
          pages.push(...await db
            .select({ id: libraryPages.id, slug: libraryPages.slug, title: libraryPages.title, plainTextContent: libraryPages.plainTextContent, summary: libraryPages.summary, createdAt: libraryPages.createdAt, updatedAt: libraryPages.updatedAt })
            .from(libraryPages)
            .where(combineWithVisibleScope(principal, pageScope, or(inArray(libraryPages.id, batch), inArray(libraryPages.slug, batch)))));
        }
        return pages;
      })(),
      (async () => {
        const sessions: Array<Awaited<ReturnType<typeof chatFileStorage.getSession>>> = [];
        for (const batch of chunkValues(sourceSessionIds)) {
          sessions.push(...await Promise.all(batch.map((id) => chatFileStorage.getSession(id))));
        }
        return sessions;
      })(),
    ]);
    const allSessions = sessionBatches.flat().filter((session) => session !== undefined);
    const sourcePageById = new Map<string, typeof sourcePageRows[number]>();
    for (const page of sourcePageRows) {
      sourcePageById.set(page.id, page);
      sourcePageById.set(page.slug, page);
    }

    const libraryLinkScopeColumns = {
      scope: libraryPageLinks.scope,
      ownerUserId: libraryPageLinks.ownerUserId,
      accountId: libraryPageLinks.accountId,
    };
    const librarySeedPageIds = sourcePageRows.map((page) => page.id);
    const libraryLinksById = new Map<number, { id: number; sourcePageId: string; targetPageId: string; createdAt: Date }>();
    for (const batch of chunkValues(librarySeedPageIds)) {
      const rows = await db
        .select({ id: libraryPageLinks.id, sourcePageId: libraryPageLinks.sourcePageId, targetPageId: libraryPageLinks.targetPageId, createdAt: libraryPageLinks.createdAt })
        .from(libraryPageLinks)
        .where(combineWithVisibleScope(principal, libraryLinkScopeColumns, or(inArray(libraryPageLinks.sourcePageId, batch), inArray(libraryPageLinks.targetPageId, batch))));
      for (const row of rows) libraryLinksById.set(row.id, row);
    }
    const libraryLinks = [...libraryLinksById.values()];
    const linkedPageIds = [...new Set(libraryLinks.flatMap((link) => [link.sourcePageId, link.targetPageId]).filter((id) => !sourcePageById.has(id)))];
    for (const batch of chunkValues(linkedPageIds)) {
      const linkedPages = await db.select({ id: libraryPages.id, slug: libraryPages.slug, title: libraryPages.title, plainTextContent: libraryPages.plainTextContent, summary: libraryPages.summary, createdAt: libraryPages.createdAt, updatedAt: libraryPages.updatedAt })
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


    function ensureSourceNode(normalizedType: "page" | "session", sourceId: string, createdAt?: Date | string | null): number | null {
      const page = normalizedType === "page" ? sourcePageById.get(sourceId) : undefined;
      const session = normalizedType === "session" ? sourceSessionById.get(sourceId) : undefined;
      if (!page && !session) return null;
      const canonicalId = page?.id || session?.id || sourceId;
      const key = `${normalizedType}:${canonicalId}`;
      const existing = sourceNodeIds.get(key) ?? sourceNodeIds.get(`${normalizedType}:${sourceId}`);
      if (existing) return existing;
      const sourceNodeId = nextSyntheticNodeId--;
      sourceNodeIds.set(key, sourceNodeId);
      sourceNodeIds.set(`${normalizedType}:${sourceId}`, sourceNodeId);
      const title = page?.title || session?.title || sourceId;
      const content = page?.plainTextContent || session?.summary || "";
      const sessionLastMessageAt = (session?.messages ?? []).reduce<Date | null>((latest, message) => {
        const candidate = maxTimestamp(message.updatedAt, message.createdAt);
        return !candidate || (latest && latest >= candidate) ? latest : candidate;
      }, null);
      const sourceCreatedAt = page?.createdAt || session?.createdAt || createdAt;
      const sourceUpdatedAt = page?.updatedAt || maxTimestamp(session?.updatedAt, sessionLastMessageAt) || createdAt;
      entries.push({
        id: sourceNodeId,
        content,
        title,
        summary: page?.summary || session?.summary || undefined,
        layer: "long",
        source: normalizedType,
        sourceId: page?.slug || session?.id || sourceId,
        tags: [normalizedType],
        graphed: true,
        metadata: {
          graphStorage: "vnext",
          nodeKind: "source",
          nodeType: normalizedType,
          reference: `@${normalizedType}:${page?.slug || session?.id || sourceId}`,
        },
        createdAt: serializeDate(sourceCreatedAt),
        updatedAt: serializeDate(sourceUpdatedAt),
        recency: computeNodeRecency(sourceCreatedAt, sourceUpdatedAt),
      });
      return sourceNodeId;
    }

    for (const ref of sourceRefs) {
      if (!visibleClaimIds.has(ref.claimId)) continue;
      const normalizedType = ref.sourceType === "library_page" || ref.sourceType === "library" ? "page" : ref.sourceType;
      if (normalizedType !== "page" && normalizedType !== "session") continue;
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
      const normalizedType = ref.sourceType === "library_page" || ref.sourceType === "library" ? "page" : ref.sourceType;
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

    for (const link of libraryLinks) {
      const fromId = sourceNodeIds.get(`page:${link.sourcePageId}`);
      const toId = sourceNodeIds.get(`page:${link.targetPageId}`);
      if (!fromId || !toId) continue;
      links.push({
        id: -(2_000_000 + link.id),
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

    log.debug(`[vnext] graph claims=${claims.length} goals=${currentGoals.length} projects=${currentProjectRows.length} claimLinks=${claimLinks.length} entityLinks=${entityLinks.length} sourceRefs=${sourceRefs.length} nodes=${entries.length} links=${links.length}`);
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
    const principal = getCurrentPrincipalOrSystem();
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

async function handleCreateEntityLink(
  req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entity-links", "Legacy memory entity links are retired. Link entities to vNext claims via the memory tool link_entity action.");
}

async function handleDeleteEntityLink(
  req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/entity-links/:memoryId/:entityType/:entityId", "Legacy memory entity link deletion is retired.");
}

async function handleBackfillLongTitles(
  _req: Request,
  res: Response,
): Promise<void> {
  sendRetiredLegacyMemoryRoute(res, "/api/memory/backfill-long-titles", "Legacy long-title maintenance is retired. vNext claim titles are generated at extraction.");
}

export function registerMemoryRoutes(app: Express) {
  app.use("/api/memory", requireAuth);
  app.post("/api/memory/retention-purge/dry-run", requirePermission("system:write"), handleRetentionPurgeDryRun);
  app.post("/api/memory/retention-purge/archive", requirePermission("system:write"), handleRetentionPurgeArchive);
  app.post("/api/memory/retention-purge/execute", requirePermission("system:write"), handleRetentionPurgeExecute);

  app.get("/api/memory/vnext/graph", handleGetVnextGraph);
  app.post("/api/memory/vnext/lifecycle/run", handleTriggerVnextLifecycle);
  app.post("/api/memory/vnext/claims/nuke", handleNukeVnextClaims);
  app.get("/api/memory/vnext/sources", handleGetVnextSources);
  app.get("/api/memory/vnext/claims/counts", handleGetVnextClaimCounts);
  app.get("/api/memory/vnext/claims", handleSearchVnextClaims);
  app.get("/api/memory/vnext/claims/:id", handleGetVnextClaim);
  app.get("/api/memory/vnext/claims/:id/sources", handleGetVnextClaimSources);
  app.get("/api/memory/vnext/claims/:id/entity-links", handleGetVnextClaimEntityLinks);
  app.get("/api/memory/vnext/claims/:id/claim-links", handleGetVnextClaimLinks);
  app.get("/api/memory/vnext/claims/:id/lifecycle", handleGetVnextClaimLifecycle);
  app.get("/api/memory/entries", handleGetEntries);
  app.get("/api/memory/entries/:id", handleGetEntry);
  app.get("/api/memory/entries/:id/sources", handleGetEntrySources);
  app.post("/api/memory/entries", handleCreateEntry);
  app.patch("/api/memory/entries/:id", handleUpdateEntry);
  app.delete("/api/memory/entries/:id", handleDeleteEntry);
  app.post("/api/memory/search", handleSearchEntries);
  app.get("/api/memory/links/:entryId", handleGetLinks);
  app.post("/api/memory/links", handleCreateLink);
  app.delete("/api/memory/links/:id", handleDeleteLink);
  app.get("/api/memory/stats", handleGetStats);
  app.get("/api/memory/transitions", handleGetTransitions);
  app.post("/api/memory/transitions/trigger", handleTriggerTransition);
  app.get("/api/memory/palace", handleGetPalace);
  app.post("/api/memory/graph/clear", handleClearGraph);
  app.patch("/api/memory/entries/:id/graph", handleUpdateEntryGraph);
  app.get("/api/memory/entries/:id/blocks", handleGetBlocks);
  app.get("/api/memory/entries/:id/linked", handleGetLinkedEntries);
  app.get("/api/memory/entries/:id/links", handleGetLinksWithEntries);
  app.post("/api/memory/flush/:layer", handleFlushLayer);
  app.post("/api/memory/dedup", handleDedup);
  app.get("/api/memory/workspace", handleGetWorkspace);
  app.get("/api/memory/document/:docType/:docId", handleGetDocument);
  app.get("/api/memory/documents", handleGetDocuments);
  app.get("/api/memory/migration/status", handleGetMigrationStatus);
  app.post("/api/memory/migrate-to-unified", handleMigrateToUnified);
  app.get("/api/memory/myelination/stats", handleGetMyelinationStats);
  app.post("/api/memory/myelinate", handleTriggerMyelination);
  app.get("/api/memory/myelination/progress", handleGetMyelinationProgress);
  app.post("/api/memory/flush-myelination", handleFlushMyelination);
  app.post("/api/memory/entries/:id/myelinate", handleMyeIinateSingle);
  app.post("/api/memory/documents/search", handleDocumentSearch);
  app.get("/api/memory/consolidation/status", handleGetConsolidationStatus);
  app.post("/api/memory/consolidation/trigger", handleTriggerConsolidation);
  app.patch(
    "/api/memory/consolidation/thresholds",
    handleUpdateConsolidationThresholds,
  );
  app.get("/api/memory/integration/status", handleGetIntegrationStatus);
  app.post("/api/memory/integration/trigger", handleTriggerIntegration);
  app.patch(
    "/api/memory/integration/thresholds",
    handleUpdateIntegrationThresholds,
  );
  app.get(
    "/api/memory/graph-myelination/status",
    handleGetGraphMyelinationStatus,
  );
  app.post(
    "/api/memory/graph-myelination/trigger",
    handleTriggerGraphMyelination,
  );
  app.get("/api/memory/log", handleGetLog);
  app.get("/api/memory/log/summary", handleGetLogSummary);
  app.get("/api/memory/entries/:id/events", handleGetEntryEvents);
  app.get("/api/memory/log/days-with-events", handleGetDaysWithEvents);
  app.get("/api/memory/log/entries-by-day", handleGetEntriesByDay);
  app.get(
    "/api/memory/entity-links/:entityType/:entityId",
    handleGetEntityLinks,
  );
  app.get("/api/memory/entries/:id/entity-links", handleGetEntryEntityLinks);
  app.post("/api/memory/entity-links", handleCreateEntityLink);
  app.delete(
    "/api/memory/entity-links/:memoryId/:entityType/:entityId",
    handleDeleteEntityLink,
  );
  app.post("/api/memory/backfill-long-titles", handleBackfillLongTitles);
}
