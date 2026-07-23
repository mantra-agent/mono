import { createHash } from "crypto";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  memoryVnextCausalPathReviews,
  memoryVnextClaimLinks,
  memoryVnextClaims,
  memoryVnextEntityLinks,
  memoryVnextPredictionEvaluationRuns,
  memoryVnextPredictionResolutions,
  memoryVnextPredictions,
  memoryVnextRetrievalActivationEvents,
  memoryVnextRetrievalControls,
  memoryVnextRetrievalEvaluationRuns,
  memoryVnextRetrievalLabels,
  memoryVnextSourceRefs,
  type MemoryVnextClaimLink,
  type MemoryVnextEntityLink,
  type MemoryVnextRetrievalMode,
  type MemoryVnextSourceRef,
} from "@shared/schema";
import { db } from "../db";
import { createLogger } from "../log";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import {
  deriveCertainty,
  deriveIntegration,
  deriveTemporalApplicability,
  deriveVnextStrengthValues,
} from "./vnext-claim-dimensions";
import type { VnextContextCandidate } from "./vnext-context-retrieval";

const log = createLogger("MemoryVnextShadowEvaluation");
const MAX_CANDIDATES = 100;
const MAX_RESULTS = 25;
const MAX_LABELS = 250;
const MAX_EVALUATION_RUNS = 100;
const MAX_PREDICTIONS = 250;
const EVALUATION_VERSION = "vnext-shadow-evaluation-v1";
const CORRECTED_WEIGHTS = {
  semantic: 0.55,
  integration: 0.08,
  certainty: 0.1,
  relationships: 0.1,
  strength: 0.07,
  temporalApplicability: 0.1,
} as const;

type DimensionName = "integration" | "certainty" | "relationships" | "strength";
type AblationName = DimensionName | "none";

const claimScope = { scope: memoryVnextClaims.scope, ownerUserId: memoryVnextClaims.ownerUserId, accountId: memoryVnextClaims.accountId };
const sourceScope = { scope: memoryVnextSourceRefs.scope, ownerUserId: memoryVnextSourceRefs.ownerUserId, accountId: memoryVnextSourceRefs.accountId };
const entityScope = { scope: memoryVnextEntityLinks.scope, ownerUserId: memoryVnextEntityLinks.ownerUserId, accountId: memoryVnextEntityLinks.accountId };
const linkScope = { scope: memoryVnextClaimLinks.scope, ownerUserId: memoryVnextClaimLinks.ownerUserId, accountId: memoryVnextClaimLinks.accountId };
const controlScope = { scope: memoryVnextRetrievalControls.scope, ownerUserId: memoryVnextRetrievalControls.ownerUserId, accountId: memoryVnextRetrievalControls.accountId };
const activationScope = { scope: memoryVnextRetrievalActivationEvents.scope, ownerUserId: memoryVnextRetrievalActivationEvents.ownerUserId, accountId: memoryVnextRetrievalActivationEvents.accountId };
const labelScope = { scope: memoryVnextRetrievalLabels.scope, ownerUserId: memoryVnextRetrievalLabels.ownerUserId, accountId: memoryVnextRetrievalLabels.accountId };
const retrievalRunScope = { scope: memoryVnextRetrievalEvaluationRuns.scope, ownerUserId: memoryVnextRetrievalEvaluationRuns.ownerUserId, accountId: memoryVnextRetrievalEvaluationRuns.accountId };
const predictionScope = { scope: memoryVnextPredictions.scope, ownerUserId: memoryVnextPredictions.ownerUserId, accountId: memoryVnextPredictions.accountId };
const resolutionScope = { scope: memoryVnextPredictionResolutions.scope, ownerUserId: memoryVnextPredictionResolutions.ownerUserId, accountId: memoryVnextPredictionResolutions.accountId };
const causalReviewScope = { scope: memoryVnextCausalPathReviews.scope, ownerUserId: memoryVnextCausalPathReviews.ownerUserId, accountId: memoryVnextCausalPathReviews.accountId };
const predictionRunScope = { scope: memoryVnextPredictionEvaluationRuns.scope, ownerUserId: memoryVnextPredictionEvaluationRuns.ownerUserId, accountId: memoryVnextPredictionEvaluationRuns.accountId };

