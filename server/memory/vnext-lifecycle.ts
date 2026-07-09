import { createLogger } from "../log";
import { MEMORY_VNEXT_LIFECYCLE_STAGE, type MemoryVnextClaim } from "@shared/schema";
import { memoryVnextClaimStorage, type VnextLifecycleCandidate } from "./vnext-claim-storage";
import { resolveVnextEntityMentions } from "./vnext-entity-resolution";

const log = createLogger("MemoryVnextLifecycle");

const DEFAULT_BATCH_LIMIT = 50;
const CANONICAL_CONFIDENCE_THRESHOLD = 0.75;
const LOW_VALUE_ACTION_CONFIDENCE_THRESHOLD = 0.45;
const STALE_ACTION_AGE_DAYS = 30;

/** Claims below this confidence + older than RETIREMENT_STALE_DAYS + no recent recall = retired */
const RETIREMENT_CONFIDENCE_FLOOR = 0.3;
const RETIREMENT_STALE_DAYS = 21;

/** Per-run confidence decay applied to canonical claims with no recall in DECAY_UNREINFORCED_DAYS */
const DECAY_UNREINFORCED_DAYS = 14;
const DECAY_DELTA = 0.05;

export interface VnextLifecycleRunOptions {
  limit?: number;
  trigger?: string;
}

export interface VnextLifecycleRunResult {
  runId: string;
  trigger: string;
  scanned: number;
  candidateCounts: Record<string, number>;
  sourced: number;
  linked: number;
  canonicalized: number;
  retired: number;
  retiredByReason: Record<string, number>;
  decayed: number;
  skipped: number;
  skippedByReason: Partial<Record<LifecycleSkipReason, number>>;
  errors: number;
}

type LifecycleSkipReason =
  | "no_source_refs"
  | "unresolved_entities"
  | "no_links"
  | "canonical_criteria_not_met"
  | "already_terminal";

