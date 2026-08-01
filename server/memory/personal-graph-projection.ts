import { desc, inArray, or, sql } from "drizzle-orm";
import {
  MEMORY_VNEXT_LIFECYCLE_STAGE,
  memoryVnextClaims,
  memoryVnextClaimLinks,
  memoryVnextEntityLinks,
  memoryVnextSourceRefs,
  type Goal,
} from "@shared/schema";
import { libraryPages } from "@shared/models/info";
import { normalizeProtocolAddress } from "@shared/life-addressing";
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
import { peopleStorage } from "../people-storage";
import { companyStorage } from "../company-storage";
import { goalsService } from "../goals-service";
import { fileProjectStorage } from "../file-storage/projects";
import { chatFileStorage } from "../chat-file-storage";
import { listMeetingGraphRecords, type MeetingIndexRecord } from "../meetings/meeting-index";

const log = createLogger("PersonalGraphProjection");

const RECENCY_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const CLAIM_LINK_BATCH_SIZE = 500;
const ENTITY_READ_BATCH_SIZE = 10;
/** Whole-corpus page seed ceiling; bounds payload, never gated on corpus size beyond this. */
const PERSONAL_GRAPH_PAGE_LIMIT = 5_000;
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
  claimCount: number;
  occurrenceEdgeCount: number;
  resolvedTargetCount: number;
  adapterQueryCount: number;
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

/** Map a canonical address type to the client node `source` vocabulary. */
function sourceForAddressType(type: string): string {
  switch (type) {
    case "page":
      return "page";
    case "meeting":
      return "meeting";
    case "session":
      return "session";
    default:
      return type;
  }
}

/**
 * Bounded, Library-first personal graph assembly. Seeds every principal-visible live
 * Library page (including isolated pages), aggregates authored occurrence edges,
 * resolves referenced targets through independently authorized domain adapters, then
 * overlays vNext semantic claims and selected strong domain facts. Foreground reads
 * never parse page bodies. Query count is bounded by the adapter set, not corpus size.
 */