function hashKey(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function estimateTokens(candidates: VnextContextCandidate[]): number {
  const chars = candidates.reduce((sum, candidate) => sum + (candidate.claim.title?.length ?? 0) + candidate.claim.content.length + 80, 0);
  return Math.ceil(chars / 4);
}

function normalizedContent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function duplicateDensity(candidates: VnextContextCandidate[]): number {
  if (candidates.length < 2) return 0;
  let duplicatePairs = 0;
  let pairs = 0;
  for (let left = 0; left < candidates.length; left++) {
    const leftWords = new Set(normalizedContent(candidates[left].claim.content).split(" ").filter((word) => word.length > 3));
    for (let right = left + 1; right < candidates.length; right++) {
      const rightWords = new Set(normalizedContent(candidates[right].claim.content).split(" ").filter((word) => word.length > 3));
      const union = new Set([...leftWords, ...rightWords]).size;
      const intersection = [...leftWords].filter((word) => rightWords.has(word)).length;
      if (union > 0 && intersection / union >= 0.82) duplicatePairs++;
      pairs++;
    }
  }
  return rounded(duplicatePairs / Math.max(1, pairs));
}

function temporalApplicabilityValue(status: string): number {
  if (status === "current") return 1;
  if (status === "upcoming") return 0.85;
  if (status === "historical") return 0.55;
  if (status === "unknown") return 0.45;
  return 0;
}

function integrationValue(level: string): number {
  if (level === "structural") return 1;
  if (level === "integrated") return 0.75;
  if (level === "associated") return 0.45;
  return 0.15;
}

function relationshipValue(links: MemoryVnextClaimLink[]): number {
  const assessed = links.filter((link) => link.certainty != null && link.epistemicStatus !== "legacy_unassessed");
  if (assessed.length === 0) return 0;
  const classDiversity = new Set(assessed.map((link) => link.relationshipClass)).size;
  const certainty = assessed.reduce((sum, link) => sum + (link.certainty ?? 0), 0) / assessed.length;
  return rounded(clamp01(certainty * 0.7 + Math.min(1, classDiversity / 4) * 0.3));
}

interface CorrectedCandidate extends VnextContextCandidate {
  correctedScore: number;
  dimensionContributions: Record<"semantic" | DimensionName | "temporalApplicability", number>;
  dimensions: {
    integration: string;
    certaintyStatus: string;
    certaintyValue: number | null;
    relationships: number;
    strength: number;
    temporalApplicability: string;
  };
}

function rankCorrected(candidates: CorrectedCandidate[], ablate: AblationName = "none"): CorrectedCandidate[] {
  return candidates.map((candidate) => {
    const contributions = { ...candidate.dimensionContributions };
    if (ablate !== "none") contributions[ablate] = 0;
    return { ...candidate, correctedScore: rounded(Object.values(contributions).reduce((sum, value) => sum + value, 0)) };
  }).sort((left, right) => right.correctedScore - left.correctedScore || right.score - left.score || right.claim.id - left.claim.id)
    .slice(0, MAX_RESULTS);
}

async function loadDimensionEvidence(claimIds: number[]): Promise<{
  sources: Map<number, MemoryVnextSourceRef[]>;
  entities: Map<number, MemoryVnextEntityLink[]>;
  links: Map<number, MemoryVnextClaimLink[]>;
  strength: Map<number, number>;
}> {
  const ids = [...new Set(claimIds)].slice(0, MAX_CANDIDATES);
  const principal = getCurrentPrincipalOrSystem();
  const [sources, entities, links, strength] = await Promise.all([
    ids.length ? db.select().from(memoryVnextSourceRefs).where(combineWithVisibleScope(principal, sourceScope, inArray(memoryVnextSourceRefs.claimId, ids))).limit(MAX_CANDIDATES * 8) : [],
    ids.length ? db.select().from(memoryVnextEntityLinks).where(combineWithVisibleScope(principal, entityScope, inArray(memoryVnextEntityLinks.claimId, ids))).limit(MAX_CANDIDATES * 8) : [],
    ids.length ? db.select().from(memoryVnextClaimLinks).where(combineWithVisibleScope(principal, linkScope, sql`${memoryVnextClaimLinks.fromClaimId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) OR ${memoryVnextClaimLinks.toClaimId} IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)).limit(MAX_CANDIDATES * 12) : [],
    deriveVnextStrengthValues(ids),
  ]);
  const sourceMap = new Map<number, MemoryVnextSourceRef[]>();
  const entityMap = new Map<number, MemoryVnextEntityLink[]>();
  const linkMap = new Map<number, MemoryVnextClaimLink[]>();
  for (const source of sources) sourceMap.set(source.claimId, [...(sourceMap.get(source.claimId) ?? []), source]);
  for (const entity of entities) entityMap.set(entity.claimId, [...(entityMap.get(entity.claimId) ?? []), entity]);
  for (const link of links) {
    linkMap.set(link.fromClaimId, [...(linkMap.get(link.fromClaimId) ?? []), link]);
    linkMap.set(link.toClaimId, [...(linkMap.get(link.toClaimId) ?? []), link]);
  }
  return { sources: sourceMap, entities: entityMap, links: linkMap, strength };
}

async function correctedCandidates(candidates: VnextContextCandidate[], evaluatedAt: Date): Promise<CorrectedCandidate[]> {
  const bounded = candidates.slice(0, MAX_CANDIDATES);
  const evidence = await loadDimensionEvidence(bounded.map((candidate) => candidate.claim.id));
  return bounded.map((candidate) => {
    const sources = evidence.sources.get(candidate.claim.id) ?? [];
    const entities = evidence.entities.get(candidate.claim.id) ?? [];
    const links = evidence.links.get(candidate.claim.id) ?? [];
    const integration = deriveIntegration(candidate.claim.id, sources, entities, links);
    const certainty = deriveCertainty(sources);
    const temporal = deriveTemporalApplicability(candidate.claim, evaluatedAt);
    const strength = evidence.strength.get(candidate.claim.id) ?? 0;
    const relationships = relationshipValue(links);
    const semantic = clamp01(Math.max(candidate.signals.semantic, candidate.signals.recency * 0.35));
    const dimensionContributions = {
      semantic: rounded(semantic * CORRECTED_WEIGHTS.semantic),
      integration: rounded(integrationValue(integration.level) * CORRECTED_WEIGHTS.integration),
      certainty: rounded((certainty.value ?? 0.35) * CORRECTED_WEIGHTS.certainty),
      relationships: rounded(relationships * CORRECTED_WEIGHTS.relationships),
      strength: rounded(strength * CORRECTED_WEIGHTS.strength),
      temporalApplicability: rounded(temporalApplicabilityValue(temporal.status) * CORRECTED_WEIGHTS.temporalApplicability),
    };
    return {
      ...candidate,
      correctedScore: rounded(Object.values(dimensionContributions).reduce((sum, value) => sum + value, 0)),
      dimensionContributions,
      dimensions: {
        integration: integration.level,
        certaintyStatus: certainty.status,
        certaintyValue: certainty.value,
        relationships,
        strength,
        temporalApplicability: temporal.status,
      },
    };
  });
}

function rankOverlap(left: VnextContextCandidate[], right: VnextContextCandidate[]): number {
  const rightIds = new Set(right.map((candidate) => candidate.claim.id));
  return rounded(left.filter((candidate) => rightIds.has(candidate.claim.id)).length / Math.max(1, Math.max(left.length, right.length)));
}

function labelMetrics(labels: Array<{ claimId: number; relevance: string; durableFact: boolean }>, selected: VnextContextCandidate[]) {
  const selectedIds = new Set(selected.map((candidate) => candidate.claim.id));
  const relevant = labels.filter((label) => label.relevance === "relevant");
  const retrievedReviewed = labels.filter((label) => selectedIds.has(label.claimId));
  const retrievedRelevant = retrievedReviewed.filter((label) => label.relevance === "relevant");
  const durableRelevant = relevant.filter((label) => label.durableFact);
  const durableMisses = durableRelevant.filter((label) => !selectedIds.has(label.claimId));
  return {
    reviewedLabels: labels.length,
    relevantLabels: relevant.length,
    relevancePrecision: retrievedReviewed.length ? rounded(retrievedRelevant.length / retrievedReviewed.length) : null,
    relevanceRecall: relevant.length ? rounded(relevant.filter((label) => selectedIds.has(label.claimId)).length / relevant.length) : null,
    durableFactsReviewed: durableRelevant.length,
    durableFactMisses: durableMisses.length,
    durableFactMissRate: durableRelevant.length ? rounded(durableMisses.length / durableRelevant.length) : null,
  };
}

export function retrievalContextKey(focusText: string): string {
  return hashKey([EVALUATION_VERSION, normalizedContent(focusText).slice(0, 4000)]);
}

export async function getRetrievalControl(): Promise<{ retrievalMode: MemoryVnextRetrievalMode; predictionOutputMode: "shadow"; reason: string; updatedAt: Date | null }> {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) throw new Error("Retrieval control requires a user principal");
  const [row] = await db.select().from(memoryVnextRetrievalControls)
    .where(combineWithVisibleScope(principal, controlScope)).limit(1);
  return row ? {
    retrievalMode: row.retrievalMode as MemoryVnextRetrievalMode,
    predictionOutputMode: "shadow",
    reason: row.reason,
    updatedAt: row.updatedAt,
  } : { retrievalMode: "compatibility", predictionOutputMode: "shadow", reason: "default_off", updatedAt: null };
}

export async function setRetrievalMode(input: { mode: MemoryVnextRetrievalMode; reason: string; replayKey: string }) {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) throw new Error("Retrieval activation requires a user principal");
  const reason = input.reason.trim().slice(0, 500);
  const replayKey = input.replayKey.trim().slice(0, 300);
  if (!reason || !replayKey) throw new Error("Activation reason and replay key are required");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`memory-vnext-retrieval-control:${principal.userId}`}))`);
    const [existingEvent] = await tx.select().from(memoryVnextRetrievalActivationEvents)
      .where(combineWithVisibleScope(principal, activationScope, eq(memoryVnextRetrievalActivationEvents.replayKey, replayKey))).limit(1);
    if (existingEvent) return getRetrievalControl();
    const [existing] = await tx.select().from(memoryVnextRetrievalControls)
      .where(combineWithWritableScope(principal, controlScope)).limit(1);
    const previousMode = (existing?.retrievalMode ?? "compatibility") as MemoryVnextRetrievalMode;
    if (existing) {
      await tx.update(memoryVnextRetrievalControls).set({
        retrievalMode: input.mode,
        predictionOutputMode: "shadow",
        reason,
        updatedByUserId: principal.userId,
        updatedAt: new Date(),
      }).where(combineWithWritableScope(principal, controlScope, eq(memoryVnextRetrievalControls.id, existing.id)));
    } else {
      await tx.insert(memoryVnextRetrievalControls).values({
        retrievalMode: input.mode,
        predictionOutputMode: "shadow",
        reason,
        ...ownedInsertValues(principal, controlScope),
        createdByUserId: principal.userId,
        updatedByUserId: principal.userId,
      });
    }
    await tx.insert(memoryVnextRetrievalActivationEvents).values({
      replayKey,
      previousMode,
      nextMode: input.mode,
      reason,
      ...ownedInsertValues(principal, activationScope),
      createdByUserId: principal.userId,
    });
    log.info(JSON.stringify({ event: "memory.vnext.retrieval_mode_changed", previousMode, nextMode: input.mode, predictionOutputMode: "shadow" }));
    return { retrievalMode: input.mode, predictionOutputMode: "shadow" as const, reason, updatedAt: new Date() };
  });
}

export async function upsertRetrievalLabel(input: { contextKey: string; claimId: number; relevance: "relevant" | "irrelevant"; durableFact: boolean; note?: string }) {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) throw new Error("Retrieval labeling requires a user principal");
  const [claim] = await db.select({ id: memoryVnextClaims.id }).from(memoryVnextClaims)
    .where(combineWithWritableScope(principal, claimScope, eq(memoryVnextClaims.id, input.claimId))).limit(1);
  if (!claim) throw new Error("Claim is not writable in the current scope");
  const values = {
    contextKey: input.contextKey.trim().slice(0, 300),
    claimId: input.claimId,
    relevance: input.relevance,
    durableFact: input.durableFact,
    note: input.note?.trim().slice(0, 1000) ?? "",
  };
  const [row] = await db.insert(memoryVnextRetrievalLabels).values({
    ...values,
    ...ownedInsertValues(principal, labelScope),
    createdByUserId: principal.userId,
    updatedByUserId: principal.userId,
  }).onConflictDoUpdate({
    target: [memoryVnextRetrievalLabels.ownerUserId, memoryVnextRetrievalLabels.accountId, memoryVnextRetrievalLabels.contextKey, memoryVnextRetrievalLabels.claimId],
    set: { relevance: values.relevance, durableFact: values.durableFact, note: values.note, updatedByUserId: principal.userId, updatedAt: new Date() },
  }).returning();
  return row;
}

export async function evaluateDualRetrieval(input: {
  focusText: string;
  contextBuildId: string;
  compatibilityCandidates: VnextContextCandidate[];
  startedAt: Date;
}): Promise<{ selectedMode: MemoryVnextRetrievalMode; selectedCandidates: VnextContextCandidate[] }> {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) throw new Error("Dual retrieval evaluation requires a user principal");
  const control = await getRetrievalControl();
  const contextKey = retrievalContextKey(input.focusText);
  const correctedPool = await correctedCandidates(input.compatibilityCandidates, input.startedAt);
  const compatibility = input.compatibilityCandidates.slice(0, MAX_RESULTS);
  const corrected = rankCorrected(correctedPool);
  const labels = await db.select({
    claimId: memoryVnextRetrievalLabels.claimId,
    relevance: memoryVnextRetrievalLabels.relevance,
    durableFact: memoryVnextRetrievalLabels.durableFact,
  }).from(memoryVnextRetrievalLabels)
    .where(combineWithVisibleScope(principal, labelScope, eq(memoryVnextRetrievalLabels.contextKey, contextKey))).limit(MAX_LABELS);
  const completedAt = new Date();
  const compatibilityMetrics = labelMetrics(labels, compatibility);
  const correctedMetrics = labelMetrics(labels, corrected);
  const metrics = {
    version: EVALUATION_VERSION,
    labelsAvailable: labels.length > 0,
    compatibility: {
      ...compatibilityMetrics,
      duplicateDensity: duplicateDensity(compatibility),
      tokenEstimate: estimateTokens(compatibility),
      currentlyApplicableShare: rounded(compatibility.filter((candidate) => {
        const status = deriveTemporalApplicability(candidate.claim, input.startedAt).status;
        return status === "current" || status === "upcoming";
      }).length / Math.max(1, compatibility.length)),
    },
    corrected: {
      ...correctedMetrics,
      duplicateDensity: duplicateDensity(corrected),
      tokenEstimate: estimateTokens(corrected),
      currentlyApplicableShare: rounded(corrected.filter((candidate) => candidate.dimensions.temporalApplicability === "current" || candidate.dimensions.temporalApplicability === "upcoming").length / Math.max(1, corrected.length)),
    },
    deltas: {
      overlap: rankOverlap(compatibility, corrected),
      duplicateDensity: rounded(duplicateDensity(corrected) - duplicateDensity(compatibility)),
      tokenEstimate: estimateTokens(corrected) - estimateTokens(compatibility),
      relevancePrecision: correctedMetrics.relevancePrecision == null || compatibilityMetrics.relevancePrecision == null ? null : rounded(correctedMetrics.relevancePrecision - compatibilityMetrics.relevancePrecision),
      durableFactMissRate: correctedMetrics.durableFactMissRate == null || compatibilityMetrics.durableFactMissRate == null ? null : rounded(correctedMetrics.durableFactMissRate - compatibilityMetrics.durableFactMissRate),
      latencyMs: completedAt.getTime() - input.startedAt.getTime(),
    },
  };
  const contributionSummary = corrected.reduce((summary, candidate) => {
    for (const [name, value] of Object.entries(candidate.dimensionContributions)) summary[name] = rounded((summary[name] ?? 0) + value);
    return summary;
  }, {} as Record<string, number>);
  const ablations = Object.fromEntries((["integration", "certainty", "relationships", "strength"] as DimensionName[]).map((dimension) => {
    const ranked = rankCorrected(correctedPool, dimension);
    return [dimension, { claimIds: ranked.map((candidate) => candidate.claim.id), overlapWithFull: rankOverlap(corrected, ranked) }];
  }));
  const replayKey = hashKey([EVALUATION_VERSION, input.contextBuildId]);
  await db.insert(memoryVnextRetrievalEvaluationRuns).values({
    replayKey,
    contextBuildId: input.contextBuildId.slice(0, 300),
    contextKey,
    selectedMode: control.retrievalMode,
    compatibilityClaimIds: compatibility.map((candidate) => candidate.claim.id),
    correctedClaimIds: corrected.map((candidate) => candidate.claim.id),
    metrics,
    dimensionContributions: { weights: CORRECTED_WEIGHTS, totals: contributionSummary, candidates: corrected.map((candidate) => ({ claimId: candidate.claim.id, score: candidate.correctedScore, contributions: candidate.dimensionContributions, dimensions: candidate.dimensions })) },
    ablations,
    startedAt: input.startedAt,
    completedAt,
    ...ownedInsertValues(principal, retrievalRunScope),
    createdByUserId: principal.userId,
  }).onConflictDoNothing();
  log.debug(JSON.stringify({ event: "memory.vnext.dual_retrieval_measured", selectedMode: control.retrievalMode, compatibility: compatibility.length, corrected: corrected.length, labels: labels.length, latencyMs: completedAt.getTime() - input.startedAt.getTime() }));
  return { selectedMode: control.retrievalMode, selectedCandidates: control.retrievalMode === "corrected" ? corrected : compatibility };
}