function createRunId(): string {
  return `vnext_lifecycle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function logLifecycle(event: string, payload: Record<string, unknown>, level: "debug" | "info" | "warn" | "error" = "info"): void {
  log[level](JSON.stringify({ event, ...payload }));
}

function recordSkip(result: VnextLifecycleRunResult, reason: LifecycleSkipReason): void {
  result.skipped++;
  result.skippedByReason[reason] = (result.skippedByReason[reason] ?? 0) + 1;
}

function recordRetirement(result: VnextLifecycleRunResult, reason: string): void {
  result.retired++;
  result.retiredByReason[reason] = (result.retiredByReason[reason] ?? 0) + 1;
}

function parseEntityMentions(claim: MemoryVnextClaim): Array<{ name: string; entityType: "person" | "project" | "goal" }> {
  if (!Array.isArray(claim.entityMentions)) return [];
  return claim.entityMentions.flatMap((mention) => {
    if (!mention || typeof mention !== "object") return [];
    const value = mention as Record<string, unknown>;
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const entityType = typeof value.entityType === "string" ? value.entityType : "";
    if (!name || (entityType !== "person" && entityType !== "project" && entityType !== "goal")) return [];
    return [{ name, entityType }];
  });
}

function isOlderThanDays(date: Date, days: number): boolean {
  return Date.now() - date.getTime() > days * 24 * 60 * 60 * 1000;
}

function hasContradictionOrSupersession(candidate: VnextLifecycleCandidate): boolean {
  const metadata = (candidate.claim.metadata as Record<string, unknown> | null) ?? {};
  return Boolean(metadata.contradictedByClaimId || metadata.supersededByClaimId);
}

function hasNotBeenRecalledSince(claim: MemoryVnextClaim, days: number): boolean {
  if (!claim.lastRecalledAt) return true;
  return isOlderThanDays(claim.lastRecalledAt, days);
}

function shouldRetire(candidate: VnextLifecycleCandidate): { shouldRetire: boolean; reason?: string; metadata?: Record<string, unknown> } {
  // 1. Duplicate content hash
  if (candidate.duplicateCount > 0) {
    return {
      shouldRetire: true,
      reason: "duplicate_content_hash",
      metadata: { duplicateCount: candidate.duplicateCount },
    };
  }

  // 2. Contradicted or superseded
  if (hasContradictionOrSupersession(candidate)) {
    return { shouldRetire: true, reason: "contradicted_or_superseded" };
  }

  // 3. Stale low-confidence action claim
  if (
    candidate.claim.claimType === "action" &&
    candidate.claim.confidence < LOW_VALUE_ACTION_CONFIDENCE_THRESHOLD &&
    isOlderThanDays(candidate.claim.createdAt, STALE_ACTION_AGE_DAYS)
  ) {
    return {
      shouldRetire: true,
      reason: "stale_low_confidence_action",
      metadata: {
        confidence: candidate.claim.confidence,
        staleAfterDays: STALE_ACTION_AGE_DAYS,
      },
    };
  }

  // 4. Generic low-confidence + stale + no recall (any claim type)
  if (
    candidate.claim.confidence < RETIREMENT_CONFIDENCE_FLOOR &&
    isOlderThanDays(candidate.claim.createdAt, RETIREMENT_STALE_DAYS) &&
    hasNotBeenRecalledSince(candidate.claim, RETIREMENT_STALE_DAYS)
  ) {
    return {
      shouldRetire: true,
      reason: "low_confidence_stale_unrecalled",
      metadata: {
        confidence: candidate.claim.confidence,
        staleDays: RETIREMENT_STALE_DAYS,
        lastRecalledAt: candidate.claim.lastRecalledAt?.toISOString() ?? null,
      },
    };
  }

  // 5. Canonical claims that have decayed below floor
  if (
    candidate.claim.lifecycleStage === MEMORY_VNEXT_LIFECYCLE_STAGE.CANONICAL &&
    candidate.claim.confidence < RETIREMENT_CONFIDENCE_FLOOR &&
    hasNotBeenRecalledSince(candidate.claim, RETIREMENT_STALE_DAYS)
  ) {
    return {
      shouldRetire: true,
      reason: "canonical_decayed_below_floor",
      metadata: {
        confidence: candidate.claim.confidence,
        lastRecalledAt: candidate.claim.lastRecalledAt?.toISOString() ?? null,
      },
    };
  }

  return { shouldRetire: false };
}

/**
 * Decay confidence on canonical claims that haven't been recalled recently.
 * This makes retirement criteria reachable over time.
 */
async function decayCanonicalConfidence(candidate: VnextLifecycleCandidate, runId: string): Promise<boolean> {
  if (candidate.claim.lifecycleStage !== MEMORY_VNEXT_LIFECYCLE_STAGE.CANONICAL) return false;
  if (!hasNotBeenRecalledSince(candidate.claim, DECAY_UNREINFORCED_DAYS)) return false;
  // Don't decay below minimum (decayClaimConfidence already floors at 0.1)
  if (candidate.claim.confidence <= 0.1) return false;

  await memoryVnextClaimStorage.decayClaimConfidence(candidate.claim.id, DECAY_DELTA);
  logLifecycle("memory.vnext.confidence_decayed", {
    runId,
    claimId: candidate.claim.id,
    from: candidate.claim.confidence,
    to: Math.max(0.1, candidate.claim.confidence - DECAY_DELTA),
    delta: DECAY_DELTA,
    unreinforcedDays: DECAY_UNREINFORCED_DAYS,
  }, "debug");
  return true;
}

function canCanonicalize(candidate: VnextLifecycleCandidate): boolean {
  if (candidate.claim.lifecycleStage !== MEMORY_VNEXT_LIFECYCLE_STAGE.LINKED) return false;
  if (candidate.claim.confidence < CANONICAL_CONFIDENCE_THRESHOLD) return false;
  if (candidate.sourceRefCount < 1) return false;
  if (candidate.entityLinkCount + candidate.claimLinkCount < 1) return false;
  if (candidate.duplicateCount > 0) return false;
  if (hasContradictionOrSupersession(candidate)) return false;
  return true;
}

async function advanceSourced(candidate: VnextLifecycleCandidate, runId: string, result: VnextLifecycleRunResult): Promise<boolean> {
  if (candidate.claim.lifecycleStage !== MEMORY_VNEXT_LIFECYCLE_STAGE.EXTRACTED) return false;
  if (candidate.sourceRefCount < 1) {
    recordSkip(result, "no_source_refs");
    logLifecycle("memory.vnext.lifecycle_skipped", {
      runId,
      claimId: candidate.claim.id,
      stage: candidate.claim.lifecycleStage,
      reason: "no_source_refs" satisfies LifecycleSkipReason,
    }, "debug");
    return false;
  }
  await memoryVnextClaimStorage.advanceLifecycleStage(candidate.claim.id, MEMORY_VNEXT_LIFECYCLE_STAGE.SOURCED, {
    reason: "source_refs_present",
    metadata: { lifecycleEvidence: { sourceRefCount: candidate.sourceRefCount } },
  });
  return true;
}

async function ensureLinks(candidate: VnextLifecycleCandidate, runId: string, result: VnextLifecycleRunResult): Promise<boolean> {
  if (candidate.claim.lifecycleStage !== MEMORY_VNEXT_LIFECYCLE_STAGE.SOURCED) return false;
  if (candidate.entityLinkCount + candidate.claimLinkCount > 0) {
    await memoryVnextClaimStorage.advanceLifecycleStage(candidate.claim.id, MEMORY_VNEXT_LIFECYCLE_STAGE.LINKED, {
      reason: "existing_links_present",
      metadata: {
        lifecycleEvidence: {
          entityLinkCount: candidate.entityLinkCount,
          claimLinkCount: candidate.claimLinkCount,
        },
      },
    });
    return true;
  }

  const mentions = parseEntityMentions(candidate.claim);
  if (mentions.length > 0) {
    const resolved = await resolveVnextEntityMentions(mentions);
    for (const entity of resolved) {
      await memoryVnextClaimStorage.linkClaimToEntity(candidate.claim.id, entity.entityType, entity.entityId);
    }
    if (resolved.length > 0) {
      logLifecycle("memory.vnext.entity_links_created", {
        runId,
        claimId: candidate.claim.id,
        count: resolved.length,
      }, "info");
      return true;
    }
    recordSkip(result, "unresolved_entities");
    logLifecycle("memory.vnext.lifecycle_skipped", {
      runId,
      claimId: candidate.claim.id,
      stage: candidate.claim.lifecycleStage,
      reason: "unresolved_entities" satisfies LifecycleSkipReason,
      mentions: mentions.length,
    }, "debug");
    return false;
  }

  recordSkip(result, "no_links");
  logLifecycle("memory.vnext.lifecycle_skipped", {
    runId,
    claimId: candidate.claim.id,
    stage: candidate.claim.lifecycleStage,
    reason: "no_links" satisfies LifecycleSkipReason,
  }, "debug");
  return false;
}

async function finalizeClaim(candidate: VnextLifecycleCandidate, runId: string, result: VnextLifecycleRunResult): Promise<"canonicalized" | "retired" | "skipped"> {
  if (candidate.claim.lifecycleStage === MEMORY_VNEXT_LIFECYCLE_STAGE.RETIRED) {
    recordSkip(result, "already_terminal");
    logLifecycle("memory.vnext.lifecycle_skipped", {
      runId,
      claimId: candidate.claim.id,
      stage: candidate.claim.lifecycleStage,
      reason: "already_terminal" satisfies LifecycleSkipReason,
    }, "debug");
    return "skipped";
  }

  const retireDecision = shouldRetire(candidate);
  if (retireDecision.shouldRetire) {
    await memoryVnextClaimStorage.retireClaim(candidate.claim.id, {
      reason: retireDecision.reason ?? "safe_retirement_criteria_met",
      metadata: retireDecision.metadata,
    });
    recordRetirement(result, retireDecision.reason ?? "safe_retirement_criteria_met");
    return "retired";
  }

  if (canCanonicalize(candidate)) {
    await memoryVnextClaimStorage.advanceLifecycleStage(candidate.claim.id, MEMORY_VNEXT_LIFECYCLE_STAGE.CANONICAL, {
      reason: "high_confidence_source_backed_linked_claim",
      metadata: {
        lifecycleEvidence: {
          confidence: candidate.claim.confidence,
          sourceRefCount: candidate.sourceRefCount,
          entityLinkCount: candidate.entityLinkCount,
          claimLinkCount: candidate.claimLinkCount,
        },
      },
    });
    return "canonicalized";
  }

  recordSkip(result, "canonical_criteria_not_met");
  logLifecycle("memory.vnext.lifecycle_skipped", {
    runId,
    claimId: candidate.claim.id,
    stage: candidate.claim.lifecycleStage,
    reason: "canonical_criteria_not_met" satisfies LifecycleSkipReason,
    confidence: candidate.claim.confidence,
    sourceRefCount: candidate.sourceRefCount,
    entityLinkCount: candidate.entityLinkCount,
    claimLinkCount: candidate.claimLinkCount,
    duplicateCount: candidate.duplicateCount,
  }, "debug");
  return "skipped";
}

export async function runVnextLifecycle(options: VnextLifecycleRunOptions = {}): Promise<VnextLifecycleRunResult> {
  const runId = createRunId();
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_BATCH_LIMIT, 1), 200);
  const trigger = options.trigger ?? "manual";
  const result: VnextLifecycleRunResult = {
    runId,
    trigger,
    scanned: 0,
    candidateCounts: {},
    sourced: 0,
    linked: 0,
    canonicalized: 0,
    retired: 0,
    retiredByReason: {},
    decayed: 0,
    skipped: 0,
    skippedByReason: {},
    errors: 0,
  };

  logLifecycle("memory.vnext.lifecycle_start", {
    runId,
    trigger,
    limit,
  }, "info");

  // Include CANONICAL stage so retirement and confidence decay can act on mature claims
  const candidates = await memoryVnextClaimStorage.listLifecycleCandidates([
    MEMORY_VNEXT_LIFECYCLE_STAGE.EXTRACTED,
    MEMORY_VNEXT_LIFECYCLE_STAGE.SOURCED,
    MEMORY_VNEXT_LIFECYCLE_STAGE.LINKED,
    MEMORY_VNEXT_LIFECYCLE_STAGE.CANONICAL,
  ], limit);
  result.scanned = candidates.length;

  result.candidateCounts = candidates.reduce<Record<string, number>>((acc, candidate) => {
    acc[candidate.claim.lifecycleStage] = (acc[candidate.claim.lifecycleStage] ?? 0) + 1;
    return acc;
  }, {});

  logLifecycle("memory.vnext.lifecycle_candidates", {
    runId,
    count: candidates.length,
    stages: result.candidateCounts,
  }, "info");

  for (const candidate of candidates) {
    try {
      // Check retirement first, regardless of stage
      const retireDecision = shouldRetire(candidate);
      if (retireDecision.shouldRetire) {
        await memoryVnextClaimStorage.retireClaim(candidate.claim.id, {
          reason: retireDecision.reason ?? "safe_retirement_criteria_met",
          metadata: retireDecision.metadata,
        });
        recordRetirement(result, retireDecision.reason ?? "safe_retirement_criteria_met");
        continue;
      }

      // For canonical claims: apply confidence decay if unreinforced
      if (candidate.claim.lifecycleStage === MEMORY_VNEXT_LIFECYCLE_STAGE.CANONICAL) {
        const decayed = await decayCanonicalConfidence(candidate, runId);
        if (decayed) result.decayed++;
        continue;
      }

      if (candidate.claim.lifecycleStage === MEMORY_VNEXT_LIFECYCLE_STAGE.EXTRACTED) {
        const sourced = await advanceSourced(candidate, runId, result);
        if (sourced) result.sourced++;
        continue;
      }

      if (candidate.claim.lifecycleStage === MEMORY_VNEXT_LIFECYCLE_STAGE.SOURCED) {
        const linked = await ensureLinks(candidate, runId, result);
        if (linked) result.linked++;
        continue;
      }

      const finalState = await finalizeClaim(candidate, runId, result);
      if (finalState === "canonicalized") result.canonicalized++;
      // retirements already counted via recordRetirement in finalizeClaim
    } catch (err: unknown) {
      result.errors++;
      logLifecycle("memory.vnext.lifecycle_error", {
        runId,
        claimId: candidate.claim.id,
        stage: candidate.claim.lifecycleStage,
        error: err instanceof Error ? err.message : String(err),
      }, "warn");
    }
  }

  // Log retirement summary at info level when retirements occurred
  if (result.retired > 0) {
    logLifecycle("memory.vnext.retirement_summary", {
      runId,
      count: result.retired,
      byReason: result.retiredByReason,
    }, "info");
  }

  logLifecycle("memory.vnext.lifecycle_complete", result, result.errors > 0 ? "warn" : "info");
  return result;
}
