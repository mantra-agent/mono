import { createHash } from "crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  memoryVnextClaimLinkEvidence,
  memoryVnextClaimLinks,
  memoryVnextClaims,
  memoryVnextEntityLinks,
  memoryVnextSourceRefs,
  memoryVnextTransitionEdges,
  memoryVnextTransitionMembers,
  memoryVnextTransitionPaths,
  type MemoryVnextClaim,
  type MemoryVnextClaimLink,
  type MemoryVnextClaimLinkEvidence,
  type MemoryVnextEdgeEpistemicStatus,
  type MemoryVnextEdgeProducerKind,
  type MemoryVnextRelationship,
  type MemoryVnextRelationshipClass,
  type MemoryVnextTransitionEdge,
  type MemoryVnextTransitionMember,
  type MemoryVnextTransitionPath,
} from "@shared/schema";
import { db } from "../db";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";

const log = createLogger("MemoryVnextTransitions");
export const TRANSITION_DERIVATION_METHOD = "explicit_temporal_edge_transition";
export const TRANSITION_DERIVATION_VERSION = "v1";
const MAX_RECOMPUTE_CLAIMS = 250;
const MAX_RECOMPUTE_EDGES = 500;
const MAX_PATHS = 250;
const MAX_INSPECT_PATHS = 100;
const MAX_PROVENANCE_BYTES = 4_096;

const claimScope = { scope: memoryVnextClaims.scope, ownerUserId: memoryVnextClaims.ownerUserId, accountId: memoryVnextClaims.accountId };
const sourceScope = { scope: memoryVnextSourceRefs.scope, ownerUserId: memoryVnextSourceRefs.ownerUserId, accountId: memoryVnextSourceRefs.accountId };
const entityScope = { scope: memoryVnextEntityLinks.scope, ownerUserId: memoryVnextEntityLinks.ownerUserId, accountId: memoryVnextEntityLinks.accountId };
const linkScope = { scope: memoryVnextClaimLinks.scope, ownerUserId: memoryVnextClaimLinks.ownerUserId, accountId: memoryVnextClaimLinks.accountId };
const linkEvidenceScope = { scope: memoryVnextClaimLinkEvidence.scope, ownerUserId: memoryVnextClaimLinkEvidence.ownerUserId, accountId: memoryVnextClaimLinkEvidence.accountId };
const pathScope = { scope: memoryVnextTransitionPaths.scope, ownerUserId: memoryVnextTransitionPaths.ownerUserId, accountId: memoryVnextTransitionPaths.accountId };
const memberScope = { scope: memoryVnextTransitionMembers.scope, ownerUserId: memoryVnextTransitionMembers.ownerUserId, accountId: memoryVnextTransitionMembers.accountId };
const transitionEdgeScope = { scope: memoryVnextTransitionEdges.scope, ownerUserId: memoryVnextTransitionEdges.ownerUserId, accountId: memoryVnextTransitionEdges.accountId };

const RELATIONSHIP_CLASS: Record<MemoryVnextRelationship, Exclude<MemoryVnextRelationshipClass, "legacy">> = {
  equivalent_to: "semantic", similar_to: "semantic", qualifies: "semantic",
  supports: "evidence", contradicts: "evidence", supersedes: "evidence",
  precedes: "temporal", followed_by: "temporal", overlaps: "temporal",
  explains: "causal", contributed_to: "causal", caused: "causal", prevented: "causal", resulted_in: "causal",
  consolidates: "consolidation", duplicate_of: "consolidation",
};

export interface ClaimRelationshipInput {
  fromClaimId: number;
  toClaimId: number;
  relationship: MemoryVnextRelationship;
  certainty: number;
  producerKind: Exclude<MemoryVnextEdgeProducerKind, "legacy">;
  epistemicStatus: Exclude<MemoryVnextEdgeEpistemicStatus, "legacy_unassessed">;
  provenance: Record<string, unknown>;
  evidenceSourceRefIds: number[];
  replayKey: string;
  producerMethod?: string;
  derivationVersion?: string;
  strength?: number;
}