export async function inspectRetrievalEvaluation(limit = 25) {
  const principal = getCurrentPrincipalOrSystem();
  const [control, runs, labels] = await Promise.all([
    getRetrievalControl(),
    db.select().from(memoryVnextRetrievalEvaluationRuns).where(combineWithVisibleScope(principal, retrievalRunScope))
      .orderBy(desc(memoryVnextRetrievalEvaluationRuns.completedAt), desc(memoryVnextRetrievalEvaluationRuns.id)).limit(Math.min(Math.max(limit, 1), MAX_EVALUATION_RUNS)),
    db.select({ count: sql<number>`count(*)::int` }).from(memoryVnextRetrievalLabels).where(combineWithVisibleScope(principal, labelScope)),
  ]);
  return { control, labelCount: Number(labels[0]?.count ?? 0), runs };
}

function brier(probability: number, actual: number): number {
  return rounded((probability - actual) ** 2);
}

function calibration(rows: Array<{ probability: number; actual: number }>) {
  const bins = Array.from({ length: 10 }, (_, index) => ({ lower: index / 10, upper: (index + 1) / 10, count: 0, meanProbability: 0, observedRate: 0 }));
  for (const row of rows) {
    const index = Math.min(9, Math.floor(row.probability * 10));
    bins[index].count++;
    bins[index].meanProbability += row.probability;
    bins[index].observedRate += row.actual;
  }
  return bins.filter((bin) => bin.count > 0).map((bin) => ({ ...bin, meanProbability: rounded(bin.meanProbability / bin.count), observedRate: rounded(bin.observedRate / bin.count) }));
}

