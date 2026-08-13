import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, ne } from "drizzle-orm";

import { memoryVnextClaims, memoryVnextSourceRefs } from "@shared/schema";
import { db } from "../db";
import { eventBus } from "../event-bus";
import { createLogger } from "../log";
import { requireCurrentUserPrincipal } from "../principal-context";
import { combineWithVisibleScope } from "../scoped-storage";
import { applyObservation } from "./vnext-claim-storage";

const log = createLogger("MetacognitiveObservations");

export const METACOGNITIVE_OBSERVATION_TYPES = [
  "pattern",
  "gap",
  "change",
  "connection",
  "opportunity",
] as const;

export type MetacognitiveObservationType = (typeof METACOGNITIVE_OBSERVATION_TYPES)[number];

export interface MetacognitiveObservation {
  id: string;
  claimId: number;
  type: MetacognitiveObservationType;
  content: string;
  observedAt: Date;
}

interface RecordMetacognitiveObservationInput {
  type: MetacognitiveObservationType;
  content: string;
  sessionId?: string | null;
}

const claimScopeColumns = {
  scope: memoryVnextClaims.scope,
  ownerUserId: memoryVnextClaims.ownerUserId,
  accountId: memoryVnextClaims.accountId,
  instanceId: memoryVnextClaims.instanceId,
};

const sourceScopeColumns = {
  scope: memoryVnextSourceRefs.scope,
  ownerUserId: memoryVnextSourceRefs.ownerUserId,
  accountId: memoryVnextSourceRefs.accountId,
  instanceId: memoryVnextSourceRefs.instanceId,
};

export function isMetacognitiveObservationType(value: unknown): value is MetacognitiveObservationType {
  return typeof value === "string" && METACOGNITIVE_OBSERVATION_TYPES.includes(value as MetacognitiveObservationType);
}

export async function recordMetacognitiveObservation(
  input: RecordMetacognitiveObservationInput,
): Promise<MetacognitiveObservation> {
  const content = input.content.trim();
  if (!content) throw new Error("Observation content is required");
  if (content.length > 4_000) throw new Error("Observation content exceeds 4000 characters");

  const observationId = randomUUID();
  const observedAt = new Date();
  const result = await applyObservation({
    claims: [{
      title: input.type,
      content,
      claimType: "state",
      confidence: 0.55,
      clarity: 0.6,
      evidenceQuote: content,
      topics: ["metacognition", input.type],
      entityMentions: [],
    }],
    source: "tool",
    sourceId: observationId,
    sourceRefs: [{
      sourceType: "observation",
      sourceId: observationId,
      relationship: "model_asserted",
      context: `Provisional ${input.type} observation authored by the model`,
      quote: content,
      clarity: 0.6,
      certainty: 0.55,
      sourceObservedAt: observedAt,
      sourceLineageKey: `model-observation:${observationId}`,
      independence: "unknown",
      producerMethod: "cognition.observe",
      derivationVersion: "metacognitive-observation-v1",
      provenance: {
        author: "model",
        assertionStatus: "provisional",
        observationType: input.type,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
    }],
    createdAt: observedAt,
    metadata: {
      assertionStatus: "provisional",
      assertionKind: "metacognitive_observation",
      observationType: input.type,
      authoredBy: "model",
    },
    logPrefix: "recordMetacognitiveObservation",
  });

  const claimId = result.persistedClaimIds[0];
  if (!claimId) throw new Error("Observation claim was not persisted");

  eventBus.publish({
    category: "system",
    event: "data:thoughts_changed",
    payload: { source: "memory_vnext", action: "observation_recorded", observationId },
  });
  log.info(JSON.stringify({
    event: "memory.metacognitive_observation_recorded",
    observationId,
    claimId,
    type: input.type,
    outcome: result.outcome,
  }));

  return { id: observationId, claimId, type: input.type, content, observedAt };
}

export async function listRecentMetacognitiveObservations(
  maxAgeMs: number,
  limit: number,
): Promise<MetacognitiveObservation[]> {
  const principal = requireCurrentUserPrincipal();
  const cutoff = new Date(Date.now() - Math.max(1, maxAgeMs));
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
  const rows = await db
    .select({
      id: memoryVnextSourceRefs.sourceId,
      claimId: memoryVnextClaims.id,
      content: memoryVnextClaims.content,
      observedAt: memoryVnextSourceRefs.sourceObservedAt,
      provenance: memoryVnextSourceRefs.provenance,
    })
    .from(memoryVnextSourceRefs)
    .innerJoin(
      memoryVnextClaims,
      and(
        eq(memoryVnextClaims.id, memoryVnextSourceRefs.claimId),
        combineWithVisibleScope(principal, claimScopeColumns),
        ne(memoryVnextClaims.lifecycleStage, "retired"),
      ),
    )
    .where(combineWithVisibleScope(
      principal,
      sourceScopeColumns,
      and(
        eq(memoryVnextSourceRefs.sourceType, "observation"),
        gte(memoryVnextSourceRefs.sourceObservedAt, cutoff),
      ),
    ))
    .orderBy(desc(memoryVnextSourceRefs.sourceObservedAt))
    .limit(boundedLimit);

  return rows.flatMap((row) => {
    const provenance = row.provenance && typeof row.provenance === "object"
      ? row.provenance as Record<string, unknown>
      : {};
    const type = provenance.observationType;
    if (!isMetacognitiveObservationType(type)) return [];
    return [{
      id: row.id,
      claimId: row.claimId,
      type,
      content: row.content,
      observedAt: row.observedAt ?? cutoff,
    }];
  });
}