export interface VnextTransitionPathDetail {
  path: MemoryVnextTransitionPath;
  members: Array<MemoryVnextTransitionMember & { claim: MemoryVnextClaim }>;
  edges: Array<MemoryVnextTransitionEdge & { claimLink: MemoryVnextClaimLink; evidence: MemoryVnextClaimLinkEvidence[] }>;
}

function clamp01(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
  return value;
}

function boundedText(value: string, max: number, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized.slice(0, max);
}

function hashKey(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function claimTime(claim: MemoryVnextClaim): Date | null {
  return claim.occurredAt ?? claim.observedAt ?? claim.validFrom ?? null;
}

function normalizedTemporalDirection(link: MemoryVnextClaimLink): { beforeId: number; afterId: number } | null {
  if (link.relationship === "precedes") return { beforeId: link.fromClaimId, afterId: link.toClaimId };
  if (link.relationship === "followed_by") return { beforeId: link.toClaimId, afterId: link.fromClaimId };
  return null;
}

function validateRelationshipInput(input: ClaimRelationshipInput): void {
  if (input.fromClaimId === input.toClaimId) throw new Error("Claim relationship cannot link a claim to itself");
  clamp01(input.certainty, "Relationship certainty");
  if (RELATIONSHIP_CLASS[input.relationship] === "causal" && input.epistemicStatus !== "causal_hypothesis") {
    throw new Error("Causal relationships must remain explicit causal hypotheses");
  }
  if (input.evidenceSourceRefIds.length === 0) throw new Error("Canonical claim relationships require source evidence");
  if (input.producerKind === "derived" && (!input.producerMethod?.trim() || !input.derivationVersion?.trim())) {
    throw new Error("Derived claim relationships require producerMethod and derivationVersion");
  }
  if (Buffer.byteLength(JSON.stringify(input.provenance), "utf8") === 2) throw new Error("Relationship provenance cannot be empty");
  if (Buffer.byteLength(JSON.stringify(input.provenance), "utf8") > MAX_PROVENANCE_BYTES) throw new Error("Relationship provenance exceeds 4096 bytes");
  boundedText(input.replayKey, 300, "Relationship replayKey");
}

export async function upsertClaimRelationship(input: ClaimRelationshipInput): Promise<MemoryVnextClaimLink> {
  validateRelationshipInput(input);
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) throw new Error("Claim relationship mutation requires a user principal");
  const evidenceIds = [...new Set(input.evidenceSourceRefIds.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 20);
  if (evidenceIds.length === 0) throw new Error("Canonical claim relationships require valid source evidence IDs");
  const relationshipClass = RELATIONSHIP_CLASS[input.relationship];
  const edgeKey = hashKey([principal.userId, input.replayKey]);

  const link = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`memory-vnext-edge:${principal.userId}:${edgeKey}`}))`);
    const claims = await tx.select({ id: memoryVnextClaims.id }).from(memoryVnextClaims)
      .where(combineWithWritableScope(principal, claimScope, inArray(memoryVnextClaims.id, [input.fromClaimId, input.toClaimId])))
      .limit(2);
    if (new Set(claims.map((claim) => claim.id)).size !== 2) throw new Error("Claim relationship endpoints are not writable");
    const evidence = await tx.select({ id: memoryVnextSourceRefs.id, claimId: memoryVnextSourceRefs.claimId }).from(memoryVnextSourceRefs)
      .where(combineWithWritableScope(principal, sourceScope, inArray(memoryVnextSourceRefs.id, evidenceIds)))
      .limit(20);
    if (evidence.length !== evidenceIds.length || evidence.some((row) => row.claimId !== input.fromClaimId && row.claimId !== input.toClaimId)) {
      throw new Error("Relationship evidence must be writable source refs attached to an endpoint claim");
    }
    const strength = input.strength == null ? input.certainty : clamp01(input.strength, "Legacy relationship strength");
    const [stored] = await tx.insert(memoryVnextClaimLinks).values({
      fromClaimId: input.fromClaimId,
      toClaimId: input.toClaimId,
      relationship: input.relationship,
      relationshipClass,
      producerKind: input.producerKind,
      epistemicStatus: input.epistemicStatus,
      edgeKey,
      strength,
      certainty: input.certainty,
      producerMethod: input.producerMethod?.trim().slice(0, 120) || null,
      derivationVersion: input.derivationVersion?.trim().slice(0, 80) || null,
      provenance: input.provenance,
      ...ownedInsertValues(principal, linkScope),
      createdByUserId: principal.userId,
      updatedByUserId: principal.userId,
    }).onConflictDoUpdate({
      target: [memoryVnextClaimLinks.fromClaimId, memoryVnextClaimLinks.toClaimId, memoryVnextClaimLinks.relationship],
      set: {
        relationshipClass,
        producerKind: input.producerKind,
        epistemicStatus: input.epistemicStatus,
        edgeKey,
        strength,
        certainty: input.certainty,
        producerMethod: input.producerMethod?.trim().slice(0, 120) || null,
        derivationVersion: input.derivationVersion?.trim().slice(0, 80) || null,
        provenance: input.provenance,
        updatedByUserId: principal.userId,
      },
    }).returning();
    if (!stored) throw new Error("Claim relationship upsert failed");
    for (const sourceRefId of evidenceIds) {
      await tx.insert(memoryVnextClaimLinkEvidence).values({
        claimLinkId: stored.id,
        sourceRefId,
        role: "basis",
        ...ownedInsertValues(principal, linkEvidenceScope),
        createdByUserId: principal.userId,
      }).onConflictDoNothing();
    }
    return stored;
  });

  log.info(JSON.stringify({
    event: "memory.vnext.claim_relationship_upserted",
    linkId: link.id,
    fromClaimId: input.fromClaimId,
    toClaimId: input.toClaimId,
    relationship: input.relationship,
    relationshipClass,
    producerKind: input.producerKind,
    epistemicStatus: input.epistemicStatus,
    evidenceCount: evidenceIds.length,
  }));
  return link;
}

export async function listClaimLinkEvidence(linkIds: number[]): Promise<MemoryVnextClaimLinkEvidence[]> {
  const ids = [...new Set(linkIds.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 500);
  if (ids.length === 0) return [];
  return db.select().from(memoryVnextClaimLinkEvidence)
    .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), linkEvidenceScope, inArray(memoryVnextClaimLinkEvidence.claimLinkId, ids)))
    .orderBy(asc(memoryVnextClaimLinkEvidence.claimLinkId), asc(memoryVnextClaimLinkEvidence.id));
}

export async function recomputeTransitionPaths(limit = MAX_RECOMPUTE_CLAIMS): Promise<{ scannedClaims: number; scannedEdges: number; paths: number; causalHypotheses: number; staleRemoved: number }> {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) throw new Error("Transition recompute requires a user principal");
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), MAX_RECOMPUTE_CLAIMS);
  const claims = await db.select().from(memoryVnextClaims)
    .where(combineWithWritableScope(principal, claimScope, sql`${memoryVnextClaims.lifecycleStage} <> 'retired'`))
    .orderBy(asc(memoryVnextClaims.id)).limit(boundedLimit);
  const claimIds = claims.map((claim) => claim.id);
  if (claimIds.length === 0) return { scannedClaims: 0, scannedEdges: 0, paths: 0, causalHypotheses: 0, staleRemoved: 0 };
  const [links, entities, sources] = await Promise.all([
    db.select().from(memoryVnextClaimLinks).where(combineWithWritableScope(principal, linkScope, and(
      inArray(memoryVnextClaimLinks.fromClaimId, claimIds), inArray(memoryVnextClaimLinks.toClaimId, claimIds),
      inArray(memoryVnextClaimLinks.relationshipClass, ["temporal", "causal"]),
    ))).orderBy(asc(memoryVnextClaimLinks.id)).limit(MAX_RECOMPUTE_EDGES),
    db.select().from(memoryVnextEntityLinks).where(combineWithWritableScope(principal, entityScope, inArray(memoryVnextEntityLinks.claimId, claimIds))),
    db.select().from(memoryVnextSourceRefs).where(combineWithWritableScope(principal, sourceScope, inArray(memoryVnextSourceRefs.claimId, claimIds))),
  ]);
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const entityByClaim = new Map<number, string[]>();
  for (const entity of entities) entityByClaim.set(entity.claimId, [...(entityByClaim.get(entity.claimId) ?? []), `${entity.entityType}:${entity.entityId}`]);
  const contextByClaim = new Map<number, string[]>();
  for (const source of sources) {
    const values = [`${source.sourceType}:${source.sourceId}`, ...(source.context.trim() ? [source.context.trim().slice(0, 300)] : [])];
    contextByClaim.set(source.claimId, [...(contextByClaim.get(source.claimId) ?? []), ...values]);
  }
  const linkEvidence = await listClaimLinkEvidence(links.map((link) => link.id));
  const evidenceBackedLinkIds = new Set(linkEvidence.map((row) => row.claimLinkId));
  const temporal = links.flatMap((link) => {
    const direction = normalizedTemporalDirection(link);
    return direction && evidenceBackedLinkIds.has(link.id) ? [{ link, ...direction }] : [];
  });
  const priorToAction = temporal.filter(({ beforeId, afterId }) => claimById.get(beforeId)?.claimType === "state" && claimById.get(afterId)?.claimType === "action");
  const actionToLater = temporal.filter(({ beforeId, afterId }) => claimById.get(beforeId)?.claimType === "action" && claimById.get(afterId)?.claimType === "state");
  const causalLinks = links.filter((link) => link.relationshipClass === "causal" && link.epistemicStatus === "causal_hypothesis" && link.certainty != null && evidenceBackedLinkIds.has(link.id));
  const candidates: Array<{
    key: string; status: "observed_transition" | "causal_hypothesis"; certainty: number; elapsedSeconds: number | null;
    memberRows: Array<{ claimId: number; role: "prior_state" | "action" | "mechanism" | "later_state"; ordinal: number }>;
    edgeRows: Array<{ claimLinkId: number; role: "prior_to_action" | "action_to_later" | "mechanism_evidence" }>;
    contextKeys: string[]; entityKeys: string[];
  }> = [];
  for (const first of priorToAction) {
    for (const second of actionToLater) {
      if (first.afterId !== second.beforeId || first.beforeId === second.afterId) continue;
      const prior = claimById.get(first.beforeId)!;
      const action = claimById.get(first.afterId)!;
      const later = claimById.get(second.afterId)!;
      const mechanismEdge = causalLinks.find((edge) => {
        const other = edge.fromClaimId === action.id || edge.fromClaimId === later.id ? edge.toClaimId
          : edge.toClaimId === action.id || edge.toClaimId === later.id ? edge.fromClaimId : null;
        return other != null && claimById.get(other)?.claimType === "cause";
      });
      const mechanismId = mechanismEdge
        ? [mechanismEdge.fromClaimId, mechanismEdge.toClaimId].find((id) => claimById.get(id)?.claimType === "cause") ?? null
        : null;
      const priorTime = claimTime(prior);
      const laterTime = claimTime(later);
      const elapsedSeconds = priorTime && laterTime ? Math.max(0, Math.floor((laterTime.getTime() - priorTime.getTime()) / 1_000)) : null;
      const status = mechanismId ? "causal_hypothesis" as const : "observed_transition" as const;
      const certainty = Math.min(first.link.certainty ?? 0, second.link.certainty ?? 0, mechanismEdge?.certainty ?? 1);
      const ids = [prior.id, action.id, ...(mechanismId ? [mechanismId] : []), later.id];
      candidates.push({
        key: hashKey([TRANSITION_DERIVATION_METHOD, TRANSITION_DERIVATION_VERSION, ...ids, first.link.id, second.link.id, mechanismEdge?.id ?? 0]),
        status,
        certainty,
        elapsedSeconds,
        memberRows: [
          { claimId: prior.id, role: "prior_state", ordinal: 0 },
          { claimId: action.id, role: "action", ordinal: 0 },
          ...(mechanismId ? [{ claimId: mechanismId, role: "mechanism" as const, ordinal: 0 }] : []),
          { claimId: later.id, role: "later_state", ordinal: 0 },
        ],
        edgeRows: [
          { claimLinkId: first.link.id, role: "prior_to_action" },
          { claimLinkId: second.link.id, role: "action_to_later" },
          ...(mechanismEdge ? [{ claimLinkId: mechanismEdge.id, role: "mechanism_evidence" as const }] : []),
        ],
        contextKeys: [...new Set(ids.flatMap((id) => contextByClaim.get(id) ?? []))].sort().slice(0, 50),
        entityKeys: [...new Set(ids.flatMap((id) => entityByClaim.get(id) ?? []))].sort().slice(0, 50),
      });
      if (candidates.length >= MAX_PATHS) break;
    }
    if (candidates.length >= MAX_PATHS) break;
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`memory-vnext-transitions:${principal.userId}`}))`);
    const currentKeys: string[] = [];
    for (const candidate of candidates) {
      currentKeys.push(candidate.key);
      const [path] = await tx.insert(memoryVnextTransitionPaths).values({
        derivationKey: candidate.key,
        status: candidate.status,
        certainty: candidate.certainty,
        elapsedSeconds: candidate.elapsedSeconds,
        contextKeys: candidate.contextKeys,
        entityKeys: candidate.entityKeys,
        producerMethod: TRANSITION_DERIVATION_METHOD,
        derivationVersion: TRANSITION_DERIVATION_VERSION,
        evidence: { temporalOrderOnly: candidate.status === "observed_transition", causalTruthNotEstablished: true },
        ...ownedInsertValues(principal, pathScope),
        createdByUserId: principal.userId,
        updatedByUserId: principal.userId,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [memoryVnextTransitionPaths.ownerUserId, memoryVnextTransitionPaths.accountId, memoryVnextTransitionPaths.derivationKey],
        set: {
          status: candidate.status, certainty: candidate.certainty, elapsedSeconds: candidate.elapsedSeconds,
          contextKeys: candidate.contextKeys, entityKeys: candidate.entityKeys,
          evidence: { temporalOrderOnly: candidate.status === "observed_transition", causalTruthNotEstablished: true },
          updatedByUserId: principal.userId, updatedAt: new Date(),
        },
      }).returning();
      await tx.delete(memoryVnextTransitionMembers).where(combineWithWritableScope(principal, memberScope, eq(memoryVnextTransitionMembers.transitionPathId, path.id)));
      await tx.delete(memoryVnextTransitionEdges).where(combineWithWritableScope(principal, transitionEdgeScope, eq(memoryVnextTransitionEdges.transitionPathId, path.id)));
      if (candidate.memberRows.length > 0) await tx.insert(memoryVnextTransitionMembers).values(candidate.memberRows.map((member) => ({
        transitionPathId: path.id, ...member, ...ownedInsertValues(principal, memberScope), createdByUserId: principal.userId,
      })));
      if (candidate.edgeRows.length > 0) await tx.insert(memoryVnextTransitionEdges).values(candidate.edgeRows.map((edge) => ({
        transitionPathId: path.id, ...edge, ...ownedInsertValues(principal, transitionEdgeScope), createdByUserId: principal.userId,
      })));
    }
    const stalePredicate = currentKeys.length > 0
      ? sql`${memoryVnextTransitionPaths.derivationKey} <> ALL(${currentKeys}::text[])`
      : sql`TRUE`;
    const stale = await tx.delete(memoryVnextTransitionPaths).where(combineWithWritableScope(principal, pathScope, and(
      eq(memoryVnextTransitionPaths.producerMethod, TRANSITION_DERIVATION_METHOD),
      eq(memoryVnextTransitionPaths.derivationVersion, TRANSITION_DERIVATION_VERSION),
      stalePredicate,
    ))).returning({ id: memoryVnextTransitionPaths.id });
    return { staleRemoved: stale.length };
  });

  const summary = {
    scannedClaims: claims.length,
    scannedEdges: links.length,
    paths: candidates.length,
    causalHypotheses: candidates.filter((candidate) => candidate.status === "causal_hypothesis").length,
    staleRemoved: result.staleRemoved,
  };
  log.info(JSON.stringify({ event: "memory.vnext.transition_paths_recomputed", ...summary }));
  return summary;
}