function average(values: number[]): number | null {
  return values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

export async function upsertCausalPathReview(input: { predictionId: number; judgment: "correct" | "incorrect" | "unclear"; note?: string }) {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) throw new Error("Causal path review requires a user principal");
  const [prediction] = await db.select({ id: memoryVnextPredictions.id }).from(memoryVnextPredictions)
    .where(combineWithWritableScope(principal, predictionScope, eq(memoryVnextPredictions.id, input.predictionId))).limit(1);
  if (!prediction) throw new Error("Prediction is not writable in the current scope");
  const [row] = await db.insert(memoryVnextCausalPathReviews).values({
    predictionId: input.predictionId,
    judgment: input.judgment,
    note: input.note?.trim().slice(0, 1000) ?? "",
    ...ownedInsertValues(principal, causalReviewScope),
    createdByUserId: principal.userId,
    updatedByUserId: principal.userId,
  }).onConflictDoUpdate({
    target: [memoryVnextCausalPathReviews.ownerUserId, memoryVnextCausalPathReviews.accountId, memoryVnextCausalPathReviews.predictionId],
    set: { judgment: input.judgment, note: input.note?.trim().slice(0, 1000) ?? "", updatedByUserId: principal.userId, updatedAt: new Date() },
  }).returning();
  return row;
}

