import { createHash } from "crypto";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  memoryVnextClaimLinkEvidence,
  memoryVnextClaimLinks,
  memoryVnextClaims,
  memoryVnextPredictionResolutions,
  memoryVnextPredictionRuns,
  memoryVnextPredictions,
  memoryVnextRelationshipCertaintyEvents,
  memoryVnextSourceRefs,
  type MemoryVnextClaim,
  type MemoryVnextClaimLink,
  type MemoryVnextPrediction,
  type MemoryVnextPredictionResolution,
  type MemoryVnextPredictionRun,
  type MemoryVnextRelationshipCertaintyEvent,
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
  inspectTransitionPaths,
  listClaimLinkEvidence,
  recomputeTransitionPaths,
  type VnextTransitionPathDetail,
} from "./vnext-transition-graph";

const log = createLogger("MemoryVnextPredictions");
export const PREDICTION_DERIVATION_METHOD = "causal_transition_shadow_prediction";
export const PREDICTION_DERIVATION_VERSION = "v1";
export const PREDICTION_SCORING_RULE_VERSION = "binary-brier-log-v1";
export const RELATIONSHIP_LEARNING_RULE_VERSION = "prediction-resolution-bounded-v1";
const MAX_PATHS = 100;
const MAX_CLAIMS = 250;
const MAX_LINKS = 500;
const MAX_PREDICTIONS_PER_RUN = 25;
const MAX_RESOLUTIONS_PER_RUN = 50;
const MAX_INSPECT = 100;
const MAX_HORIZON_SECONDS = 365 * 24 * 60 * 60;
const MIN_PATH_CERTAINTY = 0.5;
const MIN_MATCH_CERTAINTY = 0.6;
const CONFIRMED_CERTAINTY_DELTA = 0.02;
const REFUTED_CERTAINTY_DELTA = -0.04;
const LOG_SCORE_FLOOR = 0.000001;

const claimScope = { scope: memoryVnextClaims.scope, ownerUserId: memoryVnextClaims.ownerUserId, accountId: memoryVnextClaims.accountId };
const sourceScope = { scope: memoryVnextSourceRefs.scope, ownerUserId: memoryVnextSourceRefs.ownerUserId, accountId: memoryVnextSourceRefs.accountId };
const linkScope = { scope: memoryVnextClaimLinks.scope, ownerUserId: memoryVnextClaimLinks.ownerUserId, accountId: memoryVnextClaimLinks.accountId };
const linkEvidenceScope = { scope: memoryVnextClaimLinkEvidence.scope, ownerUserId: memoryVnextClaimLinkEvidence.ownerUserId, accountId: memoryVnextClaimLinkEvidence.accountId };
const predictionScope = { scope: memoryVnextPredictions.scope, ownerUserId: memoryVnextPredictions.ownerUserId, accountId: memoryVnextPredictions.accountId };
const resolutionScope = { scope: memoryVnextPredictionResolutions.scope, ownerUserId: memoryVnextPredictionResolutions.ownerUserId, accountId: memoryVnextPredictionResolutions.accountId };
const certaintyEventScope = { scope: memoryVnextRelationshipCertaintyEvents.scope, ownerUserId: memoryVnextRelationshipCertaintyEvents.ownerUserId, accountId: memoryVnextRelationshipCertaintyEvents.accountId };
const runScope = { scope: memoryVnextPredictionRuns.scope, ownerUserId: memoryVnextPredictionRuns.ownerUserId, accountId: memoryVnextPredictionRuns.accountId };

type AbstentionReason =
  | "path_not_causal"
  | "path_certainty_low"
  | "horizon_missing"
  | "path_members_missing"
  | "no_current_state_match"
  | "no_current_action_match"
  | "no_observed_state_action_sequence"
  | "outcome_already_visible"
  | "probability_low"
  | "run_budget";

export interface ShadowPredictionRunResult {
  runId: number;
  runKey: string;
  trigger: string;
  scannedPaths: number;
  generated: number;
  abstained: number;
  resolved: number;
  scored: number;
  certaintyUpdates: number;
  abstentionReasons: Partial<Record<AbstentionReason, number>>;
}

