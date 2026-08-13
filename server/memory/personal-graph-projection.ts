import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  MEMORY_VNEXT_LIFECYCLE_STAGE,
  driveResources,
  indexedFileSources,
  memoryVnextClaims,
  memoryVnextClaimLinks,
  memoryVnextEntityLinks,
  memoryVnextSourceLinks,
  memoryVnextSourceRefs,
} from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import { normalizeProtocolAddress, type GraphAdapterResult } from "@shared/life-addressing";
import { db } from "../db";
import { eventBus } from "../event-bus";
import { createLogger } from "../log";
import type { Principal } from "../principal";
import { combineWithVisibleScope } from "../scoped-storage";
import { libraryPageIsLive } from "../library-trash";
import {
  getLibraryCorpusOccurrenceEdges,
  LIBRARY_REFERENCE_NEIGHBORHOOD_LIMIT,
} from "../library-reference-index";
import { resolveAddressBatch, ADDRESS_RESOLUTION_BATCH_LIMIT, type AddressResolution } from "../address-resolver";
import {
  liveObjectGrantPredicate,
  liveVaultGatePredicate,
  objectGrantIdentity,
} from "../authorize";
import { peopleStorage } from "../people-storage";
import { companyStorage } from "../company-storage";
import { chatFileStorage } from "../chat-file-storage";
import { meetingGraphAdapter } from "../meetings/meeting-graph-adapter";
import { workGraphAdapter } from "../work/work-graph-adapter";
import { relationshipGraphAdapter } from "../relationships/relationship-graph-adapter";
import { decisionStrategyGraphAdapter } from "../strategy/decision-strategy-graph-adapter";
import { executionProvenanceGraphAdapter } from "../execution-provenance-graph-adapter";
import { tagService } from "../tag-service";

const log = createLogger("PersonalGraphProjection");

const RECENCY_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const CLAIM_LINK_BATCH_SIZE = 500;
/** Whole-corpus page seed ceiling; bounds payload, never gated on corpus size beyond this. */
const PERSONAL_GRAPH_PAGE_LIMIT = 5_000;
/** Whole-corpus indexed-file seed ceiling; bounds payload like the Library page seed. */
const PERSONAL_GRAPH_FILE_LIMIT = 5_000;
/** Max distinct occurrence-target addresses resolved through adapters (chunked by 50). */
const OCCURRENCE_TARGET_RESOLVE_LIMIT = 500;

/** Library-first projection is the canonical read path; set to "false" to roll back to claim-first seeding. */
export function libraryFirstGraphEnabled(): boolean {
  return process.env.LIBRARY_FIRST_GRAPH_ENABLED !== "false";
}

export interface PersonalGraphNode {
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
  recency: number;
}

export interface PersonalGraphLink {
  id: number;
  fromId: number;
  toId: number;
  relationship: string;
  strength: number;
  createdAt?: string | null;
  relationshipType: string;
}

export interface PersonalGraphMetrics {
  libraryFirst: boolean;
  assemblyMs: number;
  nodeCount: number;
  edgeCount: number;
  pageCount: number;
  fileCount: number;
  claimCount: number;
  occurrenceEdgeCount: number;
  canonicalOccurrenceEdgeCount: number;
  compatibilityOccurrenceEdgeCount: number;
  compatibilityOccurrenceSourceCount: number;
  unprojectedLibraryPageCount: number;
  meetingEdgeCount: number;
  workEdgeCount: number;
  relationshipEdgeCount: number;
  decisionStrategyEdgeCount: number;
  executionProvenanceEdgeCount: number;
  sourceObjectEdgeCount: number;
  resolvedTargetCount: number;
  adapterQueryCount: number;
  tagNodeCount: number;
  tagEdgeCount: number;
  payloadBytes: number;
}

export interface PersonalGraphProjection {
  storage: "memory_vnext";
  entries: PersonalGraphNode[];
  links: PersonalGraphLink[];
  linkSource: "claim_links";
  semantics: "personal-intelligence";
  projection: PersonalGraphMetrics;
}

function serializeDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function computeNodeRecency(...timestamps: Array<Date | string | null | undefined>): number {
  const mostRecentMs = timestamps.reduce((latest, timestamp) => {
    if (!timestamp) return latest;
    const candidate = new Date(timestamp).getTime();
    return Number.isFinite(candidate) ? Math.max(latest, candidate) : latest;
  }, 0);
  if (mostRecentMs <= 0) return 0;
  const daysSince = Math.max(0, (Date.now() - mostRecentMs) / MS_PER_DAY);
  return Math.pow(2, -daysSince / RECENCY_HALF_LIFE_DAYS);
}

function maxTimestamp(...timestamps: Array<Date | string | null | undefined>): Date | null {
  const latestMs = timestamps.reduce((latest, timestamp) => {
    if (!timestamp) return latest;
    const candidate = new Date(timestamp).getTime();
    return Number.isFinite(candidate) ? Math.max(latest, candidate) : latest;
  }, 0);
  return latestMs > 0 ? new Date(latestMs) : null;
}