async function strictCutoffBaselines(prediction: typeof memoryVnextPredictions.$inferSelect, actual: number) {
  const principal = getCurrentPrincipalOrSystem();
  const historical = await db.select({
    probability: memoryVnextPredictions.probability,
    outcomeClass: memoryVnextPredictions.predictedOutcomeClass,
    generatedAt: memoryVnextPredictions.generatedAt,
    actual: memoryVnextPredictionResolutions.actualValue,
    resolvedAt: memoryVnextPredictionResolutions.resolvedAt,
    predictedOutcomeClaimId: memoryVnextPredictions.predictedOutcomeClaimId,
  }).from(memoryVnextPredictions)
    .innerJoin(memoryVnextPredictionResolutions, and(
      eq(memoryVnextPredictionResolutions.predictionId, memoryVnextPredictions.id),
      inArray(memoryVnextPredictionResolutions.outcome, ["confirmed", "refuted"]),
      combineWithVisibleScope(principal, resolutionScope),
    ))
    .where(combineWithVisibleScope(principal, predictionScope, and(
      lt(memoryVnextPredictionResolutions.resolvedAt, prediction.generatedAt),
      lt(memoryVnextPredictions.generatedAt, prediction.generatedAt),
    )))
    .orderBy(asc(memoryVnextPredictions.generatedAt)).limit(MAX_PREDICTIONS);
  const classHistory = historical.filter((row) => row.outcomeClass === prediction.predictedOutcomeClass && row.actual != null);
  const frequency = classHistory.length ? classHistory.filter((row) => Number(row.actual) === 1).length / classHistory.length : null;
  let recencyWeight = 0;
  let recencySuccess = 0;
  for (const row of classHistory) {
    const ageDays = Math.max(0, (prediction.generatedAt.getTime() - row.generatedAt.getTime()) / 86_400_000);
    const weight = Math.pow(0.5, ageDays / 90);
    recencyWeight += weight;
    recencySuccess += Number(row.actual) * weight;
  }
  const frequencyRecency = recencyWeight > 0 ? recencySuccess / recencyWeight : null;
  let semantic: number | null = null;
  if (prediction.predictedOutcomeClaimId && classHistory.length > 0) {
    const historicalClaimIds = classHistory.flatMap((row) => row.predictedOutcomeClaimId ? [row.predictedOutcomeClaimId] : []);
    if (historicalClaimIds.length > 0) {
      const links = await db.select().from(memoryVnextClaimLinks).where(combineWithVisibleScope(principal, linkScope, and(
        eq(memoryVnextClaimLinks.relationshipClass, "semantic"),
        sql`(${memoryVnextClaimLinks.fromClaimId} = ${prediction.predictedOutcomeClaimId} AND ${memoryVnextClaimLinks.toClaimId} IN (${sql.join(historicalClaimIds.map((id) => sql`${id}`), sql`, `)})) OR (${memoryVnextClaimLinks.toClaimId} = ${prediction.predictedOutcomeClaimId} AND ${memoryVnextClaimLinks.fromClaimId} IN (${sql.join(historicalClaimIds.map((id) => sql`${id}`), sql`, `)}))`,
      ))).limit(MAX_PREDICTIONS);
      const similarIds = new Set(links.flatMap((link) => [link.fromClaimId, link.toClaimId]));
      const semanticHistory = classHistory.filter((row) => row.predictedOutcomeClaimId && similarIds.has(row.predictedOutcomeClaimId));
      if (semanticHistory.length > 0) semantic = semanticHistory.filter((row) => Number(row.actual) === 1).length / semanticHistory.length;
    }
  }
  return {
    actual,
    historyCount: classHistory.length,
    frequency: frequency == null ? null : rounded(frequency),
    frequencyRecency: frequencyRecency == null ? null : rounded(frequencyRecency),
    semanticWithoutCausalPaths: semantic == null ? null : rounded(semantic),
    evidenceCutoff: prediction.generatedAt.toISOString(),
    resolvedEvidenceRequiredBeforeCutoff: true,
  };
}

