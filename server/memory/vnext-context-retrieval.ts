import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import type {
  MemoryVnextClaim,
  MemoryVnextClaimLink,
  MemoryVnextSourceRef,
} from "@shared/schema";
import {
  MEMORY_VNEXT_LIFECYCLE_STAGE,
  memoryVnextClaimLinks,
  memoryVnextClaims,
  memoryVnextSourceRefs,
} from "@shared/schema";
import { db } from "../db";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope } from "../scoped-storage";
import type { BlendWeights } from "./vnext-retrieval-policy";
import { generateEmbedding } from "./embedding";
import { executeVnextClaimSemanticSearch } from "./vnext-claim-storage";

const log = createLogger("MemoryVnextContext");

const MAX_SEMANTIC_SEEDS = 80;
const RECENCY_SEED_COUNT = 5;
const MAX_RESULTS = 25;
const MAX_GRAPH_DEPTH = 2;
const MAX_GRAPH_FRONTIER = 80;
const GRAPH_MIN_SCORE = 0.2;

const claimScopeColumns = {
  scope: memoryVnextClaims.scope,
  ownerUserId: memoryVnextClaims.ownerUserId,
  accountId: memoryVnextClaims.accountId,
};

const linkScopeColumns = {
  scope: memoryVnextClaimLinks.scope,
  ownerUserId: memoryVnextClaimLinks.ownerUserId,
  accountId: memoryVnextClaimLinks.accountId,
};

const sourceScopeColumns = {
  scope: memoryVnextSourceRefs.scope,
  ownerUserId: memoryVnextSourceRefs.ownerUserId,
  accountId: memoryVnextSourceRefs.accountId,
};

export interface VnextContextCandidate {
  claim: MemoryVnextClaim;
  score: number;
  paths: string[];
  sourceRefs: MemoryVnextSourceRef[];
}

export interface VnextContextRetrievalResult {
  candidates: VnextContextCandidate[];
  semanticSeedCount: number;
  recentSeedCount: number;
  expandedCount: number;
}

interface CandidateSignals {
  semantic: number;
  recency: number;
  causal: number;
  contrastive: number;
  temporal: number;
  paths: Set<string>;
}

function activePredicate() {
  return sql`${memoryVnextClaims.lifecycleStage} <> ${MEMORY_VNEXT_LIFECYCLE_STAGE.RETIRED}`;
}

function lifecycleBoost(stage: string): number {
  if (stage === "canonical") return 1.18;
  if (stage === "linked") return 1.1;
  if (stage === "sourced") return 1.03;
  return 0.94;
}

function claimTypeBoost(type: string): number {
  if (type === "cause") return 1.12;
  if (type === "action") return 1.07;
  return 1;
}

function relationshipSignal(relationship: string): "causal" | "contrastive" | "semantic" {
  const normalized = relationship.toLowerCase();
  if (["causes", "caused_by", "supports", "derived_from", "leads_to"].includes(normalized)) return "causal";
  if (["contradicts", "supersedes", "evolves", "replaces"].includes(normalized)) return "contrastive";
  return "semantic";
}

function recencyScore(createdAt: Date): number {
  const ageDays = Math.max(0, (Date.now() - createdAt.getTime()) / 86_400_000);
  return 1 / (1 + ageDays / 30);
}

function temporalScore(claim: MemoryVnextClaim, seedDates: Date[]): number {
  if (seedDates.length === 0) return 0;
  const closestDays = Math.min(...seedDates.map((date) => Math.abs(date.getTime() - claim.createdAt.getTime()) / 86_400_000));
  return closestDays <= 3 ? 1 / (1 + closestDays) : 0;
}