export async function assemblePersonalGraph(principal: Principal): Promise<PersonalGraphProjection> {
  const startedAt = Date.now();
  const libraryFirst = libraryFirstGraphEnabled();
  let adapterQueryCount = 0;

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
  const pageScope = {
    ownerUserId: libraryPages.ownerUserId,
    accountId: libraryPages.accountId,
    scope: libraryPages.scope,
    vaultId: libraryPages.vaultId,
  };

  // Base seed: every visible live Library page (slim metadata only) plus vNext claims,
  // current work, meetings, and the whole-corpus authored occurrence edges. One query
  // per adapter; none scales with corpus size beyond its bounded row limit.
  const [visiblePages, claims, currentGoalIndex, currentProjects, meetingRecords, occurrenceEdges] =
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
      getLibraryCorpusOccurrenceEdges(principal, LIBRARY_REFERENCE_NEIGHBORHOOD_LIMIT),
    ]);
  adapterQueryCount += 6;

  const currentGoalIds = currentGoalIndex.filter((goal) => goal.status !== "achieved").map((goal) => goal.id);
  const currentGoals: Goal[] = [];
  for (const batch of chunkValues(currentGoalIds, ENTITY_READ_BATCH_SIZE)) {
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
  for (const meeting of meetingRecords) {
    for (const participant of meeting.participants) {
      if (!participant.personId) continue;
      const key = `person:${participant.personId}`;
      if (participant.name && !entityTitleByKey.has(key)) entityTitleByKey.set(key, participant.name);
      if (participant.profileSummary && !entitySummaryByKey.has(key)) entitySummaryByKey.set(key, participant.profileSummary);
    }
  }

  // Session source nodes (pages are all seeded; sessions are loaded only when cited).
  const sourceSessionIds = [...new Set(sourceRefs.filter((ref) => ref.sourceType === "session").map((ref) => ref.sourceId))];
  const sessionBatches: Array<Awaited<ReturnType<typeof chatFileStorage.getSession>>> = [];
  for (const batch of chunkValues(sourceSessionIds)) sessionBatches.push(...await chatFileStorage.getSessions(batch));
  const sourceSessionById = new Map(
    sessionBatches
      .filter((session) => session !== undefined && sourceSessionIds.includes(session.id) && session.sessionType !== "agent" && session.sessionType !== "autonomous")
      .map((session) => [session!.id, session!]),
  );

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

  function ensureEntityNode(entityType: string, entityId: string, fallbackTimestamp?: Date | string | null): number {
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
  for (const goal of currentGoals) ensureEntityNode("goal", goal.id, goal.updatedAt);
  for (const project of currentProjectRows) ensureEntityNode("project", String(project.id), project.updatedAt);

  // Meeting nodes and attendees; a session:<id> alias routes provenance to the meeting.
  function ensureMeetingNode(meeting: MeetingIndexRecord): number {
    const key = `meeting:${meeting.id}`;
    const existing = nodeIdByAddress.get(key);
    if (existing !== undefined) return existing;
    const attendeeNames = meeting.participants.map((p) => p.name).filter(Boolean);
    const attendeeSummary = attendeeNames.length > 0 ? `Meeting · ${attendeeNames.join(", ")}` : "Meeting";
    const nodeId = registerNode(key, {
      id: nextSyntheticNodeId--,
      content: meeting.summary || attendeeSummary,
      title: meeting.title,
      summary: meeting.summary || attendeeSummary,
      layer: "long",
      source: "meeting",
      sourceId: meeting.id,
      tags: ["meeting"],
      graphed: true,
      metadata: { graphStorage: "vnext", nodeKind: "meeting", reference: `@meeting:${meeting.id}`, botStatus: meeting.botStatus, transcriptCount: meeting.transcriptCount },
      createdAt: serializeDate(meeting.startedAt),
      updatedAt: serializeDate(meeting.endedAt || meeting.startedAt),
      recency: computeNodeRecency(meeting.startedAt, meeting.endedAt),
    });
    nodeIdByAddress.set(`session:${meeting.id}`, nodeId);
    return nodeId;
  }
  for (const meeting of meetingRecords) {
    ensureMeetingNode(meeting);
    for (const participant of meeting.participants) {
      if (!participant.personId) continue;
      ensureEntityNode("person", participant.personId, meeting.endedAt || meeting.startedAt);
    }
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
  for (const ref of sourceRefs) {
    if (!visibleClaimIds.has(ref.claimId)) continue;
    if (ref.sourceType === "session") ensureSessionNode(ref.sourceId, ref.createdAt);
  }

  // Resolve distinct non-page occurrence targets through independently authorized
  // adapters so a page can link to a person/goal/etc. even if nothing else cites it.
  const unresolvedTargets = new Set<string>();
  for (const edge of occurrenceEdges) {
    const normalized = normalizeProtocolAddress(edge.targetAddress);
    if (normalized.outcome !== "valid") continue;
    const key = `${normalized.type}:${normalized.id}`;
    if (normalized.type === "page") continue; // pages already seeded
    if (nodeIdByAddress.has(key)) continue;
    unresolvedTargets.add(edge.targetAddress);
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
  for (const [address, resolution] of resolvedByAddress) {
    const normalized = normalizeProtocolAddress(address);
    if (normalized.outcome !== "valid") continue;
    const key = `${normalized.type}:${normalized.id}`;
    if (nodeIdByAddress.has(key)) continue;
    registerNode(key, {
      id: nextSyntheticNodeId--,
      content: resolution.summary || resolution.label,
      title: resolution.label,
      summary: resolution.summary || undefined,
      layer: "long",
      source: sourceForAddressType(normalized.type),
      sourceId: normalized.id,
      tags: [normalized.type],
      graphed: true,
      metadata: { graphStorage: "vnext", nodeKind: "reference_target", entityType: normalized.type, entityId: normalized.id, reference: address, route: resolution.route },
      createdAt: null,
      updatedAt: resolution.updatedAt ?? null,
      recency: computeNodeRecency(resolution.updatedAt),
    });
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
    const normalizedType = ref.sourceType === "library_page" || ref.sourceType === "library" ? "page" : ref.sourceType;
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
  // Structural domain edges: project→goal, meeting→attendee.
  let structuralLinkCount = 0;
  for (const project of currentProjectRows) {
    if (!project.goalId) continue;
    const fromId = nodeIdByAddress.get(`project:${project.id}`);
    const toId = nodeIdByAddress.get(`goal:${project.goalId}`);
    if (fromId === undefined || toId === undefined) continue;
    links.push({ id: nextSyntheticLinkId--, fromId, toId, relationship: "pursues_goal", strength: 1, createdAt: serializeDate(project.updatedAt), relationshipType: "project_goal" });
    structuralLinkCount++;
  }
  for (const meeting of meetingRecords) {
    const fromId = nodeIdByAddress.get(`meeting:${meeting.id}`);
    if (fromId === undefined) continue;
    const seenAttendee = new Set<string>();
    for (const participant of meeting.participants) {
      if (!participant.personId || seenAttendee.has(participant.personId)) continue;
      seenAttendee.add(participant.personId);
      const toId = nodeIdByAddress.get(`person:${participant.personId}`);
      if (toId === undefined) continue;
      links.push({ id: nextSyntheticLinkId--, fromId, toId, relationship: "has_attendee", strength: 1, createdAt: serializeDate(meeting.endedAt || meeting.startedAt), relationshipType: "meeting_attendee" });
      structuralLinkCount++;
    }
  }
  // Authored page occurrence edges (page→page and page→resolved target). Never parses bodies.
  let occurrenceEdgeCount = 0;
  for (const edge of occurrenceEdges) {
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
  }

  const projection: PersonalGraphMetrics = {
    libraryFirst,
    assemblyMs: Date.now() - startedAt,
    nodeCount: entries.length,
    edgeCount: links.length,
    pageCount: visiblePages.length,
    claimCount: claims.length,
    occurrenceEdgeCount,
    resolvedTargetCount: resolvedByAddress.size,
    adapterQueryCount,
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
    `[personal-graph] libraryFirst=${libraryFirst} pages=${projection.pageCount} claims=${projection.claimCount} ` +
      `nodes=${projection.nodeCount} edges=${projection.edgeCount} occurrenceEdges=${occurrenceEdgeCount} ` +
      `structural=${structuralLinkCount} resolvedTargets=${projection.resolvedTargetCount} ` +
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
      payloadBytes: projection.payloadBytes,
      adapterQueryCount: projection.adapterQueryCount,
      level: projection.assemblyMs > 750 ? "warn" : "info",
    },
  });

  return response;
}
