import { desc, eq, sql } from "drizzle-orm";
import {
  memoryVnextStrengthEvents,
  type MemoryVnextApplicabilityStatus,
  type MemoryVnextClaim,
  type MemoryVnextClaimLink,
  type MemoryVnextEntityLink,
  type MemoryVnextIntegrationLevel,
  type MemoryVnextSourceRef,
  type MemoryVnextStrengthEvent,
} from "@shared/schema";
import { db } from "../db";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithVisibleScope } from "../scoped-storage";

const DIMENSION_DERIVATION_VERSION = "vnext-orthogonal-v1";
const STRENGTH_HALF_LIFE_DAYS = 60;
const MAX_STRENGTH_EVIDENCE_EVENTS = 25;

// Source evidence rows arrive from the principal-scoped claim storage boundary.
// Source, entity, and claim relationships are loaded through the scoped claim-storage boundary.
const strengthEventScopeColumns = {
  scope: memoryVnextStrengthEvents.scope,
  ownerUserId: memoryVnextStrengthEvents.ownerUserId,
  accountId: memoryVnextStrengthEvents.accountId,
};

export interface VnextClaimDimensions {
  relationships: {
    sourceEvidenceCount: number;
    claimRelationshipCount: number;
    entityRelationshipCount: number;
    sourceRelationshipTypes: string[];
    claimRelationshipTypes: string[];
    assessedRelationshipCertaintyCount: number;
    relationshipCertaintyIsSeparateFromClaimCertainty: true;
  };
  integration: {
    level: MemoryVnextIntegrationLevel;
    method: "relationship_diversity_v1";
    derivationVersion: string;
    evidence: {
      meaningfulClaimRelationshipCount: number;
      claimRelationshipTypeCount: number;
      directionCount: number;
      sourceLineageCount: number;
      entityTypeCount: number;
      contextCount: number;
      assessedRelationshipCertaintyCount: number;
    };
    explanation: string;
  };
  certainty: {
    status: "unassessed" | "supported" | "contested";
    value: number | null;
    method: "lineage_deduplicated_evidence_v1";
    derivationVersion: string;
    evidence: {
      assessedSourceRelationships: number;
      independentLineages: number;
      supportingLineages: number;
      contradictingLineages: number;
      supportAggregate: number;
      contradictionAggregate: number;
      extractionConfidenceExcluded: true;
    };
    explanation: string;
  };
  strength: {
    value: number;
    method: "typed_events_exponential_decay_v1";
    derivationVersion: string;
    halfLifeDays: number;
    eventCount: number;
    decayedEventSum: number;
    latestEventAt: Date | null;
    eventsByType: Record<string, { count: number; decayedWeight: number }>;
    recentEvidence: MemoryVnextStrengthEvent[];
    evidenceLimit: number;
    exposureExcluded: true;
    legacyRecallExcluded: true;
    explanation: string;
  };
  sourceClarity: {
    assessed: number;
    unassessed: number;
    average: number | null;
    evidence: Array<{
      sourceRefId: number;
      sourceType: string;
      sourceId: string;
      relationship: string;
      clarity: number | null;
      relationshipCertainty: number | null;
      sourceLineageKey: string;
      independence: string | null;
      sourceObservedAt: Date | null;
      producerMethod: string | null;
      derivationVersion: string | null;
    }>;
  };
  temporalApplicability: {
    status: MemoryVnextApplicabilityStatus;
    evaluatedAt: Date;
    observedAt: Date | null;
    validFrom: Date | null;
    validUntil: Date | null;
    occurredAt: Date | null;
    expectedBy: Date | null;
    explanation: string;
  };
  compatibility: {
    extractionConfidence: number;
    extractionConfidenceField: "confidence";
    lifecycleStageHasTruthAuthority: false;
    combinedScore: null;
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function rounded(value: number): number {
  return Number(value.toFixed(6));
}

function sourceLineage(ref: MemoryVnextSourceRef): string {
  return ref.sourceLineageKey?.trim() || `${ref.sourceType}:${ref.sourceId}`;
}

function evidencePolarity(relationship: string): "support" | "contradict" | "neutral" {
  if (["supports", "extracted_from", "refines", "qualifies"].includes(relationship)) return "support";
  if (["contradicts", "weakens", "supersedes"].includes(relationship)) return "contradict";
  return "neutral";
}

function deriveCertainty(sources: MemoryVnextSourceRef[]): VnextClaimDimensions["certainty"] {
  const byLineage = new Map<string, { support: number; contradict: number }>();
  let assessedSourceRelationships = 0;
  for (const source of sources) {
    if (source.clarity == null || source.certainty == null) continue;
    const polarity = evidencePolarity(source.relationship);
    if (polarity === "neutral") continue;
    assessedSourceRelationships += 1;
    const lineage = sourceLineage(source);
    const current = byLineage.get(lineage) ?? { support: 0, contradict: 0 };
    const weight = clamp01(source.clarity) * clamp01(source.certainty);
    current[polarity] = Math.max(current[polarity], weight);
    byLineage.set(lineage, current);
  }

  if (assessedSourceRelationships === 0) {
    return {
      status: "unassessed",
      value: null,
      method: "lineage_deduplicated_evidence_v1",
      derivationVersion: DIMENSION_DERIVATION_VERSION,
      evidence: {
        assessedSourceRelationships: 0,
        independentLineages: 0,
        supportingLineages: 0,
        contradictingLineages: 0,
        supportAggregate: 0,
        contradictionAggregate: 0,
        extractionConfidenceExcluded: true,
      },
      explanation: "No source relationship has both clarity and relationship certainty. Extraction confidence is preserved separately and is not substituted.",
    };
  }

  const lineages = [...byLineage.values()];
  const supportAggregate = 1 - lineages.reduce((remaining, row) => remaining * (1 - row.support), 1);
  const contradictionAggregate = 1 - lineages.reduce((remaining, row) => remaining * (1 - row.contradict), 1);
  const value = clamp01(supportAggregate * (1 - contradictionAggregate));
  const contradictingLineages = lineages.filter((row) => row.contradict > 0).length;
  return {
    status: contradictingLineages > 0 ? "contested" : "supported",
    value: rounded(value),
    method: "lineage_deduplicated_evidence_v1",
    derivationVersion: DIMENSION_DERIVATION_VERSION,
    evidence: {
      assessedSourceRelationships,
      independentLineages: byLineage.size,
      supportingLineages: lineages.filter((row) => row.support > 0).length,
      contradictingLineages,
      supportAggregate: rounded(supportAggregate),
      contradictionAggregate: rounded(contradictionAggregate),
      extractionConfidenceExcluded: true,
    },
    explanation: "Evidence is deduplicated by source lineage. Independent support accumulates, contradiction reduces certainty, and retrieval frequency contributes nothing.",
  };
}

function deriveIntegration(
  claimId: number,
  sources: MemoryVnextSourceRef[],
  entityLinks: MemoryVnextEntityLink[],
  claimLinks: MemoryVnextClaimLink[],
): VnextClaimDimensions["integration"] {
  const meaningfulLinks = claimLinks.filter((link) => link.relationship !== "duplicate_of");
  const relationshipTypes = new Set(meaningfulLinks.map((link) => link.relationship));
  const directions = new Set(meaningfulLinks.map((link) => link.fromClaimId === claimId ? "out" : "in"));
  const sourceLineages = new Set(sources.map(sourceLineage));
  const entityTypes = new Set(entityLinks.map((link) => link.entityType));
  const contexts = new Set([
    ...sources.map((source) => source.context.trim()).filter(Boolean),
    ...entityLinks.map((link) => `${link.entityType}:${link.entityId}`),
  ]);
  const assessedRelationshipCertaintyCount = claimLinks.filter((link) => link.certainty != null).length;

  let level: MemoryVnextIntegrationLevel = "isolated";
  if (meaningfulLinks.length > 0 || entityLinks.length > 0) level = "associated";
  if (
    meaningfulLinks.length >= 2 &&
    (relationshipTypes.size >= 2 || directions.size >= 2) &&
    (sourceLineages.size >= 2 || entityTypes.size >= 2 || contexts.size >= 2)
  ) level = "integrated";
  if (
    meaningfulLinks.length >= 4 &&
    relationshipTypes.size >= 3 &&
    directions.size >= 2 &&
    contexts.size >= 3 &&
    assessedRelationshipCertaintyCount >= 2
  ) level = "structural";

  return {
    level,
    method: "relationship_diversity_v1",
    derivationVersion: DIMENSION_DERIVATION_VERSION,
    evidence: {
      meaningfulClaimRelationshipCount: meaningfulLinks.length,
      claimRelationshipTypeCount: relationshipTypes.size,
      directionCount: directions.size,
      sourceLineageCount: sourceLineages.size,
      entityTypeCount: entityTypes.size,
      contextCount: contexts.size,
      assessedRelationshipCertaintyCount,
    },
    explanation: "Integration uses relationship type, direction, source lineage, entity, context, and certainty coverage. Raw link count alone cannot advance the level.",
  };
}

function deriveTemporalApplicability(claim: MemoryVnextClaim, evaluatedAt: Date): VnextClaimDimensions["temporalApplicability"] {
  let status: MemoryVnextApplicabilityStatus = "unknown";
  if (claim.validUntil && claim.validUntil < evaluatedAt) status = "expired";
  else if (claim.validFrom && claim.validFrom > evaluatedAt) status = "upcoming";
  else if (claim.validFrom || claim.validUntil) status = "current";
  else if (claim.occurredAt || claim.observedAt) status = "historical";
  return {
    status,
    evaluatedAt,
    observedAt: claim.observedAt,
    validFrom: claim.validFrom,
    validUntil: claim.validUntil,
    occurredAt: claim.occurredAt,
    expectedBy: claim.expectedBy,
    explanation: "Applicability is derived only from explicit claim time metadata. Expiry changes current applicability without rewriting historical truth.",
  };
}

async function deriveStrength(claimId: number): Promise<VnextClaimDimensions["strength"]> {
  const principal = getCurrentPrincipalOrSystem();
  const visibility = combineWithVisibleScope(
    principal,
    strengthEventScopeColumns,
    eq(memoryVnextStrengthEvents.claimId, claimId),
  );
  const [rows, recentEvidence] = await Promise.all([
    db.select({
      eventType: memoryVnextStrengthEvents.eventType,
      count: sql<number>`count(*)::int`,
      decayedWeight: sql<number>`COALESCE(sum(${memoryVnextStrengthEvents.weight} * power(0.5, extract(epoch from (CURRENT_TIMESTAMP - ${memoryVnextStrengthEvents.occurredAt})) / ${STRENGTH_HALF_LIFE_DAYS * 86_400})), 0)::real`,
      latestEventAt: sql<Date | null>`max(${memoryVnextStrengthEvents.occurredAt})`,
    })
      .from(memoryVnextStrengthEvents)
      .where(visibility)
      .groupBy(memoryVnextStrengthEvents.eventType),
    db.select()
      .from(memoryVnextStrengthEvents)
      .where(visibility)
      .orderBy(desc(memoryVnextStrengthEvents.occurredAt), desc(memoryVnextStrengthEvents.id))
      .limit(MAX_STRENGTH_EVIDENCE_EVENTS),
  ]);
  const eventsByType: Record<string, { count: number; decayedWeight: number }> = {};
  let eventCount = 0;
  let decayedEventSum = 0;
  let latestEventAt: Date | null = null;
  for (const row of rows) {
    const count = Number(row.count ?? 0);
    const decayedWeight = Number(row.decayedWeight ?? 0);
    eventsByType[row.eventType] = { count, decayedWeight: rounded(decayedWeight) };
    eventCount += count;
    decayedEventSum += decayedWeight;
    if (row.latestEventAt && (!latestEventAt || row.latestEventAt > latestEventAt)) latestEventAt = row.latestEventAt;
  }
  return {
    value: rounded(clamp01(decayedEventSum)),
    method: "typed_events_exponential_decay_v1",
    derivationVersion: DIMENSION_DERIVATION_VERSION,
    halfLifeDays: STRENGTH_HALF_LIFE_DAYS,
    eventCount,
    decayedEventSum: rounded(decayedEventSum),
    latestEventAt,
    eventsByType,
    recentEvidence,
    evidenceLimit: MAX_STRENGTH_EVIDENCE_EVENTS,
    exposureExcluded: true,
    legacyRecallExcluded: true,
    explanation: "Strength is the bounded sum of valid typed event weights after 60-day exponential decay. Passive exposure and legacy recall telemetry contribute zero.",
  };
}

export async function deriveVnextClaimDimensions(input: {
  claim: MemoryVnextClaim;
  sources: MemoryVnextSourceRef[];
  entityLinks: MemoryVnextEntityLink[];
  claimLinks: MemoryVnextClaimLink[];
  evaluatedAt?: Date;
}): Promise<VnextClaimDimensions> {
  const { claim, sources, entityLinks, claimLinks } = input;
  const evaluatedAt = input.evaluatedAt ?? new Date();
  const certainty = deriveCertainty(sources);
  const integration = deriveIntegration(claim.id, sources, entityLinks, claimLinks);
  const clarityValues = sources.flatMap((source) => source.clarity == null ? [] : [clamp01(source.clarity)]);
  const strength = await deriveStrength(claim.id);
  return {
    relationships: {
      sourceEvidenceCount: sources.length,
      claimRelationshipCount: claimLinks.length,
      entityRelationshipCount: entityLinks.length,
      sourceRelationshipTypes: [...new Set(sources.map((source) => source.relationship))].sort(),
      claimRelationshipTypes: [...new Set(claimLinks.map((link) => link.relationship))].sort(),
      assessedRelationshipCertaintyCount: sources.filter((source) => source.certainty != null).length + claimLinks.filter((link) => link.certainty != null).length,
      relationshipCertaintyIsSeparateFromClaimCertainty: true,
    },
    integration,
    certainty,
    strength,
    sourceClarity: {
      assessed: clarityValues.length,
      unassessed: sources.length - clarityValues.length,
      average: clarityValues.length === 0 ? null : rounded(clarityValues.reduce((sum, value) => sum + value, 0) / clarityValues.length),
      evidence: sources.map((source) => ({
        sourceRefId: source.id,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        relationship: source.relationship,
        clarity: source.clarity,
        relationshipCertainty: source.certainty,
        sourceLineageKey: sourceLineage(source),
        independence: source.independence,
        sourceObservedAt: source.sourceObservedAt,
        producerMethod: source.producerMethod,
        derivationVersion: source.derivationVersion,
      })),
    },
    temporalApplicability: deriveTemporalApplicability(claim, evaluatedAt),
    compatibility: {
      extractionConfidence: claim.confidence,
      extractionConfidenceField: "confidence",
      lifecycleStageHasTruthAuthority: false,
      combinedScore: null,
    },
  };
}