function chunkValues<T>(values: T[], batchSize = CLAIM_LINK_BATCH_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize) {
    chunks.push(values.slice(index, index + batchSize));
  }
  return chunks;
}

/**
 * Node address types excluded from the Memory Graph surface.
 * Domain truth remains intact; these types simply do not project into the
 * human-facing graph or Layers filter.
 */
const EXCLUDED_GRAPH_NODE_TYPES = new Set([
  "workflow",
  "workflow_gate",
  "task",
  "pr",
  "plan",
  "plan_attempt",
  "interaction",
]);

function isExcludedGraphNodeType(type: string): boolean {
  return EXCLUDED_GRAPH_NODE_TYPES.has(type.trim().toLowerCase());
}

/** Map a canonical address type to the client node `source` vocabulary. */
function sourceForAddressType(type: string): string {
  switch (type) {
    case "page":
      return "page";
    case "meeting":
      return "meeting";
    case "session":
      return "session";
    case "file":
      return "file";
    default:
      return type;
  }
}

/** Normalize vNext queue/source-ref types onto graph node address types. */
function normalizeSourceRefType(sourceType: string): string {
  if (sourceType === "library_page" || sourceType === "library") return "page";
  if (sourceType === "drive_file") return "file";
  return sourceType;
}

/**
 * Bounded, Library-first personal graph assembly. Seeds every principal-visible live
 * Library page (including isolated pages), aggregates authored occurrence edges,
 * resolves referenced targets through independently authorized domain adapters, then
 * overlays vNext semantic claims and selected strong domain facts. Foreground reads
 * never parse page bodies. Query count is bounded by the adapter set, not corpus size.
 */