function scoreCandidate(
  claim: MemoryVnextClaim,
  signals: CandidateSignals,
  weights: BlendWeights,
  sourceRefs: MemoryVnextSourceRef[],
  linkCount: number,
): number {
  const base =
    weights.semantic * Math.max(signals.semantic, signals.recency * 0.65) +
    weights.causal * signals.causal +
    weights.contrastive * signals.contrastive +
    weights.temporal * signals.temporal;
  const provenanceBoost = sourceRefs.length > 0 ? 1.08 : 0.96;
  const reinforcementBoost = 1 + Math.min(Math.log1p(claim.recallCount) * 0.025, 0.12);
  const connectivityBoost = 1 + Math.min(linkCount * 0.015, 0.1);
  const confidenceBoost = 0.72 + Math.max(0, Math.min(1, claim.confidence)) * 0.38;
  return Math.min(1, base * lifecycleBoost(claim.lifecycleStage) * claimTypeBoost(claim.claimType)
    * provenanceBoost * reinforcementBoost * connectivityBoost * confidenceBoost);
}

async function loadRecentClaims(): Promise<MemoryVnextClaim[]> {
  return db.select().from(memoryVnextClaims)
    .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), claimScopeColumns, activePredicate()))
    .orderBy(desc(memoryVnextClaims.createdAt))
    .limit(RECENCY_SEED_COUNT);
}

async function loadClaims(ids: number[]): Promise<MemoryVnextClaim[]> {
  if (ids.length === 0) return [];
  return db.select().from(memoryVnextClaims)
    .where(combineWithVisibleScope(
      getCurrentPrincipalOrSystem(),
      claimScopeColumns,
      and(inArray(memoryVnextClaims.id, ids), activePredicate()),
    ));
}

async function loadLinks(ids: number[]): Promise<MemoryVnextClaimLink[]> {
  if (ids.length === 0) return [];
  return db.select().from(memoryVnextClaimLinks)
    .where(combineWithVisibleScope(
      getCurrentPrincipalOrSystem(),
      linkScopeColumns,
      or(inArray(memoryVnextClaimLinks.fromClaimId, ids), inArray(memoryVnextClaimLinks.toClaimId, ids)),
    ))
    .limit(MAX_GRAPH_FRONTIER);
}

async function loadSourceRefs(ids: number[]): Promise<Map<number, MemoryVnextSourceRef[]>> {
  const result = new Map<number, MemoryVnextSourceRef[]>();
  if (ids.length === 0) return result;
  const rows = await db.select().from(memoryVnextSourceRefs)
    .where(combineWithVisibleScope(
      getCurrentPrincipalOrSystem(),
      sourceScopeColumns,
      inArray(memoryVnextSourceRefs.claimId, ids),
    ));
  for (const row of rows) {
    const refs = result.get(row.claimId) ?? [];
    refs.push(row);
    result.set(row.claimId, refs);
  }
  return result;
}

