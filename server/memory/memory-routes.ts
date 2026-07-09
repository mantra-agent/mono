import type { Express, Request, Response } from "express";
import { z } from "zod";
import { eq, and, inArray, sql, desc } from "drizzle-orm";
import { documentStorage } from "./document-storage";
import {
  memoryStorage,
  memoryEntryLightColumns,
  wrapLightEntry,
} from "./memory-storage";
import {
  docTypes,
  memoryLayers,
  memorySources,
  memoryEntries,
  memorySourceRefs,
  memoryVnextClaims,
  memoryVnextEntityLinks,
  memoryVnextClaimLinks,
  relationshipTypes,
  type MemoryLayer,
  type MemoryEntry,
  type DocType,
  type MemoryVnextClaim,
  type MemoryVnextSourceRef,
  type MemoryVnextEntityLink,
  type MemoryVnextClaimLink,
} from "@shared/schema";
import { eventBus } from "../event-bus";
import { chatCompletion } from "../model-client";
import { ACTIVITY_MEMORY } from "../job-profiles";
import { db } from "../db";
import { createLogger } from "../log";
import { unifiedMemorySearch } from "./unified-search";
import { requireAuth } from "../auth";
import { requirePermission } from "../permissions";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope } from "../scoped-storage";
import { storageBackend, PRIVATE_PREFIX } from "../object_storage/objectStorage";
import { randomUUID, createHash } from "crypto";
import { memoryVnextClaimStorage } from "./vnext-claim-storage";
import { runVnextLifecycle } from "./vnext-lifecycle";

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
    createdAt: serializeDate(claim.createdAt),
    updatedAt: serializeDate(claim.updatedAt),
  };
}

function serializeVnextSourceRef(ref: MemoryVnextSourceRef) {
  return {
    id: ref.id, claimId: ref.claimId, sourceType: ref.sourceType, sourceId: ref.sourceId,
    relationship: ref.relationship, context: ref.context, quote: ref.quote, spanStart: ref.spanStart,
    spanEnd: ref.spanEnd, strength: ref.strength, createdAt: serializeDate(ref.createdAt),
  };
}

function serializeVnextEntityLink(link: MemoryVnextEntityLink) {
  return { id: link.id, claimId: link.claimId, entityType: link.entityType, entityId: link.entityId, createdAt: serializeDate(link.createdAt) };
}

function serializeVnextClaimLink(link: MemoryVnextClaimLink) {
  return { id: link.id, fromClaimId: link.fromClaimId, toClaimId: link.toClaimId, relationship: link.relationship, strength: link.strength, createdAt: serializeDate(link.createdAt) };
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
  layer: z.enum(memoryLayers).optional(),
  limit: z.number().int().positive().default(20),
  source: z.string().optional(),
  archiveMode: z.boolean().optional(),
});