export interface PredictionLedgerDetail {
  prediction: MemoryVnextPrediction;
  resolutions: MemoryVnextPredictionResolution[];
  certaintyEvents: MemoryVnextRelationshipCertaintyEvent[];
}

interface CandidateGraph {
  claims: MemoryVnextClaim[];
  links: MemoryVnextClaimLink[];
  evidenceBackedLinkIds: Set<number>;
}

interface GenerationCandidate {
  path: VnextTransitionPathDetail;
  currentState: MemoryVnextClaim;
  currentAction: MemoryVnextClaim;
  historicalOutcome: MemoryVnextClaim;
  stateMatch: MemoryVnextClaimLink;
  actionMatch: MemoryVnextClaimLink;
  stateActionSequence: MemoryVnextClaimLink;
  causalLinkIds: number[];
  probability: number;
  horizonSeconds: number;
}

function hashKey(parts: Array<string | number>): string {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function claimTime(claim: MemoryVnextClaim): Date | null {
  return claim.occurredAt ?? claim.observedAt ?? claim.validFrom ?? null;
}

function normalizedTemporalDirection(link: MemoryVnextClaimLink): { beforeId: number; afterId: number } | null {
  if (link.relationship === "precedes") return { beforeId: link.fromClaimId, afterId: link.toClaimId };
  if (link.relationship === "followed_by") return { beforeId: link.toClaimId, afterId: link.fromClaimId };
  return null;
}

function otherEndpoint(link: MemoryVnextClaimLink, claimId: number): number | null {
  if (link.fromClaimId === claimId) return link.toClaimId;
  if (link.toClaimId === claimId) return link.fromClaimId;
  return null;
}

function outcomeClass(claim: MemoryVnextClaim): string {
  const topic = claim.topics?.find((value) => value.trim());
  return (topic || claim.title || `state:${claim.id}`).trim().slice(0, 160);
}

function addAbstention(target: Partial<Record<AbstentionReason, number>>, reason: AbstentionReason): void {
  target[reason] = (target[reason] ?? 0) + 1;
}

async function loadCandidateGraph(): Promise<CandidateGraph> {
  const principal = getCurrentPrincipalOrSystem();
  const claims = await db.select().from(memoryVnextClaims)
    .where(combineWithWritableScope(principal, claimScope, sql`${memoryVnextClaims.lifecycleStage} <> 'retired'`))
    .orderBy(desc(memoryVnextClaims.id)).limit(MAX_CLAIMS);
  const claimIds = claims.map((claim) => claim.id);
  if (claimIds.length === 0) return { claims, links: [], evidenceBackedLinkIds: new Set() };
  const links = await db.select().from(memoryVnextClaimLinks)
    .where(combineWithWritableScope(principal, linkScope, and(
      inArray(memoryVnextClaimLinks.fromClaimId, claimIds),
      inArray(memoryVnextClaimLinks.toClaimId, claimIds),
      inArray(memoryVnextClaimLinks.relationshipClass, ["semantic", "evidence", "temporal", "causal"]),
    )))
    .orderBy(desc(memoryVnextClaimLinks.id)).limit(MAX_LINKS);
  const evidence = await listClaimLinkEvidence(links.map((link) => link.id));
  return { claims, links, evidenceBackedLinkIds: new Set(evidence.map((row) => row.claimLinkId)) };
}

function findGenerationCandidate(
  path: VnextTransitionPathDetail,
  graph: CandidateGraph,
  generatedAt: Date,
  abstentions: Partial<Record<AbstentionReason, number>>,
): GenerationCandidate | null {
  if (path.path.status !== "causal_hypothesis") {
    addAbstention(abstentions, "path_not_causal");
    return null;
  }
  if (path.path.certainty < MIN_PATH_CERTAINTY) {
    addAbstention(abstentions, "path_certainty_low");
    return null;
  }
  const horizonSeconds = path.path.elapsedSeconds;
  if (!horizonSeconds || horizonSeconds <= 0 || horizonSeconds > MAX_HORIZON_SECONDS) {
    addAbstention(abstentions, "horizon_missing");
    return null;
  }
  const prior = path.members.find((member) => member.role === "prior_state")?.claim;
  const historicalAction = path.members.find((member) => member.role === "action")?.claim;
  const historicalOutcome = path.members.find((member) => member.role === "later_state")?.claim;
  if (!prior || !historicalAction || !historicalOutcome) {
    addAbstention(abstentions, "path_members_missing");
    return null;
  }
  const historicalIds = new Set(path.members.map((member) => member.claimId));
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const semanticLinks = graph.links.filter((link) =>
    link.relationshipClass === "semantic"
    && (link.relationship === "equivalent_to" || link.relationship === "similar_to")
    && (link.certainty ?? 0) >= MIN_MATCH_CERTAINTY
    && graph.evidenceBackedLinkIds.has(link.id));
  const stateMatches = semanticLinks.flatMap((link) => {
    const currentId = otherEndpoint(link, prior.id);
    const claim = currentId ? claimById.get(currentId) : null;
    return claim && claim.claimType === "state" && !historicalIds.has(claim.id) ? [{ claim, link }] : [];
  });
  if (stateMatches.length === 0) {
    addAbstention(abstentions, "no_current_state_match");
    return null;
  }
  const actionMatches = semanticLinks.flatMap((link) => {
    const currentId = otherEndpoint(link, historicalAction.id);
    const claim = currentId ? claimById.get(currentId) : null;
    return claim && claim.claimType === "action" && !historicalIds.has(claim.id) ? [{ claim, link }] : [];
  });
  if (actionMatches.length === 0) {
    addAbstention(abstentions, "no_current_action_match");
    return null;
  }
  const historicalOutcomeTime = claimTime(historicalOutcome);
  for (const stateMatch of stateMatches) {
    for (const actionMatch of actionMatches) {
      const actionObservedAt = claimTime(actionMatch.claim);
      if (!actionObservedAt || actionObservedAt > generatedAt || (historicalOutcomeTime && actionObservedAt <= historicalOutcomeTime)) continue;
      const stateActionSequence = graph.links.find((link) => {
        const direction = normalizedTemporalDirection(link);
        return direction?.beforeId === stateMatch.claim.id
          && direction.afterId === actionMatch.claim.id
          && (link.certainty ?? 0) >= MIN_PATH_CERTAINTY
          && graph.evidenceBackedLinkIds.has(link.id);
      });
      if (!stateActionSequence) continue;
      const outcomeAlreadyVisible = graph.links.some((link) => {
        const direction = normalizedTemporalDirection(link);
        if (direction?.beforeId !== actionMatch.claim.id || !graph.evidenceBackedLinkIds.has(link.id)) return false;
        const later = claimById.get(direction.afterId);
        const laterTime = later ? claimTime(later) : null;
        return later?.claimType === "state" && Boolean(laterTime && laterTime <= generatedAt);
      });
      if (outcomeAlreadyVisible) {
        addAbstention(abstentions, "outcome_already_visible");
        continue;
      }
      const causalLinkIds = path.edges
        .filter((edge) => edge.claimLink.relationshipClass === "causal" && edge.claimLink.epistemicStatus === "causal_hypothesis")
        .map((edge) => edge.claimLinkId);
      if (causalLinkIds.length === 0) {
        addAbstention(abstentions, "path_not_causal");
        return null;
      }
      const probability = rounded(Math.min(
        path.path.certainty,
        stateMatch.link.certainty ?? 0,
        actionMatch.link.certainty ?? 0,
        stateActionSequence.certainty ?? 0,
      ));
      if (probability < MIN_PATH_CERTAINTY) {
        addAbstention(abstentions, "probability_low");
        continue;
      }
      return {
        path,
        currentState: stateMatch.claim,
        currentAction: actionMatch.claim,
        historicalOutcome,
        stateMatch: stateMatch.link,
        actionMatch: actionMatch.link,
        stateActionSequence,
        causalLinkIds,
        probability,
        horizonSeconds,
      };
    }
  }
  addAbstention(abstentions, "no_observed_state_action_sequence");
  return null;
}

async function createPrediction(candidate: GenerationCandidate, generatedAt: Date): Promise<{ prediction: MemoryVnextPrediction; created: boolean }> {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) throw new Error("Shadow prediction creation requires a user principal");
  const replayKey = hashKey([
    PREDICTION_DERIVATION_METHOD,
    PREDICTION_DERIVATION_VERSION,
    candidate.path.path.derivationKey,
    candidate.currentState.id,
    candidate.currentAction.id,
  ]);
  const expectedAt = new Date(generatedAt.getTime() + candidate.horizonSeconds * 1_000);
  const snapshot = {
    transitionPathId: candidate.path.path.id,
    transitionDerivationKey: candidate.path.path.derivationKey,
    transitionStatus: candidate.path.path.status,
    transitionCertainty: candidate.path.path.certainty,
    historicalMemberClaimIds: candidate.path.members.map((member) => ({ claimId: member.claimId, role: member.role })),
    claimLinkIds: candidate.path.edges.map((edge) => ({ claimLinkId: edge.claimLinkId, role: edge.role })),
    stateMatchLinkId: candidate.stateMatch.id,
    actionMatchLinkId: candidate.actionMatch.id,
    stateActionSequenceLinkId: candidate.stateActionSequence.id,
    causalClaimLinkIds: candidate.causalLinkIds,
    causalTruthEstablished: false,
  };
  const generationContext = {
    contextKeys: candidate.path.path.contextKeys.slice(0, 50),
    entityKeys: candidate.path.path.entityKeys.slice(0, 50),
    currentStateClaimIds: [candidate.currentState.id],
    currentActionClaimId: candidate.currentAction.id,
    evidenceCutoff: generatedAt.toISOString(),
    shadowOnly: true,
  };
  const [inserted] = await db.insert(memoryVnextPredictions).values({
    replayKey,
    inputStateClaimIds: [candidate.currentState.id],
    actionClaimId: candidate.currentAction.id,
    actionMode: "observed",
    predictedOutcomeClaimId: candidate.historicalOutcome.id,
    predictedOutcomeClass: outcomeClass(candidate.historicalOutcome),
    probability: candidate.probability,
    horizonSeconds: candidate.horizonSeconds,
    expectedAt,
    transitionPathId: candidate.path.path.id,
    causalClaimLinkIds: candidate.causalLinkIds,
    transitionSnapshot: snapshot,
    generationContext,
    producerMethod: PREDICTION_DERIVATION_METHOD,
    derivationVersion: PREDICTION_DERIVATION_VERSION,
    modelVersion: null,
    generatedAt,
    ...ownedInsertValues(principal, predictionScope),
    createdByUserId: principal.userId,
  }).onConflictDoNothing().returning();
  if (inserted) return { prediction: inserted, created: true };
  const [existing] = await db.select().from(memoryVnextPredictions)
    .where(combineWithVisibleScope(principal, predictionScope, eq(memoryVnextPredictions.replayKey, replayKey))).limit(1);
  if (!existing) throw new Error("Prediction replay conflict could not be resolved in the current scope");
  return { prediction: existing, created: false };
}