export async function retrieveVnextContext(
  focusText: string,
  weights: BlendWeights,
): Promise<VnextContextRetrievalResult> {
  const embedding = await generateEmbedding(focusText);
  const [semanticResults, recentClaims] = await Promise.all([
    executeVnextClaimSemanticSearch(embedding, MAX_SEMANTIC_SEEDS),
    loadRecentClaims(),
  ]);
  const activeSemantic = semanticResults.filter(({ row }) => row.lifecycleStage !== MEMORY_VNEXT_LIFECYCLE_STAGE.RETIRED);
  const claims = new Map<number, MemoryVnextClaim>();
  const signals = new Map<number, CandidateSignals>();
  const ensureSignals = (id: number): CandidateSignals => {
    const existing = signals.get(id);
    if (existing) return existing;
    const created = { semantic: 0, recency: 0, causal: 0, contrastive: 0, temporal: 0, paths: new Set<string>() };
    signals.set(id, created);
    return created;
  };

  for (const { row, similarity } of activeSemantic) {
    claims.set(row.id, row);
    const signal = ensureSignals(row.id);
    signal.semantic = Math.max(signal.semantic, similarity);
    signal.paths.add("semantic");
  }
  for (const claim of recentClaims) {
    claims.set(claim.id, claim);
    const signal = ensureSignals(claim.id);
    signal.recency = recencyScore(claim.createdAt);
    signal.paths.add("recent");
  }

  let frontier = Array.from(claims.keys()).slice(0, MAX_GRAPH_FRONTIER);
  const visited = new Set(frontier);
  const linkCounts = new Map<number, number>();
  for (let depth = 1; depth <= MAX_GRAPH_DEPTH && frontier.length > 0; depth++) {
    const links = await loadLinks(frontier);
    const nextIds: number[] = [];
    for (const link of links) {
      linkCounts.set(link.fromClaimId, (linkCounts.get(link.fromClaimId) ?? 0) + 1);
      linkCounts.set(link.toClaimId, (linkCounts.get(link.toClaimId) ?? 0) + 1);
      const fromFrontier = frontier.includes(link.fromClaimId);
      const neighborId = fromFrontier ? link.toClaimId : link.fromClaimId;
      const seedId = fromFrontier ? link.fromClaimId : link.toClaimId;
      const seedSignal = ensureSignals(seedId);
      const neighborSignal = ensureSignals(neighborId);
      const propagated = Math.max(seedSignal.semantic, seedSignal.recency, seedSignal.causal, seedSignal.contrastive)
        * Math.max(0, Math.min(1, link.strength)) * (depth === 1 ? 0.9 : 0.65);
      const kind = relationshipSignal(link.relationship);
      neighborSignal[kind] = Math.max(neighborSignal[kind], propagated);
      neighborSignal.paths.add(`${kind}:${link.relationship}`);
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        nextIds.push(neighborId);
      }
    }
    const loaded = await loadClaims(nextIds);
    for (const claim of loaded) claims.set(claim.id, claim);
    frontier = loaded.map((claim) => claim.id).slice(0, MAX_GRAPH_FRONTIER);
  }

  const seedDates = [...activeSemantic.slice(0, 5).map(({ row }) => row.createdAt), ...recentClaims.map((claim) => claim.createdAt)];
  for (const claim of claims.values()) {
    const signal = ensureSignals(claim.id);
    signal.temporal = temporalScore(claim, seedDates);
    if (signal.temporal > 0) signal.paths.add("temporal");
  }

  const sourceRefs = await loadSourceRefs(Array.from(claims.keys()));
  const scored = Array.from(claims.values()).map((claim) => ({
    claim,
    score: scoreCandidate(claim, ensureSignals(claim.id), weights, sourceRefs.get(claim.id) ?? [], linkCounts.get(claim.id) ?? 0),
    paths: Array.from(ensureSignals(claim.id).paths),
    sourceRefs: sourceRefs.get(claim.id) ?? [],
  })).filter((candidate) => candidate.score >= GRAPH_MIN_SCORE);

  const semanticPool = scored.filter(({ claim }) => ensureSignals(claim.id).semantic > 0).sort((a, b) => b.score - a.score);
  const recentGraphPool = scored.filter(({ claim }) => ensureSignals(claim.id).semantic === 0).sort((a, b) => b.score - a.score);
  const half = Math.floor(MAX_RESULTS / 2);
  const selected = [...semanticPool.slice(0, half), ...recentGraphPool.slice(0, half)];
  const selectedIds = new Set(selected.map(({ claim }) => claim.id));
  const overflow = [...semanticPool.slice(half), ...recentGraphPool.slice(half)]
    .filter(({ claim }) => !selectedIds.has(claim.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS - selected.length);
  const candidates = [...selected, ...overflow].sort((a, b) => b.score - a.score);

  log.debug(JSON.stringify({
    event: "memory.vnext.context_retrieved",
    semanticSeeds: activeSemantic.length,
    recentSeeds: recentClaims.length,
    expandedClaims: Math.max(0, claims.size - activeSemantic.length - recentClaims.length),
    candidates: candidates.length,
  }));
  return {
    candidates,
    semanticSeedCount: activeSemantic.length,
    recentSeedCount: recentClaims.length,
    expandedCount: Math.max(0, claims.size - activeSemantic.length - recentClaims.length),
  };
}