const triggerTransitionSchema = z.object({
  type: z.enum(["short_to_mid", "mid_to_long"]),
  ids: z.array(z.number().int()).optional(),
  summary: z.string().optional(),
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
  const key = `${PRIVATE_PREFIX}memory-retention-purge/${objectId}.json`;
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
  try {
    const layer = req.query.layer as string | undefined;
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 50;
    const offset = req.query.offset
      ? parseInt(req.query.offset as string, 10)
      : 0;

    if (layer && !memoryLayers.includes(layer as MemoryLayer)) {
      res
        .status(400)
        .json({
          error: "Invalid layer. Must be one of: " + memoryLayers.join(", "),
        });
      return;
    }

    if (layer) {
      const entries = await memoryStorage.getLayer(
        layer as MemoryLayer,
        limit,
        offset,
      );
      res.json(await attachSourceCounts(entries));
      return;
    }

    const [short, mid, long] = await Promise.all([
      memoryStorage.getLayer("short", limit, offset),
      memoryStorage.getLayer("mid", limit, offset),
      memoryStorage.getLayer("long", limit, offset),
    ]);
    res.json(await attachSourceCounts([...short, ...mid, ...long]));
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetEntry(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const entry = await memoryStorage.getEntry(id);
    if (!entry) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }
    const [withSources] = await attachSourceCounts([entry]);
    const sourceRefs = await getSourceRefsForEntry(id);
    res.json({ ...withSources, sourceRefs });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}


async function handleGetEntrySources(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const entry = await memoryStorage.getEntry(id);
    if (!entry) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }
    res.json(await getSourceRefsForEntry(id));
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleCreateEntry(req: Request, res: Response): Promise<void> {
  try {
    const parsed = createEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      return;
    }
    const { content, source, sourceId, metadata, tags } = parsed.data;
    const entry = await memoryStorage.ingest(
      content,
      source,
      sourceId,
      metadata,
      tags,
    );
    res.status(201).json(entry);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleUpdateEntry(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const parsed = updateEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      return;
    }

    const oldEntry = parsed.data.layer
      ? await memoryStorage.getEntry(id)
      : null;

    const updated = await memoryStorage.updateEntry(id, parsed.data);
    if (!updated) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }

    if (parsed.data.layer && oldEntry && oldEntry.layer !== parsed.data.layer) {
      log.debug(
        `MemoryTransition PATCH #${id} "${oldEntry.title || oldEntry.content.slice(0, 40)}" ${oldEntry.layer} → ${parsed.data.layer} (manual edit)`,
      );
    }

    res.json(updated);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleDeleteEntry(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    await memoryStorage.deleteEntry(id);
    res.json({ message: "Entry deleted" });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
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

    const { query, layer, limit, source, archiveMode } = parsed.data;

    const results = await unifiedMemorySearch({ query, layer, limit, source, archiveMode });

    res.json(
      results.map((r) => ({
        ...r.entry,
        score: r.score,
        embeddingSim: r.embeddingSim,
        tagSim: r.tagSim,
        titleSim: r.titleSim,
        textMatch: r.textMatch,
        graphHop: r.graphHop,
        graphLinkStrength: r.graphLinkStrength,
      })),
    );
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetLinks(req: Request, res: Response): Promise<void> {
  try {
    const entryId = parseInt(req.params.entryId as string, 10);
    if (isNaN(entryId)) {
      res.status(400).json({ error: "Invalid entryId" });
      return;
    }

    const links = await memoryStorage.getLinks(entryId);
    res.json(links);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleCreateLink(req: Request, res: Response): Promise<void> {
  try {
    const parsed = createLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      return;
    }
    const { fromId, toId, relationship, strength, relationshipType } =
      parsed.data;
    const link = await memoryStorage.createLink(
      fromId,
      toId,
      relationship,
      strength,
      relationshipType,
    );
    res.status(201).json(link);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleDeleteLink(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    await memoryStorage.deleteLink(id);
    res.json({ message: "Link deleted" });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetStats(req: Request, res: Response): Promise<void> {
  try {
    const stats = await memoryStorage.getStats({ archiveMode: req.query.archiveMode === "true" });
    res.json(stats);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetTransitions(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 50;
    const transitions = await memoryStorage.getTransitions(limit);
    res.json(transitions);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function promoteShortToMid(
  ids: number[] | undefined,
): Promise<{
  message: string;
  promoted: MemoryEntry[];
  merged: Array<{ sourceId: number; mergedInto: number; title: string }>;
}> {
  const targetIds =
    ids ?? (await memoryStorage.getLayer("short", 50, 0)).map((e) => e.id);
  if (targetIds.length === 0) {
    return { message: "No entries to promote", promoted: [], merged: [] };
  }
  const { generateTitleSummaryTags } = await import("./memory-enrichment");
  const { tryMergeWithExistingMid } = await import("./memory-transitions");
  const promoted: MemoryEntry[] = [];
  const merged: Array<{ sourceId: number; mergedInto: number; title: string }> =
    [];
  for (const id of targetIds) {
    const entry = await memoryStorage.getEntry(id);
    if (!entry) continue;
    const {
      title,
      oneLiner,
      summary: genSummary,
      tags,
    } = await generateTitleSummaryTags(entry);
    const created = await memoryStorage.promoteToMid(
      id,
      title,
      genSummary,
      tags,
    );
    if (oneLiner) {
      const { db: database } = await import("../db");
      const { memoryEntries: meTable } = await import("@shared/schema");
      const { eq: eqOp } = await import("drizzle-orm");
      await database
        .update(meTable)
        .set({ oneLiner })
        .where(eqOp(meTable.id, created.id));
      created.oneLiner = oneLiner;
    }
    log.debug(
      `MemoryTransition TRIGGER #${id} "${title}" short → mid (manual trigger, in-place)`,
    );

    try {
      const textForEmbed = `${title}\n${genSummary}`;
      const embedding = await memoryStorage.ensureEmbedding(
        created.id,
        textForEmbed,
      );
      if (embedding) {
        created.embedding = embedding;
      }
    } catch (embErr: unknown) {
      log.warn(
        `Embedding generation failed for promoted #${created.id}: ${errorMessage(embErr)}`,
      );
    }

    try {
      const mergeResult = await tryMergeWithExistingMid(created);
      if (mergeResult.merged) {
        log.debug(
          `MemoryTransition TRIGGER #${created.id} "${title}" merged into #${mergeResult.targetId} "${mergeResult.title}" (manual trigger)`,
        );
        merged.push({
          sourceId: created.id,
          mergedInto: mergeResult.targetId!,
          title: mergeResult.title!,
        });
        continue;
      }
    } catch (err: unknown) {
      log.error(
        `merge-on-promote error for #${created.id}: ${errorDetail(err)}`,
      );
    }

    promoted.push(created);
  }

  const { checkMidThreshold } = await import("./consolidation");
  checkMidThreshold();

  return { message: "Promoted to mid-term", promoted, merged };
}

async function promoteMidToLong(
  ids: number[] | undefined,
): Promise<Record<string, unknown>> {
  const targetIds =
    ids ?? (await memoryStorage.getLayer("mid", 50, 0)).map((e) => e.id);
  if (targetIds.length === 0) {
    return { message: "No entries to promote", promoted: [] };
  }

  const promoted: MemoryEntry[] = [];
  const discoveredLinks: Array<{
    from: number;
    to: number;
    relationship: string;
    strength: number;
  }> = [];

  for (const id of targetIds) {
    const entry = await memoryStorage.getEntry(id);
    if (!entry) continue;

    const { promoteEntryToLong } = await import("./consolidation");
    const longEntry = await promoteEntryToLong(entry);
    log.debug(
      `MemoryTransition TRIGGER #${id} "${entry.title || "Untitled"}" mid → long (manual trigger, in-place)`,
    );
    promoted.push(longEntry);

    try {
      if (!longEntry.embedding) {
        await memoryStorage.ensureEmbedding(longEntry.id);
      }

      const candidates = await memoryStorage.findSimilarEntries(
        longEntry.id,
        8,
      );
      if (candidates.length > 0) {
        const { evaluateLinks } = await import("./graph-discovery");
        const { links } = await evaluateLinks(longEntry, candidates);

        for (const link of links) {
          await memoryStorage.createLink(
            link.from,
            link.to,
            link.relationship,
            link.strength,
            link.relationshipType,
          );
          discoveredLinks.push({
            from: link.from,
            to: link.to,
            relationship: link.relationship,
            strength: link.strength,
          });
        }
      }
    } catch (err: unknown) {
      log.error(
        `Graph discovery failed for #${longEntry.id}: ${errorDetail(err)}`,
      );
    }
  }

  return {
    message: "Promoted to long-term",
    promoted,
    links: discoveredLinks,
  };
}

async function handleTriggerTransition(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const parsed = triggerTransitionSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      return;
    }

    const { type, ids } = parsed.data;

    if (type === "short_to_mid") {
      const result = await promoteShortToMid(ids);
      res.json(result);
      return;
    }

    if (type === "mid_to_long") {
      const result = await promoteMidToLong(ids);
      res.json(result);
      return;
    }
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetPalace(req: Request, res: Response): Promise<void> {
  try {
    const linkSource = req.query.linkSource === "sources" ? "sources" : "links";
    const palace = await memoryStorage.getPalace(linkSource);
    res.json(palace);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleClearGraph(_req: Request, res: Response): Promise<void> {
  try {
    const result = await memoryStorage.clearGraph();
    log.debug(
      `Graph cleared: ${result.entriesReset} entries reset, ${result.linksDeleted} links deleted`,
    );
    res.json(result);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleUpdateEntryGraph(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const { graphed } = req.body;
    if (typeof graphed !== "boolean") {
      res.status(400).json({ error: "graphed must be a boolean" });
      return;
    }

    const entry = await memoryStorage.getEntry(id);
    if (!entry) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }

    if (graphed) {
      if (entry.layer !== "long") {
        res
          .status(400)
          .json({ error: "Only long-term entries can be promoted to graph" });
        return;
      }

      await memoryStorage.deleteLinksForEntry(id);
      await memoryStorage.setGraphed(id, true);

      try {
        if (!entry.embedding) {
          await memoryStorage.ensureEmbedding(id);
        }

        const candidates = await memoryStorage.findSimilarEntries(id, 8);
        if (candidates.length > 0) {
          const { evaluateLinks } = await import("./graph-discovery");
          const { links } = await evaluateLinks(entry, candidates);
          for (const link of links) {
            await memoryStorage.createLink(
              link.from,
              link.to,
              link.relationship,
              link.strength,
              link.relationshipType,
            );
          }
        }
      } catch (err: unknown) {
        log.warn(
          `Graph discovery during promote failed for #${id}: ${errorMessage(err)}`,
        );
      }

      const updated = await memoryStorage.getEntry(id);
      res.json(updated);
      return;
    } else {
      await memoryStorage.deleteLinksForEntry(id);
      await memoryStorage.setGraphed(id, false);
      const updated = await memoryStorage.getEntry(id);
      res.json(updated);
      return;
    }
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetBlocks(req: Request, res: Response): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid entry ID" });
      return;
    }
    const blocks = await memoryStorage.getContentBlocks(id);
    res.json(blocks);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetLinkedEntries(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid entry ID" });
      return;
    }
    const entries = await memoryStorage.getLinkedEntries(id);
    res.json(entries);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetLinksWithEntries(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid entry ID" });
      return;
    }
    const linksWithEntries = await memoryStorage.getLinksWithEntries(id);
    res.json(linksWithEntries);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleFlushLayer(req: Request, res: Response): Promise<void> {
  try {
    const layer = req.params.layer;
    if (!memoryLayers.includes(layer as MemoryLayer)) {
      res
        .status(400)
        .json({
          error: "Invalid layer. Must be one of: " + memoryLayers.join(", "),
        });
      return;
    }
    const result = await memoryStorage.flushLayer(layer as MemoryLayer);
    log.debug(`Flushed ${layer}: deleted=${result.deleted}`);
    res.json(result);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleDedup(_req: Request, res: Response): Promise<void> {
  try {
    const result = await memoryStorage.deduplicateMidTerm();
    log.debug(
      `Dedup complete: removed=${result.removed}, remaining=${result.remaining}`,
    );
    res.json(result);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
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
  try {
    const { workspaceDocuments } = await import("@shared/schema");
    const { db: dbInstance } = await import("../db");

    const allDocs = await dbInstance.select().from(workspaceDocuments);
    let migrated = 0;
    let skipped = 0;

    for (const doc of allDocs) {
      const existing = await dbInstance
        .select({ id: memoryEntries.id })
        .from(memoryEntries)
        .where(
          and(
            eq(memoryEntries.layer, "workspace"),
            eq(memoryEntries.source, doc.docType),
            eq(memoryEntries.sourceId, doc.docId),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      await dbInstance.insert(memoryEntries).values({
        layer: "workspace",
        content: doc.content,
        source: doc.docType,
        sourceId: doc.docId,
        path: doc.path,
        title: null,
        metadata: doc.metadata || {},
        tags: [],
        createdAt: doc.createdAt,
        processedAt: doc.updatedAt,
      });
      migrated++;
    }

    log.debug(
      `Unified migration: migrated=${migrated}, skipped=${skipped}, total=${allDocs.length}`,
    );
    res.json({ migrated, skipped, total: allDocs.length });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetMyelinationStats(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const stats = await memoryStorage.getMyelinationStats();
    res.json(stats);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleTriggerMyelination(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const phase = req.body.phase || "all";
    const validPhases = ["all", "summarize", "embed", "link"];
    if (!validPhases.includes(phase)) {
      res
        .status(400)
        .json({
          error: `Invalid phase. Must be one of: ${validPhases.join(", ")}`,
        });
      return;
    }

    const { startMyelinationBackground } = await import("./memory-enrichment");
    const { alreadyRunning } = startMyelinationBackground(phase);

    if (alreadyRunning) {
      res.json({ started: false, message: "Myelination already running" });
      return;
    }

    res.json({ started: true, message: "Myelination started" });
  } catch (error: unknown) {
    log.error("Myelination error:", error);
    const msg = errorMessage(error);
    eventBus.publish({
      category: "memory",
      event: "myelination.error",
      payload: { error: msg, level: "error" },
    });
    res.status(500).json({ error: msg });
  }
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
  try {
    const result = await memoryStorage.flushMyelination();
    log.debug(
      `Flushed myelination: ${result.cleared} entries cleared, ${result.linksDeleted} links deleted`,
    );
    eventBus.publish({
      category: "memory",
      event: "myelination.flushed",
      payload: { ...result, level: "info" },
    });
    res.json(result);
  } catch (error: unknown) {
    log.error("Flush myelination error:", error);
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function myelinateSummarize(
  id: number,
  entry: MemoryEntry,
): Promise<Record<string, unknown>> {
  const { computeContentHash } = await import("./memory-storage");
  const currentHash = computeContentHash(entry.content);
  const hashMatches = entry.contentHash === currentHash;

  if (hashMatches && entry.summary) {
    log.debug(
      `myelinate-single: Entry #${id}: content hash matches, summary exists — skipping summarization`,
    );
    return { skipped: true, reason: "content unchanged" };
  }

  log.debug(
    `myelinate-single: Entry #${id}: generating title/summary/tags (hashMatch=${hashMatches}, hasSummary=${!!entry.summary})`,
  );
  try {
    const { generateTitleSummaryTags } = await import("./memory-enrichment");
    const { title, oneLiner, summary, tags } =
      await generateTitleSummaryTags(entry);
    await memoryStorage.updateSummaryTitleAndHash(
      id,
      summary,
      title,
      currentHash,
      tags,
      oneLiner,
    );
    log.debug(
      `myelinate-single: Entry #${id}: summarization complete — title="${title}", tags=${tags.length}`,
    );
    return { title, oneLiner, summary, tags, contentHash: currentHash };
  } catch (err: unknown) {
    log.error(
      `myelinate-single: Entry #${id}: summarization failed: ${errorDetail(err)}`,
    );
    return { error: errorMessage(err) };
  }
}

async function myelinateEmbed(
  id: number,
  entry: MemoryEntry,
): Promise<Record<string, unknown>> {
  try {
    const { generateEmbedding, isEmbeddingsAvailable } =
      await import("./embedding");
    if (isEmbeddingsAvailable()) {
      const refreshedRaw = await db
        .select(memoryEntryLightColumns)
        .from(memoryEntries)
        .where(eq(memoryEntries.id, id))
        .limit(1);
      const refreshed = refreshedRaw.map((r) =>
        wrapLightEntry(r as Omit<MemoryEntry, "embedding">),
      );
      const textForEmbed =
        refreshed[0]?.summary || refreshed[0]?.content || entry.content;
      log.debug(
        `myelinate-single: Entry #${id}: generating embedding (textLen=${textForEmbed.length})`,
      );
      const embedding = await generateEmbedding(textForEmbed);
      await memoryStorage.updateEmbedding(id, embedding);
      log.debug(
        `myelinate-single: Entry #${id}: embedding saved (${embedding.length} dims)`,
      );
      return { dimensions: embedding.length };
    } else {
      log.debug(
        `myelinate-single: Entry #${id}: embeddings not available, skipping`,
      );
      return { skipped: true, reason: "embeddings not available" };
    }
  } catch (err: unknown) {
    log.error(
      `myelinate-single: Entry #${id}: embedding failed: ${errorDetail(err)}`,
    );
    return { error: errorMessage(err) };
  }
}

async function myelinateDiscover(
  id: number,
  entry: MemoryEntry,
): Promise<Record<string, unknown>> {
  try {
    log.debug(
      `myelinate-single: Entry #${id}: finding similar entries for graph discovery`,
    );
    const candidates = await memoryStorage.findSimilarEntries(id, 8);
    log.debug(
      `myelinate-single: Entry #${id}: found ${candidates.length} candidates`,
    );
    const result: Record<string, unknown> = {
      candidateCount: candidates.length,
      links: [],
    };

    if (candidates.length > 0) {
      const { evaluateLinks } = await import("./graph-discovery");
      const refreshedRaw = await db
        .select(memoryEntryLightColumns)
        .from(memoryEntries)
        .where(eq(memoryEntries.id, id))
        .limit(1);
      const refreshedEntry = refreshedRaw[0]
        ? wrapLightEntry(refreshedRaw[0] as Omit<MemoryEntry, "embedding">)
        : entry;
      const { links } = await evaluateLinks(refreshedEntry, candidates);
      log.debug(
        `myelinate-single: Entry #${id}: evaluateLinks returned ${links.length} links`,
      );

      for (const link of links) {
        await memoryStorage.createLink(
          link.from,
          link.to,
          link.relationship,
          link.strength,
          link.relationshipType,
        );
      }
      result.links = links;
    }

    return result;
  } catch (err: unknown) {
    log.error(
      `myelinate-single: Entry #${id}: graph discovery failed: ${errorDetail(err)}`,
    );
    return { error: errorMessage(err) };
  }
}

async function handleMyeIinateSingle(
  req: Request,
  res: Response,
): Promise<void> {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid entry ID" });
    return;
  }

  try {
    const [entryRaw] = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(eq(memoryEntries.id, id))
      .limit(1);
    if (!entryRaw) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }
    const entry = wrapLightEntry(entryRaw as Omit<MemoryEntry, "embedding">);

    log.debug(
      `myelinate-single: Starting myelination for entry #${id} [${entry.layer}/${entry.source}]`,
    );

    const result: Record<string, unknown> = { entryId: id, steps: {} };
    const steps: Record<string, unknown> = {};

    steps.summarize = await myelinateSummarize(id, entry);
    steps.embed = await myelinateEmbed(id, entry);
    steps.discovery = await myelinateDiscover(id, entry);

    result.steps = steps;
    log.debug(
      `myelinate-single: Entry #${id}: myelination complete`,
      JSON.stringify(steps),
    );
    res.json(result);
  } catch (error: unknown) {
    log.error(
      `myelinate-single: Entry #${id}: unexpected error: ${errorDetail(error)}`,
    );
    res.status(500).json({ error: errorMessage(error) });
  }
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
  try {
    const { isConsolidating, estimateShortTermTokens, getThresholds } =
      await import("./consolidation");
    if (isConsolidating()) {
      res.json({
        triggered: false,
        reason: "Consolidation already in progress",
      });
      return;
    }
    const currentTokens = await estimateShortTermTokens();
    const thresholds = await getThresholds();
    if (currentTokens <= thresholds.targetCapacity) {
      res.json({
        triggered: false,
        skipped: true,
        reason: `Short-term tokens (${currentTokens}) below target capacity (${thresholds.targetCapacity})`,
      });
      return;
    }
    const { executeAutonomousSkillRun } =
      await import("../autonomous-skill-runner");
    executeAutonomousSkillRun("consolidate").catch((err: unknown) => {
      log.error(
        `consolidate fire-and-forget error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    res.json({ triggered: true });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleUpdateConsolidationThresholds(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { setThresholds } = await import("./consolidation");
    const { triggerCapacity, targetCapacity } = req.body;
    if (
      triggerCapacity !== undefined &&
      (typeof triggerCapacity !== "number" || triggerCapacity < 1000)
    ) {
      res
        .status(400)
        .json({ error: "triggerCapacity must be a number >= 1000" });
      return;
    }
    if (
      targetCapacity !== undefined &&
      (typeof targetCapacity !== "number" || targetCapacity < 500)
    ) {
      res.status(400).json({ error: "targetCapacity must be a number >= 500" });
      return;
    }
    if (
      triggerCapacity !== undefined &&
      targetCapacity !== undefined &&
      targetCapacity >= triggerCapacity
    ) {
      res
        .status(400)
        .json({ error: "targetCapacity must be less than triggerCapacity" });
      return;
    }
    const updated = await setThresholds({ triggerCapacity, targetCapacity });
    res.json(updated);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
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
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { isIntegrating, estimateMidTermTokens, getIntegrationThresholds } =
      await import("./consolidation");
    if (isIntegrating()) {
      res.json({ triggered: false, reason: "Integration already in progress" });
      return;
    }
    const force = req.query.force === "true" || req.body?.force === true;
    if (!force) {
      const currentTokens = await estimateMidTermTokens();
      const thresholds = await getIntegrationThresholds();
      if (currentTokens <= thresholds.targetCapacity) {
        res.json({
          triggered: false,
          skipped: true,
          reason: `Mid-term tokens (${currentTokens}) below target capacity (${thresholds.targetCapacity}). Use force=true to override.`,
        });
        return;
      }
    }
    const { executeAutonomousSkillRun } =
      await import("../autonomous-skill-runner");
    const preContext = force
      ? "This is a FORCED manual integration trigger. When calling integrate_mid_to_long, pass force: true to skip threshold checks and promote all eligible entries even if under target capacity."
      : undefined;
    executeAutonomousSkillRun("integrate", { preContext }).catch(
      (err: unknown) => {
        log.error(
          `integrate fire-and-forget error: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
    res.json({ triggered: true });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleUpdateIntegrationThresholds(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { setIntegrationThresholds } = await import("./consolidation");
    const { triggerCapacity, targetCapacity } = req.body;
    if (
      triggerCapacity !== undefined &&
      (typeof triggerCapacity !== "number" || triggerCapacity < 1000)
    ) {
      res
        .status(400)
        .json({ error: "triggerCapacity must be a number >= 1000" });
      return;
    }
    if (
      targetCapacity !== undefined &&
      (typeof targetCapacity !== "number" || targetCapacity < 500)
    ) {
      res.status(400).json({ error: "targetCapacity must be a number >= 500" });
      return;
    }
    if (
      triggerCapacity !== undefined &&
      targetCapacity !== undefined &&
      targetCapacity >= triggerCapacity
    ) {
      res
        .status(400)
        .json({ error: "targetCapacity must be less than triggerCapacity" });
      return;
    }
    const updated = await setIntegrationThresholds({
      triggerCapacity,
      targetCapacity,
    });
    res.json(updated);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
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
  try {
    const { runGraphEnrichment, getGraphMyelinationStatus } =
      await import("./consolidation");
    const status = await getGraphMyelinationStatus();
    if (status.running) {
      res.json({
        triggered: false,
        reason: "Graph enrichment already in progress",
      });
      return;
    }
    if (status.ungraphedCount === 0) {
      res.json({
        triggered: false,
        skipped: true,
        reason: "No ungraphed long-term entries to process",
      });
      return;
    }
    runGraphEnrichment();
    res.json({ triggered: true });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetLog(req: Request, res: Response): Promise<void> {
  try {
    const start = req.query.start
      ? new Date(req.query.start as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = req.query.end ? new Date(req.query.end as string) : new Date();
    const eventType = req.query.eventType as string | undefined;
    const limit = req.query.limit
      ? parseInt(req.query.limit as string, 10)
      : 200;

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      res.status(400).json({ error: "Invalid start or end date" });
      return;
    }

    const events = await memoryStorage.getEventsByRange(start, end, {
      eventType,
      limit,
    });
    res.json(events);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetLogSummary(req: Request, res: Response): Promise<void> {
  try {
    const start = req.query.start
      ? new Date(req.query.start as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = req.query.end ? new Date(req.query.end as string) : new Date();

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      res.status(400).json({ error: "Invalid start or end date" });
      return;
    }

    const summary = await memoryStorage.getEventSummaryByRange(start, end);
    res.json(summary);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetEntryEvents(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid entry ID" });
      return;
    }

    const events = await memoryStorage.getEventsForEntry(id);
    res.json(events);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetDaysWithEvents(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const start = req.query.start
      ? new Date(req.query.start as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = req.query.end ? new Date(req.query.end as string) : new Date();

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      res.status(400).json({ error: "Invalid start or end date" });
      return;
    }

    const days = await memoryStorage.getDaysWithEvents(start, end);
    res.json(days);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetEntriesByDay(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const start = req.query.start
      ? new Date(req.query.start as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = req.query.end ? new Date(req.query.end as string) : new Date();

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      res.status(400).json({ error: "Invalid start or end date" });
      return;
    }

    const entries = await memoryStorage.getMemoryEntriesByDay(start, end);
    res.json(entries);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetEntityLinks(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { entityType, entityId } = req.params;
    const memories = await memoryStorage.getMemoriesForEntity(
      entityType as string,
      entityId as string,
    );
    res.json(memories);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleGetEntryEntityLinks(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const links = await memoryStorage.getEntityLinksForMemory(id);
    res.json(links);
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
    const claimLinkScopeColumns = {
      scope: memoryVnextClaimLinks.scope,
      ownerUserId: memoryVnextClaimLinks.ownerUserId,
      accountId: memoryVnextClaimLinks.accountId,
    };

    const claims = await db
      .select()
      .from(memoryVnextClaims)
      .where(combineWithVisibleScope(principal, claimScopeColumns))
      .orderBy(desc(memoryVnextClaims.createdAt))
      .limit(300);

    const claimIds = claims.map((claim) => claim.id);
    if (claimIds.length === 0) {
      res.json({ storage: "memory_vnext", entries: [], links: [], linkSource: "claim_links", semantics: "claim-centric" });
      return;
    }

    const visibleClaimIds = new Set(claimIds);
    const claimLinks = await db
      .select()
      .from(memoryVnextClaimLinks)
      .where(
        combineWithVisibleScope(
          principal,
          claimLinkScopeColumns,
          and(
            inArray(memoryVnextClaimLinks.fromClaimId, claimIds),
            inArray(memoryVnextClaimLinks.toClaimId, claimIds),
          ),
        ),
      );

    const entityLinks = await db
      .select()
      .from(memoryVnextEntityLinks)
      .where(
        combineWithVisibleScope(
          principal,
          entityLinkScopeColumns,
          inArray(memoryVnextEntityLinks.claimId, claimIds),
        ),
      );

    const entityNodeIds = new Map<string, number>();
    let nextEntityNodeId = -1;
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
    }));

    for (const link of entityLinks) {
      if (!visibleClaimIds.has(link.claimId)) continue;
      const key = `${link.entityType}:${link.entityId}`;
      if (!entityNodeIds.has(key)) {
        const entityNodeId = nextEntityNodeId--;
        entityNodeIds.set(key, entityNodeId);
        entries.push({
          id: entityNodeId,
          content: `${link.entityType}: ${link.entityId}`,
          title: link.entityId,
          summary: `Entity linked to vNext claims (${link.entityType})`,
          layer: "long",
          source: link.entityType,
          sourceId: link.entityId,
          tags: [link.entityType],
          graphed: true,
          metadata: {
            graphStorage: "vnext",
            nodeKind: "entity",
            entityType: link.entityType,
            entityId: link.entityId,
          },
          createdAt: serializeDate(link.createdAt),
          updatedAt: serializeDate(link.createdAt),
        });
      }
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

    log.debug(`[vnext] graph claims=${claims.length} claimLinks=${claimLinks.length} entityLinks=${entityLinks.length} nodes=${entries.length} links=${links.length}`);
    res.json({ storage: "memory_vnext", entries, links, linkSource: "claim_links", semantics: "claim-centric" });
  } catch (error: unknown) {
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
    log.debug(`[vnext] claim_detail claimId=${id}`);
    res.json({
      storage: "memory_vnext_claims",
      claim: serializeVnextClaim(detail.claim),
      sources: detail.sources.map(serializeVnextSourceRef),
      entityLinks: detail.entityLinks.map(serializeVnextEntityLink),
      claimLinks: detail.claimLinks.map(serializeVnextClaimLink),
      lifecycle: {
        ...detail.lifecycle,
        stageUpdatedAt: serializeDate(detail.lifecycle.stageUpdatedAt),
        lastRecalledAt: serializeDate(detail.lifecycle.lastRecalledAt),
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
    res.json({
      storage: "memory_vnext_claims",
      claimId: id,
      lifecycle: {
        ...lifecycle,
        stageUpdatedAt: serializeDate(lifecycle.stageUpdatedAt),
        lastRecalledAt: serializeDate(lifecycle.lastRecalledAt),
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
  try {
    const parsed = entityLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.errors[0]?.message || "Invalid input" });
      return;
    }
    const { memoryId, entityType, entityId } = parsed.data;
    const link = await memoryStorage.linkMemoryToEntity(
      memoryId,
      entityType,
      entityId,
    );
    res.status(201).json(link);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleDeleteEntityLink(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const memoryId = parseInt(req.params.memoryId as string, 10);
    if (isNaN(memoryId)) {
      res.status(400).json({ error: "Invalid memoryId" });
      return;
    }
    const { entityType, entityId } = req.params;
    await memoryStorage.unlinkMemoryFromEntity(
      memoryId,
      entityType as string,
      entityId as string,
    );
    res.json({ success: true });
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

async function handleBackfillLongTitles(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const { backfillLongTitles } = await import("./belief-storage");
    const result = await backfillLongTitles();
    res.json(result);
  } catch (error: unknown) {
    res.status(500).json({ error: errorMessage(error) });
  }
}

export function registerMemoryRoutes(app: Express) {
  app.use("/api/memory", requireAuth);
  app.post("/api/memory/retention-purge/dry-run", requirePermission("system:write"), handleRetentionPurgeDryRun);
  app.post("/api/memory/retention-purge/archive", requirePermission("system:write"), handleRetentionPurgeArchive);
  app.post("/api/memory/retention-purge/execute", requirePermission("system:write"), handleRetentionPurgeExecute);

  app.get("/api/memory/vnext/graph", handleGetVnextGraph);
  app.post("/api/memory/vnext/lifecycle/run", handleTriggerVnextLifecycle);
  app.post("/api/memory/vnext/claims/nuke", handleNukeVnextClaims);
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
  app.post("/api/memory/beliefs/backfill-titles", handleBackfillLongTitles);
  app.post("/api/memory/backfill-long-titles", handleBackfillLongTitles);
}