function properScores(probability: number, actual: 0 | 1): { brierScore: number; logScore: number } {
  const p = Math.min(1 - LOG_SCORE_FLOOR, Math.max(LOG_SCORE_FLOOR, probability));
  return {
    brierScore: rounded((p - actual) ** 2),
    logScore: rounded(-Math.log(actual === 1 ? p : 1 - p)),
  };
}

async function listUnresolvedPredictions(limit: number): Promise<MemoryVnextPrediction[]> {
  const principal = getCurrentPrincipalOrSystem();
  return db.select().from(memoryVnextPredictions)
    .where(combineWithWritableScope(principal, predictionScope, sql`NOT EXISTS (
      SELECT 1 FROM memory_vnext_prediction_resolutions resolution
      WHERE resolution.prediction_id = ${memoryVnextPredictions.id}
        AND (resolution.scope = 'global' OR resolution.owner_user_id = ${principal.userId} OR resolution.account_id = ${principal.accountId})
        AND resolution.outcome <> 'superseded'
    )`))
    .orderBy(asc(memoryVnextPredictions.expectedAt), asc(memoryVnextPredictions.id))
    .limit(Math.min(Math.max(limit, 1), MAX_RESOLUTIONS_PER_RUN));
}

async function findOutcomeEvidence(prediction: MemoryVnextPrediction): Promise<{
  outcome: "confirmed" | "refuted";
  outcomeClaim: MemoryVnextClaim;
  sourceRefIds: number[];
  relationship: MemoryVnextClaimLink;
} | null> {
  if (!prediction.predictedOutcomeClaimId) return null;
  const principal = getCurrentPrincipalOrSystem();
  const candidateSources = await db.select().from(memoryVnextSourceRefs)
    .where(combineWithWritableScope(principal, sourceScope, gt(memoryVnextSourceRefs.createdAt, prediction.generatedAt)))
    .orderBy(asc(memoryVnextSourceRefs.createdAt)).limit(MAX_CLAIMS);
  const candidateClaimIds = [...new Set(candidateSources.map((source) => source.claimId))];
  if (candidateClaimIds.length === 0) return null;
  const candidates = await db.select().from(memoryVnextClaims)
    .where(combineWithWritableScope(principal, claimScope, and(
      inArray(memoryVnextClaims.id, candidateClaimIds),
      eq(memoryVnextClaims.claimType, "state"),
      sql`${memoryVnextClaims.lifecycleStage} <> 'retired'`,
    ))).limit(MAX_CLAIMS);
  const candidateById = new Map(candidates.filter((claim) => {
    const time = claimTime(claim) ?? claim.createdAt;
    return time > prediction.generatedAt;
  }).map((claim) => [claim.id, claim]));
  if (candidateById.size === 0) return null;
  const candidateIds = [...candidateById.keys()];
  const links = await db.select().from(memoryVnextClaimLinks)
    .where(combineWithWritableScope(principal, linkScope, and(
      or(
        and(
          eq(memoryVnextClaimLinks.fromClaimId, prediction.predictedOutcomeClaimId),
          inArray(memoryVnextClaimLinks.toClaimId, candidateIds),
        ),
        and(
          eq(memoryVnextClaimLinks.toClaimId, prediction.predictedOutcomeClaimId),
          inArray(memoryVnextClaimLinks.fromClaimId, candidateIds),
        ),
      ),
      inArray(memoryVnextClaimLinks.relationship, ["equivalent_to", "similar_to", "contradicts"]),
      sql`${memoryVnextClaimLinks.certainty} >= ${MIN_MATCH_CERTAINTY}`,
    ))).orderBy(desc(memoryVnextClaimLinks.certainty), asc(memoryVnextClaimLinks.id)).limit(MAX_LINKS);
  const evidence = await listClaimLinkEvidence(links.map((link) => link.id));
  const evidenceBacked = new Set(evidence.map((row) => row.claimLinkId));
  for (const link of links) {
    if (!evidenceBacked.has(link.id)) continue;
    const candidateId = otherEndpoint(link, prediction.predictedOutcomeClaimId);
    const outcomeClaim = candidateId ? candidateById.get(candidateId) : null;
    if (!outcomeClaim) continue;
    const sourceRefIds = candidateSources.filter((source) => source.claimId === outcomeClaim.id).map((source) => source.id).slice(0, 20);
    if (sourceRefIds.length === 0) continue;
    return {
      outcome: link.relationship === "contradicts" ? "refuted" : "confirmed",
      outcomeClaim,
      sourceRefIds,
      relationship: link,
    };
  }
  return null;
}