export async function evaluatePredictions(input: { replayKey?: string } = {}) {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) throw new Error("Prediction evaluation requires a user principal");
  const evaluatedAt = new Date();
  const rows = await db.select({ prediction: memoryVnextPredictions, resolution: memoryVnextPredictionResolutions })
    .from(memoryVnextPredictions)
    .innerJoin(memoryVnextPredictionResolutions, and(
      eq(memoryVnextPredictionResolutions.predictionId, memoryVnextPredictions.id),
      inArray(memoryVnextPredictionResolutions.outcome, ["confirmed", "refuted"]),
      combineWithVisibleScope(principal, resolutionScope),
    ))
    .where(combineWithVisibleScope(principal, predictionScope))
    .orderBy(asc(memoryVnextPredictions.generatedAt)).limit(MAX_PREDICTIONS);
  const baselines = [];
  for (const row of rows) baselines.push({ predictionId: row.prediction.id, forecastProbability: row.prediction.probability, ...(await strictCutoffBaselines(row.prediction, Number(row.resolution.actualValue))) });
  const allPredictions = await db.select({ count: sql<number>`count(*)::int` }).from(memoryVnextPredictions).where(combineWithVisibleScope(principal, predictionScope));
  const observable = await db.select({ count: sql<number>`count(*)::int` }).from(memoryVnextPredictions).where(combineWithVisibleScope(principal, predictionScope, sql`${memoryVnextPredictions.expectedAt} <= ${evaluatedAt}`));
  const resolved = await db.select({ count: sql<number>`count(*)::int` }).from(memoryVnextPredictionResolutions).where(combineWithVisibleScope(principal, resolutionScope, sql`${memoryVnextPredictionResolutions.outcome} <> 'superseded'`));
  const reviews = await db.select().from(memoryVnextCausalPathReviews).where(combineWithVisibleScope(principal, causalReviewScope)).limit(MAX_PREDICTIONS);
  const scoredRows = baselines.map((row) => ({ probability: row.forecastProbability, actual: row.actual }));
  const metric = {
    version: EVALUATION_VERSION,
    predictionOutputMode: "shadow",
    totalPredictions: Number(allPredictions[0]?.count ?? 0),
    scoredPredictions: rows.length,
    observableHorizons: Number(observable[0]?.count ?? 0),
    resolutionCoverage: Number(observable[0]?.count ?? 0) ? rounded(Number(resolved[0]?.count ?? 0) / Number(observable[0]?.count ?? 0)) : null,
    outcomeRecall: rows.length ? rounded(rows.filter((row) => row.resolution.observedOutcomeClaimId != null).length / rows.length) : null,
    causal: {
      brier: average(scoredRows.map((row) => brier(row.probability, row.actual))),
      calibration: calibration(scoredRows),
    },
    baselines: {
      frequency: { coverage: baselines.filter((row) => row.frequency != null).length, brier: average(baselines.flatMap((row) => row.frequency == null ? [] : [brier(row.frequency, row.actual)])) },
      frequencyRecency: { coverage: baselines.filter((row) => row.frequencyRecency != null).length, brier: average(baselines.flatMap((row) => row.frequencyRecency == null ? [] : [brier(row.frequencyRecency, row.actual)])) },
      semanticWithoutCausalPaths: { coverage: baselines.filter((row) => row.semanticWithoutCausalPaths != null).length, brier: average(baselines.flatMap((row) => row.semanticWithoutCausalPaths == null ? [] : [brier(row.semanticWithoutCausalPaths, row.actual)])) },
    },
    abstention: {
      total: Math.max(0, Number(allPredictions[0]?.count ?? 0) - rows.length),
      rate: Number(allPredictions[0]?.count ?? 0) ? rounded(Math.max(0, Number(allPredictions[0]?.count ?? 0) - rows.length) / Number(allPredictions[0]?.count ?? 0)) : null,
    },
    causalPathPrecision: {
      reviewed: reviews.filter((review) => review.judgment !== "unclear").length,
      correct: reviews.filter((review) => review.judgment === "correct").length,
      precision: reviews.filter((review) => review.judgment !== "unclear").length ? rounded(reviews.filter((review) => review.judgment === "correct").length / reviews.filter((review) => review.judgment !== "unclear").length) : null,
      reviewCoverage: Number(allPredictions[0]?.count ?? 0) ? rounded(reviews.length / Number(allPredictions[0]?.count ?? 0)) : null,
    },
    strictCutoff: true,
    baselineDetails: baselines,
  };
  const replayKey = (input.replayKey?.trim() || hashKey([EVALUATION_VERSION, principal.userId, evaluatedAt.toISOString()])).slice(0, 300);
  const [inserted] = await db.insert(memoryVnextPredictionEvaluationRuns).values({
    replayKey,
    metrics: metric,
    evaluatedAt,
    ...ownedInsertValues(principal, predictionRunScope),
    createdByUserId: principal.userId,
  }).onConflictDoNothing().returning();
  return inserted ?? (await db.select().from(memoryVnextPredictionEvaluationRuns).where(combineWithVisibleScope(principal, predictionRunScope, eq(memoryVnextPredictionEvaluationRuns.replayKey, replayKey))).limit(1))[0];
}

export async function inspectPredictionEvaluation(limit = 25) {
  const principal = getCurrentPrincipalOrSystem();
  const reviews = await db.select().from(memoryVnextCausalPathReviews).where(combineWithVisibleScope(principal, causalReviewScope)).limit(MAX_PREDICTIONS);
  const runs = await db.select().from(memoryVnextPredictionEvaluationRuns).where(combineWithVisibleScope(principal, predictionRunScope))
    .orderBy(desc(memoryVnextPredictionEvaluationRuns.evaluatedAt), desc(memoryVnextPredictionEvaluationRuns.id)).limit(Math.min(Math.max(limit, 1), MAX_EVALUATION_RUNS));
  return { predictionOutputMode: "shadow" as const, causalPathReviewCount: reviews.length, runs };
}