export async function assemblePersonalGraph(
  principal: Principal,
  input: { selectedAddresses?: readonly string[] } = {},
): Promise<PersonalGraphProjection> {
  const startedAt = Date.now();
  const libraryFirst = libraryFirstGraphEnabled();
  let adapterQueryCount = 0;

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
  const sourceLinkScopeColumns = {
    scope: memoryVnextSourceLinks.scope,
    ownerUserId: memoryVnextSourceLinks.ownerUserId,
    accountId: memoryVnextSourceLinks.accountId,
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
  const pageScope = {
    ownerUserId: libraryPages.ownerUserId,
    accountId: libraryPages.accountId,
    scope: libraryPages.scope,
    vaultId: libraryPages.vaultId,
  };

  const driveGrantIdentity = objectGrantIdentity("drive_resource", {
    objectId: driveResources.id,
    ownerUserId: driveResources.addedByUserId,
    accountId: driveResources.accountId,
    vaultId: driveResources.vaultId,
  });

  // Base seed: every visible live Library page and every authorized active indexed
  // file (slim metadata only) plus vNext claims, current work, meetings, and the
  // whole-corpus authored occurrence edges. Semantic processing enriches these
  // source nodes later; it does not control their admission to the graph.
  const [visiblePages, indexedFiles, claims, meetingProjection, workProjection, relationshipProjection, decisionStrategyProjection, executionProvenanceProjection, occurrenceEdges] =
    await Promise.all([
      libraryFirst
        ? db
            .select({
              id: libraryPages.id,
              slug: libraryPages.slug,
              title: libraryPages.title,
              summary: libraryPages.summary,
              oneLiner: libraryPages.oneLiner,
              createdAt: libraryPages.createdAt,
              updatedAt: libraryPages.updatedAt,
            })
            .from(libraryPages)
            .where(combineWithVisibleScope(principal, pageScope, libraryPageIsLive()))
            .orderBy(desc(libraryPages.updatedAt))
            .limit(PERSONAL_GRAPH_PAGE_LIMIT)
        : Promise.resolve([] as Array<{ id: string; slug: string; title: string; summary: string | null; oneLiner: string | null; createdAt: Date; updatedAt: Date }>),
      libraryFirst && principal.accountId
        ? db
            .select({
              id: driveResources.id,
              name: indexedFileSources.name,
              provider: indexedFileSources.provider,
              providerFileId: indexedFileSources.providerFileId,
              mimeType: indexedFileSources.mimeType,
              vaultId: indexedFileSources.vaultId,
              createdAt: indexedFileSources.createdAt,
              updatedAt: indexedFileSources.updatedAt,
              title: indexedFileSources.title,
              oneLiner: indexedFileSources.oneLiner,
              summary: indexedFileSources.summary,
              tags: indexedFileSources.tags,
            })
            .from(indexedFileSources)
            .innerJoin(driveResources, eq(indexedFileSources.driveResourceId, driveResources.id))
            .where(and(
              eq(indexedFileSources.discoveryState, "active"),
              isNull(indexedFileSources.retiredAt),
              eq(indexedFileSources.accountId, principal.accountId),
              or(
                eq(driveResources.accountId, principal.accountId),
                liveObjectGrantPredicate(principal, driveGrantIdentity, "read"),
                liveVaultGatePredicate(principal, driveResources.vaultId, "read"),
              ),
            ))
            .orderBy(desc(indexedFileSources.updatedAt))
            .limit(PERSONAL_GRAPH_FILE_LIMIT)
        : Promise.resolve([]),
      db
        .select()
        .from(memoryVnextClaims)
        .where(combineWithVisibleScope(
          principal,
          claimScopeColumns,
          sql`${memoryVnextClaims.lifecycleStage} <> ${MEMORY_VNEXT_LIFECYCLE_STAGE.RETIRED}`,
        ))
        .orderBy(desc(memoryVnextClaims.createdAt)),
      meetingGraphAdapter.project(principal, { limit: 500 }),
      workGraphAdapter.project(principal, { limit: 1_000 }),
      relationshipGraphAdapter.project(principal, { limit: 1_000 }),
      decisionStrategyGraphAdapter.project(principal, { limit: 500, selectedAddresses: input.selectedAddresses }),
      executionProvenanceGraphAdapter.project(principal, { limit: 500, selectedAddresses: input.selectedAddresses }),
      getLibraryCorpusOccurrenceEdges(principal, LIBRARY_REFERENCE_NEIGHBORHOOD_LIMIT),
    ]);
  adapterQueryCount += 9;
  const occurrenceProjection = occurrenceEdges;
  const authoredOccurrenceEdges = occurrenceProjection.edges;
  const sourceObjectLinks = await db.select().from(memoryVnextSourceLinks)
    .where(combineWithVisibleScope(principal, sourceLinkScopeColumns))
    .orderBy(desc(memoryVnextSourceLinks.observedAt))
    .limit(2_000);
  adapterQueryCount += 1;

  // Domain adapter projections. Each adapter emits canonical candidates only; the
  // assembler owns client-node conversion, address-based merging, and independent
  // endpoint authorization. No adapter query scales with corpus size.
  const adapterProjections: Array<{ id: string; result: GraphAdapterResult }> = [
    { id: meetingGraphAdapter.id, result: meetingProjection },
    { id: workGraphAdapter.id, result: workProjection },
    { id: relationshipGraphAdapter.id, result: relationshipProjection },
    { id: decisionStrategyGraphAdapter.id, result: decisionStrategyProjection },
    { id: executionProvenanceGraphAdapter.id, result: executionProvenanceProjection },
  ];

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
        or(inArray(memoryVnextClaimLinks.fromClaimId, batch), inArray(memoryVnextClaimLinks.toClaimId, batch)),
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

  // Resolve human-readable titles for entity nodes in bounded batches.
  const entityTitleByKey = new Map<string, string>();
  const entitySummaryByKey = new Map<string, string>();
  const entityTimestampByKey = new Map<string, { createdAt: Date | string | null; updatedAt: Date | string | null }>();
  const personEntityIds = [...new Set(entityLinks.filter((l) => l.entityType === "person").map((l) => l.entityId))];
  const companyEntityIds = new Set(entityLinks.filter((link) => link.entityType === "company").map((link) => link.entityId));
  if (personEntityIds.length > 0) {
    const people: Awaited<ReturnType<typeof peopleStorage.getPeopleByIds>> = [];
    for (const batch of chunkValues(personEntityIds)) people.push(...await peopleStorage.getPeopleByIds(batch));
    for (const person of people) {
      entityTitleByKey.set(`person:${person.id}`, person.name);
      const fallbackSummary = [person.role, person.company, person.relation].filter(Boolean).join(" · ");
      const personSummary = person.quickSummary || person.aiSummary || person.identityContent || fallbackSummary;
      if (personSummary) entitySummaryByKey.set(`person:${person.id}`, personSummary);
      entityTimestampByKey.set(`person:${person.id}`, { createdAt: person.createdAt, updatedAt: person.updatedAt });
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
  // Goal/Project/Milestone/Task titles and structural topology are owned by the
  // Work adapter (registered as domain nodes below); claim mentions attach to them.

  // Session + drive_file source nodes (pages are all seeded; these load only when cited).
  const sourceSessionIds = [...new Set(sourceRefs.filter((ref) => ref.sourceType === "session").map((ref) => ref.sourceId))];
  const sourceDriveFileIds = [...new Set([
    ...indexedFiles.map((file) => file.id),
    ...sourceRefs
      .filter((ref) => ref.sourceType === "drive_file" || ref.sourceType === "file")
      .map((ref) => ref.sourceId)
      .filter(Boolean),
  ])];
  const sessionBatches: Array<Awaited<ReturnType<typeof chatFileStorage.getSession>>> = [];
  for (const batch of chunkValues(sourceSessionIds)) sessionBatches.push(...await chatFileStorage.getSessions(batch));
  const sourceSessionById = new Map(
    sessionBatches
      .filter((session) => session !== undefined && sourceSessionIds.includes(session.id) && session.sessionType !== "agent" && session.sessionType !== "autonomous")
      .map((session) => [session!.id, session!]),
  );

  // Durable file identity is drive_resources.id. Visibility mirrors FilesApi:
  // account-owned bind OR live object grant OR live vault gate.
  const sourceDriveFileById = new Map<string, {
    id: string;
    name: string;
    provider: string;
    providerFileId: string;
    mimeType: string | null;
    vaultId: string;
    createdAt: Date;
  }>();
  if (sourceDriveFileIds.length > 0 && principal.accountId) {
    for (const batch of chunkValues(sourceDriveFileIds)) {
      const rows = await db
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
        );
      for (const row of rows) sourceDriveFileById.set(row.id, row);
    }
  }

  // ---- Node assembly (keyed by canonical address; merges by address) ----
  const entries: PersonalGraphNode[] = [];
  const nodeIdByAddress = new Map<string, number>();
  let nextSyntheticNodeId = -1;

  function registerNode(address: string, node: PersonalGraphNode): number {
    nodeIdByAddress.set(address, node.id);
    entries.push(node);
    return node.id;
  }

  // Claims (positive IDs, own their true id).
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  for (const claim of claims) {
    registerNode(`claim:${claim.id}`, {
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
        ...(claim.metadata && typeof claim.metadata === "object" ? (claim.metadata as Record<string, unknown>) : {}),
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
    });
  }

  // Library-first base: every visible live page becomes a node, isolated or not.
  const pageById = new Map<string, { id: string; slug: string; title: string; summary: string | null; oneLiner: string | null; createdAt: Date; updatedAt: Date }>();
  for (const page of visiblePages) {
    pageById.set(page.id, page);
    pageById.set(page.slug, page);
    const address = `page:${page.id}`;
    if (nodeIdByAddress.has(address)) continue;
    registerNode(address, {
      id: nextSyntheticNodeId--,
      content: page.summary || page.oneLiner || "",
      title: page.title || page.slug,
      summary: page.summary || page.oneLiner || undefined,
      layer: "long",
      source: "page",
      sourceId: page.slug,
      tags: ["page"],
      graphed: true,
      metadata: { graphStorage: "vnext", nodeKind: "source", nodeType: "page", reference: `@page:${page.id}` },
      createdAt: serializeDate(page.createdAt),
      updatedAt: serializeDate(page.updatedAt),
      recency: computeNodeRecency(page.createdAt, page.updatedAt),
    });
  }

  // Domain adapter nodes are canonical candidates. Registering them before the
  // claim entity-link overlay lets claim mentions attach to the richer domain
  // node instead of a minimal fallback. Merged by canonical address.
  for (const { id: adapterId, result } of adapterProjections) {
    for (const node of result.nodes) {
      const normalized = normalizeProtocolAddress(node.id);
      if (normalized.outcome !== "valid") continue;
      if (isExcludedGraphNodeType(normalized.type) || isExcludedGraphNodeType(node.type)) continue;
      const key = `${normalized.type}:${normalized.id}`;
      if (nodeIdByAddress.has(key)) continue;
      const nodeId = registerNode(key, {
        id: nextSyntheticNodeId--,
        content: node.summary || node.label,
        title: node.label,
        summary: node.summary,
        layer: "long",
        source: sourceForAddressType(node.type),
        sourceId: normalized.id,
        tags: [node.type],
        graphed: true,
        metadata: { graphStorage: "vnext", nodeKind: "domain", nodeType: node.type, reference: node.id, adapterId },
        createdAt: null,
        updatedAt: node.updatedAt ?? null,
        recency: node.recency,
      });
      if (normalized.type === "meeting") nodeIdByAddress.set(`session:${normalized.id}`, nodeId);
    }
  }

  function ensureEntityNode(entityType: string, entityId: string, fallbackTimestamp?: Date | string | null): number | null {
    if (isExcludedGraphNodeType(entityType)) return null;
    const key = `${entityType}:${entityId}`;
    const existing = nodeIdByAddress.get(key);
    if (existing !== undefined) return existing;
    const title = entityTitleByKey.get(key) || entityId;
    const summary = entitySummaryByKey.get(key) || `${entityType} in your memory graph`;
    const resolvedTimestamps = entityTimestampByKey.get(key);
    const createdAt = resolvedTimestamps?.createdAt ?? fallbackTimestamp ?? null;
    const updatedAt = resolvedTimestamps?.updatedAt ?? fallbackTimestamp ?? null;
    return registerNode(key, {
      id: nextSyntheticNodeId--,
      content: summary,
      title,
      summary,
      layer: "long",
      source: entityType,
      sourceId: entityId,
      tags: [entityType],
      graphed: true,
      metadata: { graphStorage: "vnext", nodeKind: "entity", entityType, entityId, reference: `@${entityType}:${entityId}` },
      createdAt: serializeDate(createdAt),
      updatedAt: serializeDate(updatedAt),
      recency: computeNodeRecency(createdAt, updatedAt),
    });
  }

  const newestClaimTimestampByEntityKey = new Map<string, Date>();
  for (const link of entityLinks) {
    const claim = claimById.get(link.claimId);
    const linkedAt = maxTimestamp(claim?.createdAt, claim?.activeTouchedAt, link.createdAt);
    if (!linkedAt) continue;
    const key = `${link.entityType}:${link.entityId}`;
    const current = newestClaimTimestampByEntityKey.get(key);
    if (!current || linkedAt > current) newestClaimTimestampByEntityKey.set(key, linkedAt);
  }
  for (const link of entityLinks) {
    if (!visibleClaimIds.has(link.claimId)) continue;
    ensureEntityNode(link.entityType, link.entityId, newestClaimTimestampByEntityKey.get(`${link.entityType}:${link.entityId}`) ?? link.createdAt);
  }

  function ensureSessionNode(sourceId: string, createdAt?: Date | string | null): number | null {
    const session = sourceSessionById.get(sourceId);
    if (!session) return null;
    const key = `session:${session.id}`;
    const existing = nodeIdByAddress.get(key);
    if (existing !== undefined) return existing;
    const sessionLastMessageAt = (session.messages ?? []).reduce<Date | null>((latest, message) => {
      const candidate = maxTimestamp(message.updatedAt, message.createdAt);
      return !candidate || (latest && latest >= candidate) ? latest : candidate;
    }, null);
    const createdTs = session.createdAt || createdAt;
    const updatedTs = maxTimestamp(session.updatedAt, sessionLastMessageAt) || createdAt;
    return registerNode(key, {
      id: nextSyntheticNodeId--,
      content: session.summary || "",
      title: session.title || sourceId,
      summary: session.summary || undefined,
      layer: "long",
      source: "session",
      sourceId: session.id,
      tags: ["session"],
      graphed: true,
      metadata: { graphStorage: "vnext", nodeKind: "source", nodeType: "session", reference: `@session:${session.id}` },
      createdAt: serializeDate(createdTs),
      updatedAt: serializeDate(updatedTs),
      recency: computeNodeRecency(createdTs, updatedTs),
    });
  }

  const indexedFileById = new Map(indexedFiles.map((file) => [file.id, file]));

  function ensureDriveFileNode(sourceId: string, createdAt?: Date | string | null): number | null {
    const file = sourceDriveFileById.get(sourceId);
    if (!file) return null;
    const indexedFile = indexedFileById.get(sourceId);
    // Canonical durable file identity for graph/source refs is drive_resource id.
    const key = `file:${file.id}`;
    const existing = nodeIdByAddress.get(key);
    if (existing !== undefined) return existing;
    const createdTs = indexedFile?.createdAt || file.createdAt || createdAt;
    const updatedTs = indexedFile?.updatedAt || createdTs;
    const fallbackSummary = [file.provider, file.mimeType].filter(Boolean).join(" · ") || "Indexed file";
    const summary = indexedFile?.summary || indexedFile?.oneLiner || fallbackSummary;
    const indexedTags = Array.isArray(indexedFile?.tags)
      ? indexedFile.tags.filter((tag): tag is string => typeof tag === "string")
      : [];
    return registerNode(key, {
      id: nextSyntheticNodeId--,
      content: summary,
      title: indexedFile?.title || file.name || sourceId,
      summary,
      layer: "long",
      source: "file",
      sourceId: file.id,
      tags: [...new Set(["file", file.provider, ...indexedTags].filter(Boolean))],
      graphed: true,
      metadata: {
        graphStorage: "vnext",
        nodeKind: "source",
        nodeType: "file",
        indexed: indexedFile !== undefined,
        driveResourceId: file.id,
        provider: file.provider,
        providerFileId: file.providerFileId,
        vaultId: file.vaultId,
        reference: `@file:${file.id}`,
      },
      createdAt: serializeDate(createdTs),
      updatedAt: serializeDate(updatedTs),
      recency: computeNodeRecency(createdTs, updatedTs),
    });
  }

  for (const file of indexedFiles) ensureDriveFileNode(file.id, file.createdAt);

  for (const ref of sourceRefs) {
    if (!visibleClaimIds.has(ref.claimId)) continue;
    if (ref.sourceType === "session") ensureSessionNode(ref.sourceId, ref.createdAt);
    if (ref.sourceType === "drive_file" || ref.sourceType === "file") {
      ensureDriveFileNode(ref.sourceId, ref.createdAt);
    }
  }

  // Resolve distinct non-page occurrence targets through independently authorized
  // adapters so a page can link to a person/goal/etc. even if nothing else cites it.
  const unresolvedTargets = new Set<string>();
  for (const edge of authoredOccurrenceEdges) {
    const normalized = normalizeProtocolAddress(edge.targetAddress);
    if (normalized.outcome !== "valid") continue;
    const key = `${normalized.type}:${normalized.id}`;
    if (normalized.type === "page") continue; // pages already seeded
    if (nodeIdByAddress.has(key)) continue;
    unresolvedTargets.add(edge.targetAddress);
  }
  // Every domain-adapter target is independently resolved below. Invalid legacy
  // coordinates or copied provider IDs simply drop without creating an edge.
  for (const link of sourceObjectLinks) {
    for (const address of [link.sourceAddress, link.targetAddress]) {
      const normalized = normalizeProtocolAddress(address);
      if (normalized.outcome !== "valid" || nodeIdByAddress.has(`${normalized.type}:${normalized.id}`)) continue;
      unresolvedTargets.add(normalized.address);
    }
  }
  for (const { result } of adapterProjections) {
    for (const edge of result.edges) {
      const normalized = normalizeProtocolAddress(edge.to);
      if (normalized.outcome !== "valid") continue;
      if (normalized.type === "page" || nodeIdByAddress.has(`${normalized.type}:${normalized.id}`)) continue;
      unresolvedTargets.add(normalized.address);
    }
  }
  const targetsToResolve = [...unresolvedTargets].slice(0, OCCURRENCE_TARGET_RESOLVE_LIMIT);
  const resolvedByAddress = new Map<string, AddressResolution>();
  for (const batch of chunkValues(targetsToResolve, ADDRESS_RESOLUTION_BATCH_LIMIT)) {
    const results = await resolveAddressBatch(principal, batch);
    adapterQueryCount += 1;
    for (const result of results) {
      if ((result.outcome === "resolved" || result.outcome === "redirected") && result.resolution) {
        resolvedByAddress.set(result.requestedAddress, result.resolution);
      }
    }
  }
  for (const [requestedAddress, resolution] of resolvedByAddress) {
    // Register the node under the resolver's CANONICAL address (the survivor for
    // a redirected Person merge), then alias the requested address to that same
    // node so an edge targeting an absorbed address links to the survivor rather
    // than minting a duplicate absorbed-ID node. Honors invariant #6 (renames
    // change labels, not addresses; merges resolve through redirects).
    const canonical = normalizeProtocolAddress(resolution.address);
    if (canonical.outcome !== "valid") continue;
    if (isExcludedGraphNodeType(canonical.type)) continue;
    const canonicalKey = `${canonical.type}:${canonical.id}`;
    let nodeId = nodeIdByAddress.get(canonicalKey);
    if (nodeId === undefined) {
      nodeId = registerNode(canonicalKey, {
        id: nextSyntheticNodeId--,
        content: resolution.summary || resolution.label,
        title: resolution.label,
        summary: resolution.summary || undefined,
        layer: "long",
        source: sourceForAddressType(canonical.type),
        sourceId: canonical.id,
        tags: [canonical.type],
        graphed: true,
        metadata: { graphStorage: "vnext", nodeKind: "reference_target", entityType: canonical.type, entityId: canonical.id, reference: resolution.address, route: resolution.route },
        createdAt: null,
        updatedAt: resolution.updatedAt ?? null,
        recency: computeNodeRecency(resolution.updatedAt),
      });
    }
    const requested = normalizeProtocolAddress(requestedAddress);
    if (requested.outcome === "valid") {
      nodeIdByAddress.set(`${requested.type}:${requested.id}`, nodeId);
    }
  }

  // ---- Edge assembly ----
  const links: PersonalGraphLink[] = [];
  let nextSyntheticLinkId = -1_000_000;

  for (const link of claimLinks) {
    if (!visibleClaimIds.has(link.fromClaimId) || !visibleClaimIds.has(link.toClaimId)) continue;
    links.push({
      id: link.id,
      fromId: link.fromClaimId,
      toId: link.toClaimId,
      relationship: link.relationship,
      strength: link.strength,
      createdAt: serializeDate(link.createdAt),
      relationshipType: "claim_link",
    });
  }
  for (const ref of sourceRefs) {
    if (!visibleClaimIds.has(ref.claimId)) continue;
    const normalizedType = normalizeSourceRefType(ref.sourceType);
    const key = normalizedType === "page"
      ? `page:${pageById.get(ref.sourceId)?.id ?? ref.sourceId}`
      : `${normalizedType}:${ref.sourceId}`;
    const sourceNodeId = nodeIdByAddress.get(key);
    if (sourceNodeId === undefined) continue;
    links.push({
      id: nextSyntheticLinkId--,
      fromId: sourceNodeId,
      toId: ref.claimId,
      relationship: ref.relationship,
      strength: ref.strength,
      createdAt: serializeDate(ref.createdAt),
      relationshipType: "source_ref",
    });
  }
  for (const link of entityLinks) {
    if (!visibleClaimIds.has(link.claimId)) continue;
    const entityNodeId = nodeIdByAddress.get(`${link.entityType}:${link.entityId}`);
    if (entityNodeId === undefined) continue;
    links.push({
      id: nextSyntheticLinkId--,
      fromId: link.claimId,
      toId: entityNodeId,
      relationship: `mentions_${link.entityType}`,
      strength: 0.7,
      createdAt: serializeDate(link.createdAt),
      relationshipType: "entity_link",
    });
  }
  // Structural domain edges (project→goal, goal hierarchy, milestone→project,
  // task→project/milestone, meeting→attendee, etc.) are owned by domain adapters.
  // Each edge is admitted only when both canonical endpoints survived independent
  // principal-aware resolution. An edge can never grant visibility.
  let structuralLinkCount = 0;
  const adapterEdgeCounts = new Map<string, number>();
  for (const { id: adapterId, result } of adapterProjections) {
    for (const edge of result.edges) {
      const from = normalizeProtocolAddress(edge.from);
      const to = normalizeProtocolAddress(edge.to);
      if (from.outcome !== "valid" || to.outcome !== "valid") continue;
      const fromId = nodeIdByAddress.get(`${from.type}:${from.id}`);
      const toId = nodeIdByAddress.get(`${to.type}:${to.id}`);
      if (fromId === undefined || toId === undefined || fromId === toId) continue;
      links.push({
        id: nextSyntheticLinkId--,
        fromId,
        toId,
        relationship: edge.predicate,
        strength: edge.weight,
        createdAt: edge.updatedAt ?? null,
        relationshipType: `adapter:${adapterId}`,
      });
      structuralLinkCount++;
      adapterEdgeCounts.set(adapterId, (adapterEdgeCounts.get(adapterId) ?? 0) + 1);
    }
  }
  const meetingEdgeCount = adapterEdgeCounts.get(meetingGraphAdapter.id) ?? 0;
  const workEdgeCount = adapterEdgeCounts.get(workGraphAdapter.id) ?? 0;
  const relationshipEdgeCount = adapterEdgeCounts.get(relationshipGraphAdapter.id) ?? 0;
  const decisionStrategyEdgeCount = adapterEdgeCounts.get(decisionStrategyGraphAdapter.id) ?? 0;
  const executionProvenanceEdgeCount = adapterEdgeCounts.get(executionProvenanceGraphAdapter.id) ?? 0;
  // Authored page occurrence edges (page→page and page→resolved target). Never parses bodies.
  let occurrenceEdgeCount = 0;
  let canonicalOccurrenceEdgeCount = 0;
  let compatibilityOccurrenceEdgeCount = 0;
  const compatibilityOccurrenceSources = new Set<string>();
  for (const edge of authoredOccurrenceEdges) {
    const fromId = nodeIdByAddress.get(`page:${edge.sourcePageId}`);
    if (fromId === undefined) continue;
    const normalized = normalizeProtocolAddress(edge.targetAddress);
    if (normalized.outcome !== "valid") continue;
    const toId = nodeIdByAddress.get(`${normalized.type}:${normalized.id}`);
    if (toId === undefined || toId === fromId) continue;
    links.push({
      id: nextSyntheticLinkId--,
      fromId,
      toId,
      relationship: normalized.type === "page" ? "references" : `references_${normalized.type}`,
      strength: 0.6,
      createdAt: serializeDate(edge.observedAt),
      relationshipType: normalized.type === "page" ? "library_page_link" : "page_reference",
    });
    occurrenceEdgeCount++;
    if (edge.source === "compatibility") {
      compatibilityOccurrenceEdgeCount++;
      compatibilityOccurrenceSources.add(edge.sourcePageId);
    } else {
      canonicalOccurrenceEdgeCount++;
    }
  }

  let sourceObjectEdgeCount = 0;
  for (const link of sourceObjectLinks) {
    const from = normalizeProtocolAddress(link.sourceAddress);
    const to = normalizeProtocolAddress(link.targetAddress);
    if (from.outcome !== "valid" || to.outcome !== "valid") continue;
    const fromId = nodeIdByAddress.get(`${from.type}:${from.id}`);
    const toId = nodeIdByAddress.get(`${to.type}:${to.id}`);
    if (fromId === undefined || toId === undefined || fromId === toId) continue;
    links.push({
      id: nextSyntheticLinkId--,
      fromId,
      toId,
      relationship: link.linkKind === "explicit_reference" ? `references_${to.type}` : `mentions_${to.type}`,
      strength: link.confidence,
      createdAt: serializeDate(link.observedAt),
      relationshipType: `source_object:${link.linkKind}`,
    });
    sourceObjectEdgeCount++;
  }

  // ---- Bounded Tag layer (default-hidden semantic overlay) ----
  // Canonical Tag identities become graph nodes; each assignment to an
  // already-projected entity becomes a `tagged_with` edge, turning the shared
  // tag vocabulary into visible connective tissue. The server floors at the
  // definitional minimum (>= 1 projected connection — an edge never grants
  // visibility, and a zero-connection tag would be a floating orphan) and caps
  // by connection count to bound payload. Density policy — how many connections
  // a tag needs before it renders — is owned client-side by the Memory Graph
  // Mixer's Tag Degree Threshold, applied over each tag node's computed degree.
  // Best-effort: a tag-layer failure degrades to a graph without tags rather
  // than a failed read.
  let tagNodeCount = 0;
  let tagEdgeCount = 0;
  try {
    const TAG_MIN_ENTITIES = 1;
    const TAG_NODE_LIMIT = 200;
    const tagIndex = await tagService.getIndex(principal);
    const projectableTags = Object.values(tagIndex.tags)
      .map((tag) => {
        const targets = new Set<number>();
        for (const usage of tagIndex.usages[tag.slug] ?? []) {
          const targetId = nodeIdByAddress.get(`${usage.entityType}:${usage.entityId}`);
          if (targetId !== undefined) targets.add(targetId);
        }
        return { tag, targets };
      })
      .filter((candidate) => candidate.targets.size >= TAG_MIN_ENTITIES)
      .sort((left, right) => right.targets.size - left.targets.size)
      .slice(0, TAG_NODE_LIMIT);

    for (const { tag, targets } of projectableTags) {
      const tagNodeId = registerNode(`tag:${tag.slug}`, {
        id: nextSyntheticNodeId--,
        content: `Tag connecting ${targets.size} items`,
        title: tag.label,
        summary: `@tag:${tag.slug}`,
        layer: "long",
        source: "tag",
        sourceId: tag.slug,
        tags: [],
        graphed: true,
        metadata: {
          graphStorage: "vnext",
          nodeKind: "tag",
          slug: tag.slug,
          color: tag.color,
          connectionCount: targets.size,
          reference: `@tag:${tag.slug}`,
        },
        createdAt: serializeDate(tag.createdAt),
        updatedAt: serializeDate(tag.updatedAt),
        recency: computeNodeRecency(tag.createdAt, tag.updatedAt),
      });
      tagNodeCount++;
      for (const entityNodeId of targets) {
        links.push({
          id: nextSyntheticLinkId--,
          fromId: entityNodeId,
          toId: tagNodeId,
          relationship: "tagged_with",
          strength: 0.4,
          createdAt: serializeDate(tag.updatedAt),
          relationshipType: "tag_layer",
        });
        tagEdgeCount++;
      }
    }
  } catch (error) {
    log.warn(`[personal-graph] tag layer skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  const projection: PersonalGraphMetrics = {
    libraryFirst,
    assemblyMs: Date.now() - startedAt,
    nodeCount: entries.length,
    edgeCount: links.length,
    pageCount: visiblePages.length,
    fileCount: indexedFiles.length,
    claimCount: claims.length,
    occurrenceEdgeCount,
    canonicalOccurrenceEdgeCount,
    compatibilityOccurrenceEdgeCount,
    compatibilityOccurrenceSourceCount: compatibilityOccurrenceSources.size,
    unprojectedLibraryPageCount: occurrenceProjection.unprojectedPageCount,
    meetingEdgeCount,
    workEdgeCount,
    relationshipEdgeCount,
    decisionStrategyEdgeCount,
    executionProvenanceEdgeCount,
    sourceObjectEdgeCount,
    resolvedTargetCount: resolvedByAddress.size,
    adapterQueryCount,
    tagNodeCount,
    tagEdgeCount,
    payloadBytes: 0,
  };
  const response: PersonalGraphProjection = {
    storage: "memory_vnext",
    entries,
    links,
    linkSource: "claim_links",
    semantics: "personal-intelligence",
    projection,
  };
  projection.payloadBytes = Buffer.byteLength(JSON.stringify({ entries, links }), "utf8");

  log.info(
    `[personal-graph] libraryFirst=${libraryFirst} pages=${projection.pageCount} files=${projection.fileCount} claims=${projection.claimCount} ` +
      `nodes=${projection.nodeCount} edges=${projection.edgeCount} occurrenceEdges=${occurrenceEdgeCount} canonicalOccurrenceEdges=${projection.canonicalOccurrenceEdgeCount} compatibilityOccurrenceEdges=${projection.compatibilityOccurrenceEdgeCount} compatibilitySources=${projection.compatibilityOccurrenceSourceCount} unprojectedPages=${projection.unprojectedLibraryPageCount} ` +
      `meetingEdges=${projection.meetingEdgeCount} workEdges=${projection.workEdgeCount} relationshipEdges=${projection.relationshipEdgeCount} decisionStrategyEdges=${projection.decisionStrategyEdgeCount} executionProvenanceEdges=${projection.executionProvenanceEdgeCount} sourceObjectEdges=${projection.sourceObjectEdgeCount} structural=${structuralLinkCount} tagNodes=${projection.tagNodeCount} tagEdges=${projection.tagEdgeCount} resolvedTargets=${projection.resolvedTargetCount} ` +
      `adapterQueries=${projection.adapterQueryCount} payloadKB=${(projection.payloadBytes / 1024).toFixed(1)} assemblyMs=${projection.assemblyMs}`,
  );
  eventBus.publish({
    category: "memory",
    event: "personal_graph_projected",
    payload: {
      libraryFirst,
      assemblyMs: projection.assemblyMs,
      nodeCount: projection.nodeCount,
      edgeCount: projection.edgeCount,
      pageCount: projection.pageCount,
      fileCount: projection.fileCount,
      payloadBytes: projection.payloadBytes,
      adapterQueryCount: projection.adapterQueryCount,
      occurrenceEdgeCount: projection.occurrenceEdgeCount,
      canonicalOccurrenceEdgeCount: projection.canonicalOccurrenceEdgeCount,
      compatibilityOccurrenceEdgeCount: projection.compatibilityOccurrenceEdgeCount,
      compatibilityOccurrenceSourceCount: projection.compatibilityOccurrenceSourceCount,
      unprojectedLibraryPageCount: projection.unprojectedLibraryPageCount,
      meetingEdgeCount: projection.meetingEdgeCount,
      workEdgeCount: projection.workEdgeCount,
      relationshipEdgeCount: projection.relationshipEdgeCount,
      decisionStrategyEdgeCount: projection.decisionStrategyEdgeCount,
      executionProvenanceEdgeCount: projection.executionProvenanceEdgeCount,
      tagNodeCount: projection.tagNodeCount,
      tagEdgeCount: projection.tagEdgeCount,
      level: projection.assemblyMs > 750 ? "warn" : "info",
    },
  });

  return response;
}