export async function inspectTransitionPaths(input: { claimId?: number; pathId?: number; limit?: number } = {}): Promise<VnextTransitionPathDetail[]> {
  const principal = getCurrentPrincipalOrSystem();
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 25), 1), MAX_INSPECT_PATHS);
  let pathIds: number[] | null = null;
  if (input.claimId) {
    const rows = await db.select({ pathId: memoryVnextTransitionMembers.transitionPathId }).from(memoryVnextTransitionMembers)
      .where(combineWithVisibleScope(principal, memberScope, eq(memoryVnextTransitionMembers.claimId, input.claimId))).limit(limit);
    pathIds = [...new Set(rows.map((row) => row.pathId))];
    if (pathIds.length === 0) return [];
  } else if (input.pathId) {
    pathIds = [input.pathId];
  }
  const pathPredicate = pathIds ? inArray(memoryVnextTransitionPaths.id, pathIds) : sql`TRUE`;
  const paths = await db.select().from(memoryVnextTransitionPaths)
    .where(combineWithVisibleScope(principal, pathScope, pathPredicate))
    .orderBy(asc(memoryVnextTransitionPaths.id)).limit(limit);
  if (paths.length === 0) return [];
  const selectedPathIds = paths.map((path) => path.id);
  const [members, transitionEdges] = await Promise.all([
    db.select().from(memoryVnextTransitionMembers).where(combineWithVisibleScope(principal, memberScope, inArray(memoryVnextTransitionMembers.transitionPathId, selectedPathIds))).orderBy(asc(memoryVnextTransitionMembers.transitionPathId), asc(memoryVnextTransitionMembers.ordinal)),
    db.select().from(memoryVnextTransitionEdges).where(combineWithVisibleScope(principal, transitionEdgeScope, inArray(memoryVnextTransitionEdges.transitionPathId, selectedPathIds))).orderBy(asc(memoryVnextTransitionEdges.transitionPathId), asc(memoryVnextTransitionEdges.id)),
  ]);
  const claimIds = [...new Set(members.map((member) => member.claimId))];
  const linkIds = [...new Set(transitionEdges.map((edge) => edge.claimLinkId))];
  const [claims, links, evidence] = await Promise.all([
    claimIds.length ? db.select().from(memoryVnextClaims).where(combineWithVisibleScope(principal, claimScope, inArray(memoryVnextClaims.id, claimIds))) : [],
    linkIds.length ? db.select().from(memoryVnextClaimLinks).where(combineWithVisibleScope(principal, linkScope, inArray(memoryVnextClaimLinks.id, linkIds))) : [],
    listClaimLinkEvidence(linkIds),
  ]);
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const linkById = new Map(links.map((link) => [link.id, link]));
  return paths.map((path) => ({
    path,
    members: members.filter((member) => member.transitionPathId === path.id).flatMap((member) => {
      const claim = claimById.get(member.claimId);
      return claim ? [{ ...member, claim }] : [];
    }),
    edges: transitionEdges.filter((edge) => edge.transitionPathId === path.id).flatMap((edge) => {
      const claimLink = linkById.get(edge.claimLinkId);
      return claimLink ? [{ ...edge, claimLink, evidence: evidence.filter((item) => item.claimLinkId === edge.claimLinkId) }] : [];
    }),
  }));
}