async function resolvePrediction(
  prediction: MemoryVnextPrediction,
  now: Date,
): Promise<{ resolved: boolean; scored: boolean; certaintyUpdates: number }> {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) throw new Error("Prediction resolution requires a user principal");
  const evidence = await findOutcomeEvidence(prediction);
  if (!evidence && now < prediction.expectedAt) return { resolved: false, scored: false, certaintyUpdates: 0 };
  const outcome = evidence?.outcome ?? "unobservable";
  const actualValue = outcome === "confirmed" ? 1 as const : outcome === "refuted" ? 0 as const : null;
  const scores = actualValue == null ? null : properScores(prediction.probability, actualValue);
  const replayKey = hashKey(["prediction-resolution", PREDICTION_DERIVATION_VERSION, prediction.id, outcome, evidence?.outcomeClaim.id ?? 0]);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`memory-vnext-prediction:${principal.userId}:${prediction.id}`}))`);
    const [existing] = await tx.select().from(memoryVnextPredictionResolutions)
      .where(combineWithVisibleScope(principal, resolutionScope, eq(memoryVnextPredictionResolutions.replayKey, replayKey))).limit(1);
    if (existing) return { resolved: false, scored: false, certaintyUpdates: 0 };
    const [activeResolution] = await tx.select().from(memoryVnextPredictionResolutions)
      .where(combineWithVisibleScope(principal, resolutionScope, and(
        eq(memoryVnextPredictionResolutions.predictionId, prediction.id),
        sql`${memoryVnextPredictionResolutions.outcome} <> 'superseded'`,
      ))).limit(1);
    if (activeResolution) return { resolved: false, scored: false, certaintyUpdates: 0 };
    const evidenceSnapshot = evidence ? {
      evidenceCutoff: prediction.generatedAt.toISOString(),
      observedOutcomeClaimId: evidence.outcomeClaim.id,
      outcomeRelationshipLinkId: evidence.relationship.id,
      outcomeRelationship: evidence.relationship.relationship,
      outcomeRelationshipCertainty: evidence.relationship.certainty,
      sourceRefIds: evidence.sourceRefIds,
      sourceRefsBecameVisibleAfterForecast: true,
    } : {
      evidenceCutoff: prediction.generatedAt.toISOString(),
      expectedAt: prediction.expectedAt.toISOString(),
      noQualifyingLaterEvidence: true,
      scored: false,
    };
    const [resolution] = await tx.insert(memoryVnextPredictionResolutions).values({
      predictionId: prediction.id,
      replayKey,
      outcome,
      observedOutcomeClaimId: evidence?.outcomeClaim.id ?? null,
      evidenceSourceRefIds: evidence?.sourceRefIds ?? [],
      evidenceSnapshot,
      actualValue,
      brierScore: scores?.brierScore ?? null,
      logScore: scores?.logScore ?? null,
      scoringRuleVersion: PREDICTION_SCORING_RULE_VERSION,
      resolutionMethod: "later_source_backed_claim_relationship",
      derivationVersion: PREDICTION_DERIVATION_VERSION,
      supersedesResolutionId: null,
      resolvedAt: now,
      ...ownedInsertValues(principal, resolutionScope),
      createdByUserId: principal.userId,
    }).returning();
    if (!resolution) throw new Error("Prediction resolution insert failed");
    if (actualValue == null || prediction.causalClaimLinkIds.length === 0) {
      return { resolved: true, scored: false, certaintyUpdates: 0 };
    }
    const links = await tx.select().from(memoryVnextClaimLinks)
      .where(combineWithWritableScope(principal, linkScope, and(
        inArray(memoryVnextClaimLinks.id, prediction.causalClaimLinkIds.slice(0, 20)),
        eq(memoryVnextClaimLinks.relationshipClass, "causal"),
        eq(memoryVnextClaimLinks.epistemicStatus, "causal_hypothesis"),
      ))).limit(20);
    let certaintyUpdates = 0;
    for (const link of links) {
      if (link.certainty == null) continue;
      const requestedDelta = actualValue === 1 ? CONFIRMED_CERTAINTY_DELTA : REFUTED_CERTAINTY_DELTA;
      const resultingCertainty = rounded(clamp01(link.certainty + requestedDelta));
      const appliedDelta = rounded(resultingCertainty - link.certainty);
      if (appliedDelta === 0) continue;
      const eventReplayKey = hashKey([RELATIONSHIP_LEARNING_RULE_VERSION, resolution.id, link.id]);
        const updated = await tx.update(memoryVnextClaimLinks).set({
        certainty: resultingCertainty,
        updatedByUserId: principal.userId,
      }).where(combineWithWritableScope(principal, linkScope, and(
        eq(memoryVnextClaimLinks.id, link.id),
        eq(memoryVnextClaimLinks.certainty, link.certainty),
      ))).returning({ id: memoryVnextClaimLinks.id });
      if (updated.length !== 1) throw new Error(`Relationship certainty changed concurrently for link ${link.id}`);
      const [event] = await tx.insert(memoryVnextRelationshipCertaintyEvents).values({
        predictionId: prediction.id,
        resolutionId: resolution.id,
        claimLinkId: link.id,
        replayKey: eventReplayKey,
        previousCertainty: link.certainty,
        delta: appliedDelta,
        resultingCertainty,
        ruleVersion: RELATIONSHIP_LEARNING_RULE_VERSION,
        provenance: {
          predictionId: prediction.id,
          resolutionId: resolution.id,
          outcome,
          evidenceSourceRefIds: evidence?.sourceRefIds ?? [],
          originalForecastProbability: prediction.probability,
        },
        occurredAt: now,
        ...ownedInsertValues(principal, certaintyEventScope),
        createdByUserId: principal.userId,
      }).returning();
      if (!event) throw new Error(`Relationship certainty audit insert failed for link ${link.id}`);
      certaintyUpdates++;
    }
    return { resolved: true, scored: true, certaintyUpdates };
  });
}

export async function runShadowPredictionLoop(input: { trigger?: string; limit?: number; runKey?: string } = {}): Promise<ShadowPredictionRunResult> {
  const principal = getCurrentPrincipalOrSystem();
  if (!principal.userId || !principal.accountId) throw new Error("Shadow prediction orchestration requires a user principal");
  const startedAt = new Date();
  const trigger = (input.trigger?.trim() || "manual").slice(0, 120);
  const limit = Math.min(Math.max(Math.floor(input.limit ?? MAX_PREDICTIONS_PER_RUN), 1), MAX_PREDICTIONS_PER_RUN);
  const runKey = (input.runKey?.trim() || hashKey([PREDICTION_DERIVATION_METHOD, principal.userId, startedAt.toISOString()])).slice(0, 300);
  const existingRun = (await db.select().from(memoryVnextPredictionRuns)
    .where(combineWithVisibleScope(principal, runScope, eq(memoryVnextPredictionRuns.runKey, runKey))).limit(1))[0];
  if (existingRun) {
    return {
      runId: existingRun.id,
      runKey: existingRun.runKey,
      trigger: existingRun.trigger,
      scannedPaths: existingRun.scannedPaths,
      generated: existingRun.generated,
      abstained: existingRun.abstained,
      resolved: existingRun.resolved,
      scored: existingRun.scored,
      certaintyUpdates: existingRun.certaintyUpdates,
      abstentionReasons: existingRun.abstentionReasons as Partial<Record<AbstentionReason, number>>,
    };
  }
  await recomputeTransitionPaths(MAX_CLAIMS);
  const [paths, graph] = await Promise.all([inspectTransitionPaths({ limit: MAX_PATHS }), loadCandidateGraph()]);
  const abstentionReasons: Partial<Record<AbstentionReason, number>> = {};
  let generated = 0;
  for (const path of paths) {
    if (generated >= limit) {
      addAbstention(abstentionReasons, "run_budget");
      break;
    }
    const candidate = findGenerationCandidate(path, graph, startedAt, abstentionReasons);
    if (!candidate) continue;
    const created = await createPrediction(candidate, startedAt);
    if (created.created) generated++;
  }
  const unresolved = await listUnresolvedPredictions(MAX_RESOLUTIONS_PER_RUN);
  let resolved = 0;
  let scored = 0;
  let certaintyUpdates = 0;
  const now = new Date();
  for (const prediction of unresolved) {
    const result = await resolvePrediction(prediction, now);
    if (result.resolved) resolved++;
    if (result.scored) scored++;
    certaintyUpdates += result.certaintyUpdates;
  }
  const completedAt = new Date();
  const abstained = Object.values(abstentionReasons).reduce((sum, count) => sum + (count ?? 0), 0);
  const [run] = await db.insert(memoryVnextPredictionRuns).values({
    runKey,
    trigger,
    scannedPaths: paths.length,
    generated,
    abstained,
    resolved,
    scored,
    certaintyUpdates,
    abstentionReasons,
    producerMethod: PREDICTION_DERIVATION_METHOD,
    derivationVersion: PREDICTION_DERIVATION_VERSION,
    startedAt,
    completedAt,
    ...ownedInsertValues(principal, runScope),
    createdByUserId: principal.userId,
  }).onConflictDoNothing().returning();
  const storedRun = run ?? (await db.select().from(memoryVnextPredictionRuns)
    .where(combineWithVisibleScope(principal, runScope, eq(memoryVnextPredictionRuns.runKey, runKey))).limit(1))[0];
  if (!storedRun) throw new Error("Prediction run replay conflict could not be resolved");
  const result: ShadowPredictionRunResult = {
    runId: storedRun.id,
    runKey: storedRun.runKey,
    trigger: storedRun.trigger,
    scannedPaths: storedRun.scannedPaths,
    generated: storedRun.generated,
    abstained: storedRun.abstained,
    resolved: storedRun.resolved,
    scored: storedRun.scored,
    certaintyUpdates: storedRun.certaintyUpdates,
    abstentionReasons: storedRun.abstentionReasons as Partial<Record<AbstentionReason, number>>,
  };
  log.info(JSON.stringify({ event: "memory.vnext.shadow_prediction_loop_complete", ...result }));
  return result;
}

export async function inspectPredictionLedger(input: { predictionId?: number; limit?: number } = {}): Promise<PredictionLedgerDetail[]> {
  const principal = getCurrentPrincipalOrSystem();
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 25), 1), MAX_INSPECT);
  const predicate = input.predictionId ? eq(memoryVnextPredictions.id, input.predictionId) : sql`TRUE`;
  const predictions = await db.select().from(memoryVnextPredictions)
    .where(combineWithVisibleScope(principal, predictionScope, predicate))
    .orderBy(desc(memoryVnextPredictions.generatedAt), desc(memoryVnextPredictions.id)).limit(limit);
  if (predictions.length === 0) return [];
  const ids = predictions.map((prediction) => prediction.id);
  const [resolutions, certaintyEvents] = await Promise.all([
    db.select().from(memoryVnextPredictionResolutions)
      .where(combineWithVisibleScope(principal, resolutionScope, inArray(memoryVnextPredictionResolutions.predictionId, ids)))
      .orderBy(asc(memoryVnextPredictionResolutions.resolvedAt), asc(memoryVnextPredictionResolutions.id)),
    db.select().from(memoryVnextRelationshipCertaintyEvents)
      .where(combineWithVisibleScope(principal, certaintyEventScope, inArray(memoryVnextRelationshipCertaintyEvents.predictionId, ids)))
      .orderBy(asc(memoryVnextRelationshipCertaintyEvents.occurredAt), asc(memoryVnextRelationshipCertaintyEvents.id)),
  ]);
  return predictions.map((prediction) => ({
    prediction,
    resolutions: resolutions.filter((resolution) => resolution.predictionId === prediction.id),
    certaintyEvents: certaintyEvents.filter((event) => event.predictionId === prediction.id),
  }));
}

export async function inspectPredictionRuns(limit = 25): Promise<MemoryVnextPredictionRun[]> {
  const principal = getCurrentPrincipalOrSystem();
  return db.select().from(memoryVnextPredictionRuns)
    .where(combineWithVisibleScope(principal, runScope))
    .orderBy(desc(memoryVnextPredictionRuns.completedAt), desc(memoryVnextPredictionRuns.id))
    .limit(Math.min(Math.max(Math.floor(limit), 1), MAX_INSPECT));
}
