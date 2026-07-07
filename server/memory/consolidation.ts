import { memoryStorage, isDuplicateLayerConstraintError, executeSemanticSearch } from "./memory-storage";
import { executeVnextClaimSemanticSearch, memoryVnextClaimStorage } from "./vnext-claim-storage";
import { resolveVnextEntityMentions } from "./vnext-entity-resolution";
import { tryMergeWithExistingMid } from "./memory-transitions";
import { eventBus } from "../event-bus";
import { MEMORY_INTEGRATION_STAGE } from "@shared/schema";
import type { MemoryEntry, MemoryLayer, MemorySource } from "@shared/schema";
import { getSetting, setSetting } from "../system-settings";
import { createLogger } from "../log";
import type { ClaimCandidate, EnrichmentWithClaims } from "./memory-enrichment";

type Logger = ReturnType<typeof createLogger>;

const log = createLogger("Consolidation");
const intLog = createLogger("Integration");
const sweepLog = createLogger("StageOneSweep");

async function resolveDuplicateEntry(
  entry: MemoryEntry,
  targetLayer: MemoryLayer,
  logger: Logger
): Promise<boolean> {
  try {
    if (entry.source && entry.sourceId) {
      const target = await memoryStorage.findDuplicateInLayer(targetLayer, entry.source as any, entry.sourceId, entry.id);
      if (target) {
        const transferred = await memoryStorage.transferLinks(entry.id, target.id);
        if (transferred > 0) logger.log(`Transferred ${transferred} links from #${entry.id} to #${target.id}`);
        await memoryStorage.deleteEntry(entry.id);
        return true;
      }
      logger.warn(`No target found in ${targetLayer} for entry #${entry.id} (source=${entry.source}, sourceId=${entry.sourceId}) — skipping delete to preserve data`);
      return false;
    }
    await memoryStorage.deleteEntry(entry.id);
    return true;
  } catch (err: unknown) {
    logger.warn(`Failed to clean up source entry #${entry.id} after duplicate resolution: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
const CONSOLIDATION_SETTINGS_KEY = "memory.consolidation.thresholds";
const INTEGRATION_SETTINGS_KEY = "memory.integration.thresholds";
const CLAIM_EXTRACTION_BUDGET_SETTINGS_KEY = "memory.vnext.extractionBudget";
const CLAIM_EXTRACTION_BUDGET_DEFAULT = 3;
const CLAIM_EXTRACTION_BUDGET_MIN = 1;
const CLAIM_EXTRACTION_BUDGET_MAX = 3;

interface ClaimExtractionBudgetSettings {
  maxClaimsPerSession?: number;
}

interface ClaimBudgetDecision {
  claim: ClaimCandidate;
  originalIndex: number;
  score: number;
  reasons: string[];
  rejectedReason?: string;
}

const STAGE_ONE_SWEEP_DEFAULTS = {
  minAgeMs: 30 * 60 * 1000,
  touchDelayMs: 10 * 60 * 1000,
  staleProcessingMs: 60 * 60 * 1000,
  batchCap: 50,
  runtimeCapMs: 2 * 60 * 1000,
  linkLimit: 3,
};

interface StageOneSweepResult {
  status: "completed" | "already_running";
  claimed: number;
  advanced: number;
  failed: number;
  skipped: number;
  elapsedMs: number;
  runtimeCapped: boolean;
}

let stageOneSweepRunning = false;

function buildStageOneSweepRunId(): string {
  return `stage-one-sweep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function tryAcquireStageOneSweepDbLock(): Promise<boolean> {
  const { db } = await import("../db");
  const { sql: drizzleSql } = await import("drizzle-orm");
  const result = await db.execute(drizzleSql`SELECT pg_try_advisory_lock(hashtext('memory.stage_one_sweep')) AS acquired`);
  return Boolean((result.rows[0] as { acquired?: boolean } | undefined)?.acquired);
}

async function releaseStageOneSweepDbLock(): Promise<void> {
  const { db } = await import("../db");
  const { sql: drizzleSql } = await import("drizzle-orm");
  await db.execute(drizzleSql`SELECT pg_advisory_unlock(hashtext('memory.stage_one_sweep'))`);
}

export interface ConsolidationThresholds {
  triggerCapacity: number;
  targetCapacity: number;
}

export const CONSOLIDATION_DEFAULTS: ConsolidationThresholds = {
  triggerCapacity: 20000,
  targetCapacity: 8000,
};

interface ConsolidationState {
  running: boolean;
  layer: string;
  current: number;
  total: number;
  detail: string;
  startedAt: number | null;
  pendingRecheck: boolean;
  startingTokens: number | null;
  currentTokens: number | null;
}

const state: ConsolidationState = {
  running: false,
  layer: "",
  current: 0,
  total: 0,
  detail: "",
  startedAt: null,
  pendingRecheck: false,
  startingTokens: null,
  currentTokens: null,
};

let consolidationMutexHolder: symbol | null = null;

function tryAcquireConsolidationMutex(): symbol | null {
  if (consolidationMutexHolder !== null) return null;
  const token = Symbol("consolidation-mutex");
  consolidationMutexHolder = token;
  return token;
}

function releaseConsolidationMutex(token: symbol): void {
  if (consolidationMutexHolder === token) {
    consolidationMutexHolder = null;
  }
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export async function estimateShortTermTokens(): Promise<number> {
  const entries = await memoryStorage.getLayer("short", 500, 0);
  let total = 0;
  for (const entry of entries) {
    total += estimateTokens(entry.content);
  }
  return total;
}

export async function getThresholds(): Promise<ConsolidationThresholds> {
  try {
    const stored = await getSetting<ConsolidationThresholds>(CONSOLIDATION_SETTINGS_KEY);
    if (stored) {
      return {
        triggerCapacity: stored.triggerCapacity ?? CONSOLIDATION_DEFAULTS.triggerCapacity,
        targetCapacity: stored.targetCapacity ?? CONSOLIDATION_DEFAULTS.targetCapacity,
      };
    }
    return { ...CONSOLIDATION_DEFAULTS };
  } catch (err) {
    log.warn("Failed to read consolidation thresholds from database, using defaults", err);
    return { ...CONSOLIDATION_DEFAULTS };
  }
}

export async function setThresholds(update: Partial<ConsolidationThresholds>): Promise<ConsolidationThresholds> {
  const current = await getThresholds();
  const merged = {
    triggerCapacity: update.triggerCapacity ?? current.triggerCapacity,
    targetCapacity: update.targetCapacity ?? current.targetCapacity,
  };
  await setSetting(CONSOLIDATION_SETTINGS_KEY, merged);
  log.debug(`Thresholds updated: triggerCapacity=${merged.triggerCapacity}, targetCapacity=${merged.targetCapacity}`);
  return merged;
}

export function isConsolidating(): boolean {
  return state.running;
}

export function notifyNewEntry(): void {
  if (state.running) {
    state.pendingRecheck = true;
    log.debug(`New entry arrived during consolidation — will re-check after completion`);
  }
}

export interface ConsolidationStatus {
  running: boolean;
  layer: string;
  current: number;
  total: number;
  detail: string;
  startedAt: number | null;
  tokenEstimate: number | null;
  startingTokens: number | null;
  currentTokens: number | null;
  thresholds: ConsolidationThresholds;
}

export async function getConsolidationStatus(): Promise<ConsolidationStatus> {
  const thresholds = await getThresholds();
  let tokenEstimate: number | null = null;
  if (!state.running) {
    try {
      tokenEstimate = await estimateShortTermTokens();
    } catch (err) {
      log.warn(`Failed to estimate short-term tokens for consolidation status`, err);
      tokenEstimate = null;
    }
  }
  return {
    running: state.running,
    layer: state.layer,
    current: state.current,
    total: state.total,
    detail: state.detail,
    startedAt: state.startedAt,
    tokenEstimate,
    startingTokens: state.startingTokens,
    currentTokens: state.currentTokens,
    thresholds,
  };
}

function getEffectiveTime(entry: MemoryEntry): number {
  const meta = (entry.metadata as Record<string, unknown>) || {};
  if (meta.recalledAt) {
    const t = new Date(meta.recalledAt as string).getTime();
    if (!isNaN(t)) return t;
  }
  return entry.createdAt ? new Date(entry.createdAt).getTime() : 0;
}

function sortEntriesByAge(entries: MemoryEntry[]): void {
  entries.sort((a, b) => {
    return getEffectiveTime(a) - getEffectiveTime(b);
  });
}

function computeTotalTokens(entries: MemoryEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += estimateTokens(entry.content);
  }
  return total;
}

function computePromotionCount(entries: MemoryEntry[], currentTokens: number, targetCapacity: number): number {
  let count = 0;
  let runningSum = currentTokens;
  for (const entry of entries) {
    if (runningSum <= targetCapacity) break;
    runningSum -= estimateTokens(entry.content);
    count++;
  }
  return count;
}

async function verifyEntryFreshness(
  entry: MemoryEntry,
  expectedLayer: string,
  index: number,
  total: number,
  logger: ReturnType<typeof createLogger>
): Promise<boolean> {
  const freshEntry = await memoryStorage.getEntry(entry.id);
  if (!freshEntry) {
    logger.warn(`[${index + 1}/${total}] Entry #${entry.id} no longer exists — skipping (deleted during processing)`);
    return false;
  }
  if (freshEntry.layer !== expectedLayer) {
    logger.warn(`[${index + 1}/${total}] Entry #${entry.id} layer changed to "${freshEntry.layer}" — skipping (already promoted)`);
    return false;
  }
  const originalHash = entry.contentHash ?? null;
  const currentHash = freshEntry.contentHash ?? null;
  if (originalHash !== currentHash) {
    logger.warn(`[${index + 1}/${total}] Entry #${entry.id} content changed since batch fetch — skipping (stale data)`);
    return false;
  }
  const originalProcessed = entry.processedAt ? new Date(entry.processedAt).getTime() : 0;
  const currentProcessed = freshEntry.processedAt ? new Date(freshEntry.processedAt).getTime() : 0;
  if (currentProcessed !== originalProcessed) {
    logger.warn(`[${index + 1}/${total}] Entry #${entry.id} processedAt changed since batch fetch — skipping (stale data)`);
    return false;
  }
  return true;
}

async function processConsolidationEntry(
  entry: MemoryEntry,
  index: number,
  total: number,
  enrichFn: (e: { content: string; source?: string | null; title?: string | null }) => Promise<EnrichmentWithClaims>,
): Promise<void> {
  const entryMeta = (entry.metadata as Record<string, unknown>) || {};
  const isRecalled = !!entryMeta.recalledAt;

  // Pre-resolve library page title so the enrichment function has a real fallback if it
  // would otherwise return "Untitled" (parse failure / empty model output).
  const titleHint = entry.title ?? (await resolveFallbackTitle(entry)) ?? undefined;

  log.verbose(() => `[${index + 1}/${total}] enrichment input — entry #${entry.id}${isRecalled ? " (recalled)" : ""}, content (${entry.content.length} chars): "${entry.content.slice(0, 150).replace(/\n/g, " ")}...", source="${entry.source}", title="${titleHint ?? ""}"`);

  const { title, oneLiner, summary, tags, claims, claimReasoning } = await enrichFn({
    content: entry.content,
    source: entry.source,
    title: titleHint || undefined,
  });

  log.debug(() => `[${index + 1}/${total}] enrichment output — title="${title}", oneLiner="${oneLiner.slice(0, 60)}", summary="${summary.slice(0, 120)}...", tags=[${tags.join(", ")}], claims=${claims.length}${claimReasoning ? `, reasoning="${claimReasoning.slice(0, 80)}"` : ""}`);

  const midEntry = await memoryStorage.promoteToMid(entry.id, title, summary, tags);
  log.log(`[MemoryTransition] AUTO #${entry.id} "${title}" short → mid (consolidation${isRecalled ? ", reconsolidated" : ""})`);
  log.verbose(() => `[${index + 1}/${total}] Promoted #${entry.id} in-place to mid, title="${midEntry.title}"`);

  if (oneLiner) {
    try {
      const { db: database } = await import("../db");
      const { memoryEntries: memEntriesTable } = await import("@shared/schema");
      const { eq: eqOp } = await import("drizzle-orm");
      await database.update(memEntriesTable).set({ oneLiner }).where(eqOp(memEntriesTable.id, midEntry.id));
    } catch (olErr: unknown) {
      log.warn(`[${index + 1}/${total}] Failed to persist oneLiner for #${midEntry.id}: ${olErr instanceof Error ? olErr.message : String(olErr)}`);
    }
  }

  try {
    await writeBackLibraryIndex(entry, oneLiner, summary, tags);
  } catch (wbErr: unknown) {
    log.warn(`[${index + 1}/${total}] writeBackLibraryIndex failed for #${entry.id}: ${wbErr instanceof Error ? wbErr.message : String(wbErr)}`);
  }

  try {
    await writeBackSessionSummary(entry, oneLiner, summary);
  } catch (wbErr: unknown) {
    log.warn(`[${index + 1}/${total}] writeBackSessionSummary failed for #${entry.id}: ${wbErr instanceof Error ? wbErr.message : String(wbErr)}`);
  }

  try {
    const textForEmbed = `${title}\n${summary}`;
    const embedding = await memoryStorage.ensureEmbedding(midEntry.id, textForEmbed);
    if (embedding) {
      midEntry.embedding = embedding;
      log.verbose(() => `[${index + 1}/${total}] Generated embedding for mid #${midEntry.id}`);
    }
  } catch (embErr: unknown) {
    const embErrMsg = embErr instanceof Error ? embErr.message : String(embErr);
    log.warn(`[${index + 1}/${total}] Embedding generation failed for #${midEntry.id}: ${embErrMsg}`);
  }

  // Process extracted claims BEFORE merge — merge may delete the parent entry,
  // which would cause extracted_from link creation to fail (target no longer exists)
  if (claims.length > 0) {
    try {
      const claimResults = await processExtractedClaims(
        claims,
        midEntry,
        index,
        total,
      );
      log.log(`[${index + 1}/${total}] Claims: ${claimResults.created} created, ${claimResults.reinforced} reinforced, ${claimResults.skipped} skipped for entry #${midEntry.id}`);
    } catch (claimErr: unknown) {
      log.warn(`[${index + 1}/${total}] Claim extraction failed for #${midEntry.id}: ${claimErr instanceof Error ? claimErr.message : String(claimErr)}`);
    }
  }

  const mergeResult = await tryMergeWithExistingMid(midEntry);
  if (mergeResult.merged) {
    log.verbose(() => `[MemoryTransition] AUTO #${midEntry.id} "${title}" merged into #${mergeResult.targetId} "${mergeResult.title}" (consolidation)`);
    log.verbose(() => `[${index + 1}/${total}] Merged into #${mergeResult.targetId} "${mergeResult.title}"`);
  }
}

// --- Claim extraction pipeline ---

const CLAIM_DEDUP_SIMILARITY_THRESHOLD = 0.9;

interface ClaimProcessingResult {
  created: number;
  reinforced: number;
  skipped: number;
}

function clampClaimExtractionBudget(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CLAIM_EXTRACTION_BUDGET_DEFAULT;
  return Math.max(CLAIM_EXTRACTION_BUDGET_MIN, Math.min(CLAIM_EXTRACTION_BUDGET_MAX, Math.floor(value)));
}

async function getClaimExtractionBudget(): Promise<number> {
  try {
    const stored = await getSetting<ClaimExtractionBudgetSettings>(CLAIM_EXTRACTION_BUDGET_SETTINGS_KEY);
    return clampClaimExtractionBudget(stored?.maxClaimsPerSession);
  } catch (err) {
    log.warn("Failed to read vNext claim extraction budget from database, using default", err);
    return CLAIM_EXTRACTION_BUDGET_DEFAULT;
  }
}

function getClaimExtractionBudgetKey(parentEntry: MemoryEntry): string {
  const meta = (parentEntry.metadata as Record<string, unknown>) || {};
  const sessionId = typeof meta.sessionId === "string" ? meta.sessionId : undefined;
  if (sessionId) return `session:${sessionId}`;
  if (parentEntry.sourceId) return `${parentEntry.source}:${parentEntry.sourceId}`;
  return `memory:${parentEntry.id}`;
}

function scoreClaimForBudget(claim: ClaimCandidate): { score: number; reasons: string[]; rejectedReason?: string } {
  const content = claim.content.trim();
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  const reasons: string[] = [];
  let score = 0;

  if (!content) return { score: 0, reasons: [], rejectedReason: "empty" };
  if (wordCount < 4) return { score: 0, reasons: [], rejectedReason: "too_short" };
  if (wordCount > 80) return { score: 0, reasons: [], rejectedReason: "too_long" };
  if (!/[.!?]$/.test(content) && wordCount < 8) return { score: 0, reasons: [], rejectedReason: "not_claim_shaped" };

  score += Math.max(0, Math.min(1, claim.confidence)) * 40;
  reasons.push("confidence");

  if (claim.claimType === "action") {
    score += 25;
    reasons.push("action_relevant");
  } else if (claim.claimType === "cause") {
    score += 20;
    reasons.push("causal");
  } else {
    score += 12;
    reasons.push("state");
  }

  if ((claim.entityMentions ?? []).length > 0) {
    score += Math.min(15, claim.entityMentions.length * 5);
    reasons.push("entity_linkable");
  }
  if ((claim.topics ?? []).length > 0) {
    score += Math.min(10, claim.topics.length * 2);
    reasons.push("topic_rich");
  }
  if (wordCount >= 8 && wordCount <= 35) {
    score += 10;
    reasons.push("concise");
  } else if (wordCount <= 55) {
    score += 4;
    reasons.push("bounded_length");
  }
  if (claim.sourceClaimIndex != null) {
    score += 5;
    reasons.push("linked_context");
  }

  return { score, reasons };
}

function rankClaimsForBudget(claims: ClaimCandidate[], remainingBudget: number): { accepted: ClaimBudgetDecision[]; rejected: ClaimBudgetDecision[] } {
  const evaluated = claims.map((claim, originalIndex) => ({
    claim,
    originalIndex,
    ...scoreClaimForBudget(claim),
  }));

  const invalid = evaluated.filter((candidate) => candidate.rejectedReason);
  const valid = evaluated
    .filter((candidate) => !candidate.rejectedReason)
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);

  const accepted = valid.slice(0, Math.max(0, remainingBudget));
  const overBudget = valid.slice(Math.max(0, remainingBudget)).map((candidate) => ({
    ...candidate,
    rejectedReason: "budget_exceeded",
  }));

  return {
    accepted,
    rejected: [...invalid, ...overBudget],
  };
}

function logClaimBudgetDecision(event: string, payload: Record<string, unknown>, level: "debug" | "info" = "debug"): void {
  log[level](JSON.stringify({ event, ...payload }));
}

export async function processVnextClaimsForMemoryEntry(
  memoryEntryId: number,
  trigger: string = "manual",
): Promise<ClaimProcessingResult> {
  const entry = await memoryStorage.getEntry(memoryEntryId);
  if (!entry) {
    log.warn(`[vnext_ingest] skip reason=memory_entry_not_found memoryEntryId=${memoryEntryId} trigger=${trigger}`);
    return { created: 0, reinforced: 0, skipped: 0 };
  }

  const meta = (entry.metadata as Record<string, unknown> | null) || {};
  log.info(
    `[vnext_ingest] start memoryEntryId=${entry.id} source=${entry.source || "unknown"} sourceId=${entry.sourceId || "none"} ` +
    `trigger=${trigger} layer=${entry.layer} integrationStage=${entry.integrationStage} contentLength=${entry.content.length} ` +
    `mirrorKind=${typeof meta.mirrorKind === "string" ? meta.mirrorKind : "none"}`,
  );

  try {
    const { generateTitleSummaryTagsAndClaims } = await import("./memory-enrichment");
    const titleHint = entry.title ?? (await resolveFallbackTitle(entry)) ?? undefined;
    const { claims, claimReasoning } = await generateTitleSummaryTagsAndClaims({
      content: entry.content,
      source: entry.source,
      title: titleHint || undefined,
    });

    log.info(
      `[vnext_ingest] candidates memoryEntryId=${entry.id} trigger=${trigger} candidates=${claims.length}` +
      `${claimReasoning ? ` reasoning="${claimReasoning.slice(0, 120).replace(/"/g, "'")}"` : ""}`,
    );

    if (claims.length === 0) {
      return { created: 0, reinforced: 0, skipped: 0 };
    }

    const result = await processExtractedClaims(claims, entry, 0, 1);
    log.info(
      `[vnext_ingest] complete memoryEntryId=${entry.id} trigger=${trigger} ` +
      `created=${result.created} reinforced=${result.reinforced} skipped=${result.skipped}`,
    );
    return result;
  } catch (err: unknown) {
    log.error(`[vnext_ingest] error memoryEntryId=${entry.id} trigger=${trigger} error=${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    throw err;
  }
}

/**
 * Process extracted claims from a consolidation entry.
 * For each claim: dedup via vector search, then create or reinforce.
 */
async function processExtractedClaims(
  claims: ClaimCandidate[],
  parentEntry: MemoryEntry,
  index: number,
  total: number,
): Promise<ClaimProcessingResult> {
  const { generateEmbedding } = await import("./embedding");

  let created = 0;
  let reinforced = 0;
  let skipped = 0;

  const maxClaims = await getClaimExtractionBudget();
  const budgetKey = getClaimExtractionBudgetKey(parentEntry);
  const existingAccepted = await memoryVnextClaimStorage.countClaimsForExtractionBudget({
    budgetKey,
    maxClaims,
    source: (parentEntry.source || "chat_journal") as MemorySource,
    sourceId: parentEntry.sourceId,
    sourceMemoryId: parentEntry.id,
  });
  const remainingBudget = Math.max(0, maxClaims - existingAccepted);
  const ranked = rankClaimsForBudget(claims, remainingBudget);

  skipped += ranked.rejected.length;
  logClaimBudgetDecision("memory.vnext.claim_budget", {
    sourceMemoryId: parentEntry.id,
    source: parentEntry.source || "chat_journal",
    sourceId: parentEntry.sourceId,
    budgetKey,
    maxClaims,
    existingAccepted,
    remainingBudget,
    candidatesSeen: claims.length,
    acceptedCandidates: ranked.accepted.length,
    rejectedCandidates: ranked.rejected.length,
    rejected: ranked.rejected.map((candidate) => ({
      index: candidate.originalIndex,
      reason: candidate.rejectedReason,
      score: Number(candidate.score.toFixed(2)),
      claimType: candidate.claim.claimType,
      preview: candidate.claim.content.slice(0, 80),
    })),
  }, "info");

  // Track created claim IDs by original batch index for intra-batch linking
  const createdClaimIds: Map<number, number> = new Map();

  for (const budgetCandidate of ranked.accepted) {
    const claimIdx = budgetCandidate.originalIndex;
    const claim = budgetCandidate.claim;
    try {
      // Generate embedding for dedup search
      const embedding = await generateEmbedding(claim.content);

      // Vector-search existing vNext claims for near-duplicates. Legacy semantic
      // search remains as a read compatibility signal only; new extracted claims
      // must not be written into memory_entries.
      const similarVnextClaims = await executeVnextClaimSemanticSearch(embedding, 3);
      const nearDuplicateVnextClaim = similarVnextClaims.find(
        (s) => s.similarity >= CLAIM_DEDUP_SIMILARITY_THRESHOLD,
      );

      if (nearDuplicateVnextClaim) {
        await memoryVnextClaimStorage.reinforceClaim(nearDuplicateVnextClaim.row.id);
        log.debug(`[${index + 1}/${total}] Claim dedup: reinforced existing vNext claim #${nearDuplicateVnextClaim.row.id} (similarity=${nearDuplicateVnextClaim.similarity.toFixed(3)}) for "${claim.content.slice(0, 60)}..."`);
        reinforced++;
        continue;
      }

      const similarLegacy = await executeSemanticSearch(embedding, 3);
      const nearDuplicateLegacy = similarLegacy.find(
        (s) => s.similarity >= CLAIM_DEDUP_SIMILARITY_THRESHOLD && (s.row.metadata as Record<string, unknown> | null)?.claimType,
      );

      if (nearDuplicateLegacy) {
        log.debug(`[${index + 1}/${total}] Claim dedup: skipped legacy duplicate #${nearDuplicateLegacy.row.id} (similarity=${nearDuplicateLegacy.similarity.toFixed(3)}) for "${claim.content.slice(0, 60)}..."`);
        reinforced++;
        continue;
      }

      // Determine createdAt from parent entry's source session date
      const parentMeta = (parentEntry.metadata as Record<string, unknown>) || {};
      const sourceDate = parentMeta.sessionDate
        ? new Date(parentMeta.sessionDate as string)
        : parentEntry.createdAt;

      const claimEntry = await memoryVnextClaimStorage.createClaim({
        claim,
        sourceMemoryId: parentEntry.id,
        source: (parentEntry.source || "chat_journal") as MemorySource,
        sourceId: parentEntry.sourceId,
        createdAt: sourceDate,
        embedding,
        metadata: {
          confidence: claim.confidence,
          claimType: claim.claimType,
        },
        writeBudget: {
          budget: {
            budgetKey,
            maxClaims,
            source: (parentEntry.source || "chat_journal") as MemorySource,
            sourceId: parentEntry.sourceId,
            sourceMemoryId: parentEntry.id,
          },
          acceptedRank: ranked.accepted.findIndex((candidate) => candidate.originalIndex === claimIdx) + 1,
          candidatesSeen: claims.length,
          candidateIndex: claimIdx,
          candidateScore: Number(budgetCandidate.score.toFixed(2)),
          candidateReasons: budgetCandidate.reasons,
          existingAcceptedAtStart: existingAccepted,
        },
        sourceRefs: [
          {
            sourceType: "memory",
            sourceId: String(parentEntry.id),
            relationship: "extracted_from",
            context: "Claim extracted from source memory mirror entry",
            strength: 1,
          },
        ],
      });

      // Entity linking
      const resolvedEntities = await resolveVnextEntityMentions(claim.entityMentions);
      for (const entity of resolvedEntities) {
        try {
          await memoryVnextClaimStorage.linkClaimToEntity(
            claimEntry.id,
            entity.entityType,
            entity.entityId,
          );
          log.debug(`Linked vNext claim #${claimEntry.id} to ${entity.entityType}:${entity.entityId}`);
        } catch (entityErr: unknown) {
          log.debug(`Entity link failed for vNext claim #${claimEntry.id} → ${entity.entityType}:${entity.entityId}: ${entityErr instanceof Error ? entityErr.message : String(entityErr)}`);
        }
      }

      createdClaimIds.set(claimIdx, claimEntry.id);
      created++;
      logClaimBudgetDecision("memory.vnext.claim_accepted", {
        sourceMemoryId: parentEntry.id,
        claimId: claimEntry.id,
        budgetKey,
        candidateIndex: claimIdx,
        score: Number(budgetCandidate.score.toFixed(2)),
        reasons: budgetCandidate.reasons,
        claimType: claim.claimType,
        confidence: claim.confidence,
        preview: claim.content.slice(0, 80),
      });
    } catch (claimErr: unknown) {
      skipped++;
      log.warn(`[${index + 1}/${total}] Failed to process claim "${claim.content.slice(0, 60)}...": ${claimErr instanceof Error ? claimErr.message : String(claimErr)}`);
    }
  }

  // Create intra-batch causal links between claims
  for (let claimIdx = 0; claimIdx < claims.length; claimIdx++) {
    const claim = claims[claimIdx];
    if (claim.sourceClaimIndex == null) continue;
    const fromId = createdClaimIds.get(claimIdx);
    const toId = createdClaimIds.get(claim.sourceClaimIndex);
    if (!fromId || !toId) continue;
    try {
      // Link: this claim was caused_by the referenced claim
      const relationship = claim.claimType === "action" ? "caused_by" :
                           claim.claimType === "state" ? "resulted_from" : "related_to";
      await memoryVnextClaimStorage.linkClaims(fromId, toId, relationship, 0.9);
      log.debug(`[${index + 1}/${total}] Linked vNext claim #${fromId} (${claim.claimType}) → #${toId} via ${relationship}`);
    } catch (linkErr: unknown) {
      log.debug(`Failed to create intra-batch link #${fromId} → #${toId}: ${linkErr instanceof Error ? linkErr.message : String(linkErr)}`);
    }
  }

  return { created, reinforced, skipped };
}

export async function writeBackLibraryIndex(
  entry: MemoryEntry,
  oneLiner: string,
  summary: string,
  tags: string[]
): Promise<void> {
  if (entry.source !== "library" || !entry.sourceId) return;

  const { db: database } = await import("../db");
  const { libraryPages } = await import("@shared/models/info");
  const { eq: eqOp } = await import("drizzle-orm");

  const [page] = await database.select().from(libraryPages).where(eqOp(libraryPages.id, entry.sourceId));
  if (!page) return;

  if (!page.plainTextContent || page.plainTextContent.length < 50) return;

  const existingTags = page.tags || [];
  const mergedTags = [...new Set([...existingTags, ...tags])];

  await database.update(libraryPages)
    .set({
      oneLiner: oneLiner || null,
      summary: summary || null,
      tags: mergedTags,
      updatedAt: new Date(),
    })
    .where(eqOp(libraryPages.id, entry.sourceId));

  log.debug(`writeBackLibraryIndex: Updated library page ${entry.sourceId} with oneLiner + summary + ${mergedTags.length} tags`);
}

/**
 * Write LLM-generated oneLiner back to the session record when consolidation
 * processes a session summary memory entry. Mirrors the writeBackLibraryIndex pattern.
 */
async function writeBackSessionSummary(
  entry: MemoryEntry,
  oneLiner: string,
  summary: string,
): Promise<void> {
  if (entry.source !== "chat_journal" || (!oneLiner && !summary)) return;

  const meta = (entry.metadata as Record<string, unknown>) || {};
  if (meta.mirrorKind !== "session_summary") return;

  // Extract session ID from sourceId pattern: session-summary-{sessionId}
  const sessionId = entry.sourceId?.replace(/^session-summary-/, "") || (meta.sessionId as string);
  if (!sessionId) return;

  const { chatFileStorage } = await import("../chat-file-storage");
  await chatFileStorage.updateSessionMemoryIndex(sessionId, oneLiner || null, summary || null);
  log.debug(`writeBackSessionSummary: Updated session ${sessionId} with oneLiner + summary`);
}

async function finalizeConsolidation(layer: "short", mutexToken: symbol): Promise<void> {
  const needsRecheck = state.pendingRecheck;
  resetState();
  releaseConsolidationMutex(mutexToken);

  if (needsRecheck) {
    log.debug(`Re-checking after consolidation (new entries arrived during run)`);
    const newTokens = await estimateShortTermTokens();
    const freshThresholds = await getThresholds();
    if (newTokens > freshThresholds.triggerCapacity) {
      log.debug(`Still over trigger capacity (${newTokens} > ${freshThresholds.triggerCapacity}) — chaining consolidation`);
      runConsolidation(layer);
    } else {
      log.debug(`Post-recheck: ${newTokens} tokens, under flush threshold — no chain needed`);
    }
  }

  if (layer === "short") {
    checkMidThreshold();
  }
}

const AGE_THRESHOLD_MS = 30 * 60 * 1000;

export async function runAgeBasedConsolidation(): Promise<{ promoted: number; failed: number }> {
  const mutexToken = tryAcquireConsolidationMutex();
  if (!mutexToken) {
    log.debug(`Consolidation already in progress (mutex held) — skipping age-based sweep`);
    return { promoted: 0, failed: 0 };
  }

  state.running = true;
  state.layer = "short";
  state.current = 0;
  state.total = 0;
  state.detail = "Fetching short-term entries...";
  state.startedAt = Date.now();
  state.pendingRecheck = false;

  const now = Date.now();
  const PAGE_SIZE = 500;
  const allEntries: MemoryEntry[] = [];
  let offset = 0;
  while (true) {
    const page = await memoryStorage.getLayer("short", PAGE_SIZE, offset);
    allEntries.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const staleEntries = allEntries.filter(e => {
    const effectiveTime = getEffectiveTime(e);
    return (now - effectiveTime) >= AGE_THRESHOLD_MS;
  });

  if (staleEntries.length === 0) {
    log.debug(`Age-based consolidation: no short-term entries older than 30 minutes`);
    resetState();
    releaseConsolidationMutex(mutexToken);
    return { promoted: 0, failed: 0 };
  }

  sortEntriesByAge(staleEntries);

  state.total = staleEntries.length;
  state.detail = "Age-based sweep...";

  const totalTokens = computeTotalTokens(allEntries);
  state.startingTokens = totalTokens;
  state.currentTokens = totalTokens;

  log.debug(`Age-based consolidation: ${staleEntries.length} entries older than 30 minutes`);

  let successCount = 0;
  let failureCount = 0;

  try {
    const { generateTitleSummaryTagsAndClaims } = await import("./memory-enrichment");

    for (let i = 0; i < staleEntries.length; i++) {
      const entry = staleEntries[i];
      state.current = i + 1;
      state.detail = entry.title || entry.content.slice(0, 40).replace(/\n/g, " ") + "...";

      try {
        const isFresh = await verifyEntryFreshness(entry, "short", i, staleEntries.length, log);
        if (!isFresh) continue;

        await processConsolidationEntry(entry, i, staleEntries.length, generateTitleSummaryTagsAndClaims);
        successCount++;

        state.currentTokens = (state.currentTokens ?? 0) - estimateTokens(entry.content);

        eventBus.publish({
          category: "memory",
          event: "entries_changed",
          payload: { action: "consolidated", layer: "short", current: state.current, total: state.total, level: "info" },
        });
      } catch (err: unknown) {
        if (isDuplicateLayerConstraintError(err)) {
          log.debug(`Age-based: duplicate resolved for entry #${entry.id} — already exists in mid-term`);
          const resolved = await resolveDuplicateEntry(entry, "mid", log);
          if (resolved) {
            successCount++;
            state.currentTokens = (state.currentTokens ?? 0) - estimateTokens(entry.content);
          } else {
            failureCount++;
          }
        } else {
          failureCount++;
          log.error(`Age-based: error promoting entry #${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err: unknown) {
    const errDetail = err instanceof Error ? (err.stack || err.message) : String(err);
    log.error(`Age-based consolidation failed: ${errDetail}`);
  } finally {
    const elapsed = Date.now() - (state.startedAt || Date.now());
    log.log(`Age-based consolidation complete: ${successCount} promoted, ${failureCount} failed (${elapsed}ms)`);
    resetState();
    releaseConsolidationMutex(mutexToken);
  }

  checkMidThreshold();

  return { promoted: successCount, failed: failureCount };
}

async function processStageOneSweepEntry(
  entry: MemoryEntry,
  runId: string,
  index: number,
  total: number,
): Promise<"advanced" | "skipped"> {
  const fresh = await memoryStorage.getEntry(entry.id);
  if (!fresh) {
    sweepLog.warn(`[${index + 1}/${total}] Entry #${entry.id} disappeared after claim — skipping`);
    return "skipped";
  }
  if (fresh.integrationStage !== MEMORY_INTEGRATION_STAGE.ENRICHED) {
    sweepLog.debug(`[${index + 1}/${total}] Entry #${entry.id} stage=${fresh.integrationStage} — skipping`);
    return "skipped";
  }
  if (fresh.processingRunId !== runId || fresh.processingStatus !== "processing") {
    sweepLog.warn(`[${index + 1}/${total}] Entry #${entry.id} claim changed — skipping`);
    return "skipped";
  }
  if (!fresh.title?.trim() || !fresh.summary?.trim() || !Array.isArray(fresh.tags) || fresh.tags.length === 0) {
    const reason = "missing Stage 1 title, summary, or tags";
    sweepLog.warn(`[${index + 1}/${total}] Entry #${entry.id} remains stage_1: ${reason}`);
    await memoryStorage.markStageOneSweepSkipped(fresh.id, runId, reason);
    return "skipped";
  }

  let sourceRefPreserved = false;
  if (fresh.sourceId) {
    await memoryStorage.preserveLegacySourceRef(
      fresh.id,
      fresh.source as any,
      fresh.sourceId,
      "Preserved during stage_1→stage_2 sweep",
    );
    sourceRefPreserved = true;
  }

  const initialEvidence = await memoryStorage.getStageTwoEvidenceCounts(fresh.id);
  let linksCreated = 0;

  if (initialEvidence.sourceRefs > 0 || initialEvidence.legacyLinks > 0) {
    sweepLog.log(`[${index + 1}/${total}] Entry #${fresh.id} already has stage_2 evidence ` +
      `(sourceRefs=${initialEvidence.sourceRefs}, legacyLinks=${initialEvidence.legacyLinks}) — reconciling`,
    );
  } else {
    try {
      const candidates = await memoryStorage.findSimilarEntries(fresh.id, STAGE_ONE_SWEEP_DEFAULTS.linkLimit, {
        layers: ["mid", "long", "workspace"],
      });
      for (const candidate of candidates) {
        if (candidate.hybridScore < 0.35) continue;
        try {
          await memoryStorage.createLink(
            fresh.id,
            candidate.entry.id,
            "stage_sweep_related",
            Math.max(0.35, Math.min(0.75, candidate.hybridScore)),
            "related",
          );
          linksCreated++;
        } catch (linkErr: unknown) {
          const message = linkErr instanceof Error ? linkErr.message : String(linkErr);
          sweepLog.warn(`Link creation failed #${fresh.id} → #${candidate.entry.id}: ${message}`);
        }
      }
    } catch (linkErr: unknown) {
      const message = linkErr instanceof Error ? linkErr.message : String(linkErr);
      sweepLog.warn(`Similarity linking failed for #${fresh.id}: ${message}`);
    }
  }

  const finalEvidence = linksCreated > 0
    ? await memoryStorage.getStageTwoEvidenceCounts(fresh.id)
    : initialEvidence;

  if (finalEvidence.sourceRefs === 0 && finalEvidence.legacyLinks === 0 && linksCreated === 0) {
    const reason = "no source refs, legacy links, or similar entries available for stage_2";
    sweepLog.warn(`[${index + 1}/${total}] Entry #${fresh.id} remains stage_1: ${reason}`);
    await memoryStorage.markStageOneSweepSkipped(fresh.id, runId, reason);
    return "skipped";
  }

  const advanced = await memoryStorage.advanceStageOneToStageTwo(fresh.id, runId, {
    linksCreated,
    sourceRefPreserved: sourceRefPreserved || finalEvidence.sourceRefs > 0,
  });
  if (!advanced) {
    sweepLog.warn(`[${index + 1}/${total}] Entry #${fresh.id} was not advanced — claim/stage changed`);
    return "skipped";
  }

  log.log(`[MemoryTransition] AUTO #${fresh.id} "${fresh.title || "Untitled"}" stage_1 → stage_2 (stage sweep, links=${linksCreated}, sourceRefs=${finalEvidence.sourceRefs}, legacyLinks=${finalEvidence.legacyLinks})`);
  eventBus.publish({
    category: "memory",
    event: "entries_changed",
    payload: { action: "stage-swept", layer: advanced.layer, stage: advanced.integrationStage, current: index + 1, total, level: "info" },
  });
  return "advanced";
}

export async function runStageOneAdvancementSweep(options: Partial<typeof STAGE_ONE_SWEEP_DEFAULTS> = {}): Promise<StageOneSweepResult> {
  const config = { ...STAGE_ONE_SWEEP_DEFAULTS, ...options };
  const started = Date.now();
  const runId = buildStageOneSweepRunId();

  if (stageOneSweepRunning) {
    sweepLog.debug(`already running in this worker — skipping`);
    return { status: "already_running", claimed: 0, advanced: 0, failed: 0, skipped: 0, elapsedMs: 0, runtimeCapped: false };
  }

  stageOneSweepRunning = true;
  const lockAcquired = await tryAcquireStageOneSweepDbLock();
  if (!lockAcquired) {
    stageOneSweepRunning = false;
    sweepLog.debug(`another worker holds the lock — skipping`);
    return { status: "already_running", claimed: 0, advanced: 0, failed: 0, skipped: 0, elapsedMs: 0, runtimeCapped: false };
  }

  let claimed: MemoryEntry[] = [];
  let advanced = 0;
  let failed = 0;
  let skipped = 0;
  let runtimeCapped = false;

  try {
    const now = Date.now();
    claimed = await memoryStorage.claimStageOneSweepBatch({
      runId,
      cutoff: new Date(now - config.minAgeMs),
      touchCutoff: new Date(now - config.touchDelayMs),
      staleCutoff: new Date(now - config.staleProcessingMs),
      limit: config.batchCap,
    });

    if (claimed.length === 0) {
      sweepLog.debug(`no eligible stage_1 entries`);
      return { status: "completed", claimed: 0, advanced: 0, failed: 0, skipped: 0, elapsedMs: Date.now() - started, runtimeCapped: false };
    }

    sweepLog.log(`Claimed ${claimed.length} stage_1 entries (run=${runId}, batchCap=${config.batchCap}, runtimeCap=${config.runtimeCapMs}ms)`);

    for (let i = 0; i < claimed.length; i++) {
      if (Date.now() - started >= config.runtimeCapMs) {
        runtimeCapped = true;
        skipped += claimed.length - i;
        sweepLog.warn(`Runtime cap reached after ${i}/${claimed.length}; remaining claims will be recovered by stale-processing TTL`);
        break;
      }

      const entry = claimed[i];
      try {
        const result = await processStageOneSweepEntry(entry, runId, i, claimed.length);
        if (result === "advanced") advanced++;
        else skipped++;
      } catch (err: unknown) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        sweepLog.error(`Error processing #${entry.id}: ${message}`);
        try {
          await memoryStorage.markStageOneSweepFailed(entry.id, runId, message);
        } catch (markErr: unknown) {
          sweepLog.warn(`Failed to mark #${entry.id} failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`);
        }
      }
    }

    const elapsedMs = Date.now() - started;
    sweepLog.log(`Complete: ${advanced} advanced, ${failed} failed, ${skipped} skipped of ${claimed.length} claimed (${elapsedMs}ms${runtimeCapped ? ", runtime capped" : ""})`);
    return { status: "completed", claimed: claimed.length, advanced, failed, skipped, elapsedMs, runtimeCapped };
  } catch (err: unknown) {
    const message = err instanceof Error ? (err.stack || err.message) : String(err);
    sweepLog.error(`Sweep failed: ${message}`);
    return { status: "completed", claimed: claimed.length, advanced, failed: failed + Math.max(0, claimed.length - advanced - skipped), skipped, elapsedMs: Date.now() - started, runtimeCapped };
  } finally {
    await releaseStageOneSweepDbLock().catch((err: unknown) => {
      sweepLog.warn(`Failed to release DB lock: ${err instanceof Error ? err.message : String(err)}`);
    });
    stageOneSweepRunning = false;
  }
}

export async function runConsolidation(layer: "short" = "short"): Promise<void> {
  const mutexToken = tryAcquireConsolidationMutex();
  if (!mutexToken) {
    state.pendingRecheck = true;
    log.debug(`Consolidation already in progress (mutex held) for layer=${state.layer} — flagged for re-check`);
    return;
  }

  state.running = true;
  state.layer = layer;
  state.current = 0;
  state.total = 0;
  state.detail = "Starting...";
  state.startedAt = Date.now();
  state.pendingRecheck = false;

  log.log(`Starting consolidation for layer=${layer}`);

  try {
    const thresholds = await getThresholds();
    const entries = await memoryStorage.getLayer("short", 500, 0);
    sortEntriesByAge(entries);

    let currentTokens = computeTotalTokens(entries);
    state.startingTokens = currentTokens;
    state.currentTokens = currentTokens;

    log.verbose(() => `Short-term tokens: ${currentTokens}, target capacity: ${thresholds.targetCapacity}`);

    if (currentTokens <= thresholds.targetCapacity) {
      log.verbose(() => `Under rinse threshold — nothing to do`);
      resetState();
      releaseConsolidationMutex(mutexToken);
      return;
    }

    const entriesToPromote = computePromotionCount(entries, currentTokens, thresholds.targetCapacity);
    state.total = entriesToPromote;
    log.verbose(() => `Need to promote ${entriesToPromote} entries to get below target capacity (${currentTokens} → target <${thresholds.targetCapacity})`);

    const { generateTitleSummaryTagsAndClaims } = await import("./memory-enrichment");

    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < entriesToPromote && i < entries.length; i++) {
      const entry = entries[i];
      state.current = i + 1;
      state.detail = entry.title || entry.content.slice(0, 40).replace(/\n/g, " ") + "...";

      log.debug(`[${i + 1}/${entriesToPromote}] Promoting #${entry.id} "${state.detail}"`);

      try {
        const isFresh = await verifyEntryFreshness(entry, "short", i, entriesToPromote, log);
        if (!isFresh) continue;

        const entryStart = Date.now();
        await processConsolidationEntry(entry, i, entriesToPromote, generateTitleSummaryTagsAndClaims);

        successCount++;
        currentTokens -= estimateTokens(entry.content);
        state.currentTokens = currentTokens;

        eventBus.publish({
          category: "memory",
          event: "entries_changed",
          payload: { action: "consolidated", layer: "short", current: state.current, total: state.total, level: "info" },
        });

        const entryElapsed = Date.now() - entryStart;
        log.debug(`[${i + 1}/${entriesToPromote}] Done in ${entryElapsed}ms — remaining tokens: ${currentTokens}`);

        if (currentTokens <= thresholds.targetCapacity) {
          log.debug(`Reached target capacity — stopping early at ${i + 1}/${entriesToPromote}`);
          state.current = i + 1;
          break;
        }
      } catch (err: unknown) {
        if (isDuplicateLayerConstraintError(err)) {
          log.debug(`Duplicate resolved for entry #${entry.id} — already exists in mid-term`);
          const resolved = await resolveDuplicateEntry(entry, "mid", log);
          if (resolved) {
            successCount++;
            currentTokens -= estimateTokens(entry.content);
            state.currentTokens = currentTokens;
          } else {
            failureCount++;
          }
        } else {
          failureCount++;
          const errMsg = err instanceof Error ? err.message : String(err);
          const isModelError = errMsg.includes("Codex") || errMsg.includes("rate limit") || errMsg.includes("OpenAI") || errMsg.includes("anthropic") || errMsg.includes("model") || errMsg.includes("stream");
          log.error(`Error promoting entry #${entry.id}: ${errMsg}`);
          if (isModelError) {
            log.warn(`Model error during consolidation entry #${entry.id} — tally: ${successCount} succeeded, ${failureCount} failed out of ${i + 1} attempted`);
          }
        }
      }
    }

    const attempted = successCount + failureCount;
    const elapsed = Date.now() - (state.startedAt || Date.now());
    log.log(`Consolidation complete: ${successCount} succeeded, ${failureCount} failed out of ${attempted} attempted (${entriesToPromote} planned), elapsed ${elapsed}ms, remaining tokens: ${currentTokens}`);

    await finalizeConsolidation(layer, mutexToken);
  } catch (err: unknown) {
    const errDetail = err instanceof Error ? (err.stack || err.message) : String(err);
    log.error(`Consolidation failed: ${errDetail}`);
    resetState();
    releaseConsolidationMutex(mutexToken);
  }
}

function resetState(): void {
  state.running = false;
  state.layer = "";
  state.current = 0;
  state.total = 0;
  state.detail = "";
  state.startedAt = null;
  state.pendingRecheck = false;
  state.startingTokens = null;
  state.currentTokens = null;
}

export interface IntegrationThresholds {
  triggerCapacity: number;
  targetCapacity: number;
}

export const INTEGRATION_DEFAULTS: IntegrationThresholds = {
  triggerCapacity: 20000,
  targetCapacity: 8000,
};

const integrationState: ConsolidationState = {
  running: false,
  layer: "mid",
  current: 0,
  total: 0,
  detail: "",
  startedAt: null,
  pendingRecheck: false,
  startingTokens: null,
  currentTokens: null,
};

export async function estimateMidTermTokens(): Promise<number> {
  const entries = await memoryStorage.getLayer("mid", 500, 0);
  let total = 0;
  for (const entry of entries) {
    total += estimateTokens(entry.content);
  }
  return total;
}

export async function getIntegrationThresholds(): Promise<IntegrationThresholds> {
  try {
    const stored = await getSetting<IntegrationThresholds>(INTEGRATION_SETTINGS_KEY);
    if (stored) {
      return {
        triggerCapacity: stored.triggerCapacity ?? INTEGRATION_DEFAULTS.triggerCapacity,
        targetCapacity: stored.targetCapacity ?? INTEGRATION_DEFAULTS.targetCapacity,
      };
    }
    return { ...INTEGRATION_DEFAULTS };
  } catch (err) {
    intLog.warn("Failed to read integration thresholds from database, using defaults", err);
    return { ...INTEGRATION_DEFAULTS };
  }
}

export async function setIntegrationThresholds(update: Partial<IntegrationThresholds>): Promise<IntegrationThresholds> {
  const current = await getIntegrationThresholds();
  const merged = {
    triggerCapacity: update.triggerCapacity ?? current.triggerCapacity,
    targetCapacity: update.targetCapacity ?? current.targetCapacity,
  };
  await setSetting(INTEGRATION_SETTINGS_KEY, merged);
  intLog.log(`Thresholds updated: triggerCapacity=${merged.triggerCapacity}, targetCapacity=${merged.targetCapacity}`);
  return merged;
}

export function isIntegrating(): boolean {
  return integrationState.running;
}

export function notifyNewMidEntry(): void {
  if (integrationState.running) {
    integrationState.pendingRecheck = true;
    intLog.log(`New mid entry arrived during integration — will re-check after completion`);
  }
}

export interface IntegrationStatus {
  running: boolean;
  layer: string;
  current: number;
  total: number;
  detail: string;
  startedAt: number | null;
  tokenEstimate: number | null;
  startingTokens: number | null;
  currentTokens: number | null;
  thresholds: IntegrationThresholds;
}

export async function getIntegrationStatus(): Promise<IntegrationStatus> {
  const thresholds = await getIntegrationThresholds();
  let tokenEstimate: number | null = null;
  if (!integrationState.running) {
    try {
      tokenEstimate = await estimateMidTermTokens();
    } catch (err) {
      intLog.warn(`Failed to estimate mid-term tokens for integration status`, err);
      tokenEstimate = null;
    }
  }
  return {
    running: integrationState.running,
    layer: integrationState.layer,
    current: integrationState.current,
    total: integrationState.total,
    detail: integrationState.detail,
    startedAt: integrationState.startedAt,
    tokenEstimate,
    startingTokens: integrationState.startingTokens,
    currentTokens: integrationState.currentTokens,
    thresholds,
  };
}

async function resolveFallbackTitle(entry: MemoryEntry): Promise<string> {
  if (entry.source === "library" && entry.sourceId) {
    try {
      const { db: database } = await import("../db");
      const { libraryPages } = await import("@shared/models/info");
      const { eq: eqOp } = await import("drizzle-orm");
      const [page] = await database.select().from(libraryPages).where(eqOp(libraryPages.id, entry.sourceId));
      if (page && page.title && page.title.trim()) return page.title.trim();
    } catch (err: unknown) {
      log.warn(`resolveFallbackTitle: library lookup failed for #${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return "";
}

export async function promoteEntryToLong(entry: MemoryEntry): Promise<any> {
  let title = (entry.title || "").trim();
  let summary = (entry.summary || "").trim();
  let oneLiner = (entry.oneLiner || "").trim();
  let tags = entry.tags || [];

  // Re-summarize if mid entry reached promotion without a real summary, so we never
  // silently store the full page body in the long-term `summary` column.
  if (!summary) {
    intLog.warn(`promoteEntryToLong: entry #${entry.id} (source=${entry.source}) is missing a real summary — re-summarizing before promotion`);
    try {
      const { generateTitleSummaryTags } = await import("./memory-enrichment");
      const titleHint = title || (await resolveFallbackTitle(entry)) || undefined;
      const generated = await generateTitleSummaryTags({
        content: entry.content,
        source: entry.source,
        title: titleHint,
      });
      summary = (generated.summary || "").trim();
      oneLiner = oneLiner || (generated.oneLiner || "").trim();
      if (!title) title = (generated.title || "").trim();
      if (generated.tags && generated.tags.length > 0) {
        tags = Array.from(new Set([...(entry.tags || []), ...generated.tags]));
      }
    } catch (regenErr: unknown) {
      intLog.error(`promoteEntryToLong: re-summarization failed for #${entry.id}: ${regenErr instanceof Error ? regenErr.message : String(regenErr)} — leaving summary blank rather than substituting content`);
      summary = "";
    }
  }

  if (!title) {
    title = (await resolveFallbackTitle(entry)) || "Untitled";
  }

  const longEntry = await memoryStorage.promoteToLong(
    entry.id,
    title,
    summary,
    tags
  );

  // promoteToLong updates title/summary/tags but not oneLiner; persist it separately
  // so re-enriched entries keep their oneLiner alongside the summary.
  if (oneLiner) {
    try {
      const { db: database } = await import("../db");
      const { memoryEntries: memEntriesTable } = await import("@shared/schema");
      const { eq: eqOp } = await import("drizzle-orm");
      await database.update(memEntriesTable).set({ oneLiner }).where(eqOp(memEntriesTable.id, longEntry.id));
    } catch (olErr: unknown) {
      intLog.warn(`promoteEntryToLong: failed to persist oneLiner on #${longEntry.id}: ${olErr instanceof Error ? olErr.message : String(olErr)}`);
    }
  }

  try {
    if (!longEntry.embedding) {
      await memoryStorage.ensureEmbedding(longEntry.id);
    }
    intLog.log(`Entry #${longEntry.id} promoted to long (graphed=false, awaiting explicit graphing)`);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? (err.stack || err.message) : String(err);
    intLog.error(`Embedding generation failed for #${longEntry.id}: ${errMsg}`);
  }

  return longEntry;
}

function resetIntegrationState(): void {
  integrationState.running = false;
  integrationState.layer = "mid";
  integrationState.current = 0;
  integrationState.total = 0;
  integrationState.detail = "";
  integrationState.startedAt = null;
  integrationState.pendingRecheck = false;
  integrationState.startingTokens = null;
  integrationState.currentTokens = null;
}

export async function checkMidThreshold(): Promise<void> {
  try {
    if (integrationState.running) {
      integrationState.pendingRecheck = true;
      intLog.log(`Integration already running — flagged for re-check after mid entry added`);
      return;
    }
    const tokens = await estimateMidTermTokens();
    const thresholds = await getIntegrationThresholds();
    if (tokens > thresholds.triggerCapacity) {
      intLog.log(`Mid-term trigger capacity exceeded: ${tokens} tokens > ${thresholds.triggerCapacity} — triggering integration`);
      runIntegration();
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    intLog.error(`Mid threshold check error: ${errMsg}`);
  }
}

async function processIntegrationEntry(
  entry: MemoryEntry,
  index: number,
  total: number
): Promise<void> {
  const entryMeta = (entry.metadata as Record<string, unknown>) || {};
  const isRecalled = !!entryMeta.recalledAt;

  intLog.log(`[MemoryTransition] AUTO #${entry.id} "${entry.title || 'Untitled'}" mid → long (integration${isRecalled ? ", reconsolidated" : ""})`);
  await promoteEntryToLong(entry);
}

async function finalizeIntegration(): Promise<void> {
  const needsRecheck = integrationState.pendingRecheck;
  resetIntegrationState();

  if (needsRecheck) {
    intLog.log(`Re-checking after integration (new entries arrived during run)`);
    const newTokens = await estimateMidTermTokens();
    const freshThresholds = await getIntegrationThresholds();
    if (newTokens > freshThresholds.triggerCapacity) {
      intLog.log(`Still over trigger capacity (${newTokens} > ${freshThresholds.triggerCapacity}) — chaining integration`);
      runIntegration();
    } else {
      intLog.log(`Post-recheck: ${newTokens} tokens, under flush threshold — no chain needed`);
    }
  }
}

export interface IntegrationResult {
  status: "completed" | "skipped" | "already_running";
  succeeded: number;
  failed: number;
  attempted: number;
  tokensBefore: number;
  tokensAfter: number;
  elapsedMs: number;
  reason?: string;
}

export async function runIntegration(options: { force?: boolean } = {}): Promise<IntegrationResult> {
  if (integrationState.running) {
    integrationState.pendingRecheck = true;
    intLog.log(`Integration already in progress — flagged for re-check`);
    return { status: "already_running", succeeded: 0, failed: 0, attempted: 0, tokensBefore: 0, tokensAfter: 0, elapsedMs: 0, reason: "Integration already in progress" };
  }

  integrationState.running = true;
  integrationState.layer = "mid";
  integrationState.current = 0;
  integrationState.total = 0;
  integrationState.detail = "Starting...";
  integrationState.startedAt = Date.now();
  integrationState.pendingRecheck = false;

  intLog.log(`Starting mid-to-long integration${options.force ? " (forced)" : ""}`);

  try {
    const thresholds = await getIntegrationThresholds();
    const entries = await memoryStorage.getLayer("mid", 500, 0);
    sortEntriesByAge(entries);

    let currentTokens = computeTotalTokens(entries);
    integrationState.startingTokens = currentTokens;
    integrationState.currentTokens = currentTokens;

    intLog.log(`Mid-term tokens: ${currentTokens}, target capacity: ${thresholds.targetCapacity}`);

    if (currentTokens <= thresholds.targetCapacity && !options.force) {
      intLog.log(`Under target capacity (${currentTokens}/${thresholds.targetCapacity}) — skipping. Use force=true to override.`);
      resetIntegrationState();
      return { status: "skipped", succeeded: 0, failed: 0, attempted: 0, tokensBefore: currentTokens, tokensAfter: currentTokens, elapsedMs: Date.now() - (integrationState.startedAt || Date.now()), reason: `Under target capacity (${currentTokens}/${thresholds.targetCapacity})` };
    }

    if (currentTokens <= 0) {
      intLog.log(`No mid-term entries to integrate`);
      resetIntegrationState();
      return { status: "skipped", succeeded: 0, failed: 0, attempted: 0, tokensBefore: 0, tokensAfter: 0, elapsedMs: Date.now() - (integrationState.startedAt || Date.now()), reason: "No mid-term entries" };
    }

    let entriesToPromote = computePromotionCount(entries, currentTokens, thresholds.targetCapacity);
    if (options.force && entriesToPromote === 0 && entries.length > 0) {
      entriesToPromote = entries.length;
      intLog.log(`Force mode: promoting all ${entriesToPromote} mid-term entries`);
    }
    integrationState.total = entriesToPromote;
    intLog.log(`Need to promote ${entriesToPromote} entries to get below target capacity (${currentTokens} → target <${thresholds.targetCapacity})`);

    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < entriesToPromote && i < entries.length; i++) {
      const entry = entries[i];
      integrationState.current = i + 1;
      integrationState.detail = entry.title || entry.content.slice(0, 40).replace(/\n/g, " ") + "...";

      intLog.debug(`[${i + 1}/${entriesToPromote}] Promoting mid #${entry.id} "${integrationState.detail}" to long-term`);

      try {
        const isFresh = await verifyEntryFreshness(entry, "mid", i, entriesToPromote, intLog);
        if (!isFresh) continue;

        const entryStart = Date.now();
        await processIntegrationEntry(entry, i, entriesToPromote);

        successCount++;
        currentTokens -= estimateTokens(entry.content);
        integrationState.currentTokens = currentTokens;

        eventBus.publish({
          category: "memory",
          event: "entries_changed",
          payload: { action: "integrated", layer: "mid", current: integrationState.current, total: integrationState.total, level: "info" },
        });

        const entryElapsed = Date.now() - entryStart;
        intLog.debug(`[${i + 1}/${entriesToPromote}] Done in ${entryElapsed}ms — remaining mid tokens: ${currentTokens}`);

        if (currentTokens <= thresholds.targetCapacity) {
          intLog.log(`Reached target capacity — stopping early at ${i + 1}/${entriesToPromote}`);
          integrationState.current = i + 1;
          break;
        }
      } catch (err: unknown) {
        if (isDuplicateLayerConstraintError(err)) {
          intLog.log(`Duplicate resolved for entry #${entry.id} — already exists in long-term`);
          const resolved = await resolveDuplicateEntry(entry, "long", intLog);
          if (resolved) {
            successCount++;
            currentTokens -= estimateTokens(entry.content);
            integrationState.currentTokens = currentTokens;
          } else {
            failureCount++;
          }
        } else {
          failureCount++;
          const errMsg = err instanceof Error ? err.message : String(err);
          const isModelError = errMsg.includes("Codex") || errMsg.includes("rate limit") || errMsg.includes("OpenAI") || errMsg.includes("anthropic") || errMsg.includes("model") || errMsg.includes("stream");
          intLog.error(`Error promoting entry #${entry.id}: ${errMsg}`);
          if (isModelError) {
            intLog.warn(`Model error during integration entry #${entry.id} — tally: ${successCount} succeeded, ${failureCount} failed out of ${i + 1} attempted`);
          }
        }
      }
    }

    const attempted = successCount + failureCount;
    const elapsed = Date.now() - (integrationState.startedAt || Date.now());
    intLog.log(`Integration complete: ${successCount} succeeded, ${failureCount} failed out of ${attempted} attempted (${entriesToPromote} planned), elapsed ${elapsed}ms, remaining mid tokens: ${currentTokens}`);

    await finalizeIntegration();
    const tokensAfter = currentTokens;
    return { status: "completed", succeeded: successCount, failed: failureCount, attempted, tokensBefore: integrationState.startingTokens || 0, tokensAfter, elapsedMs: elapsed };
  } catch (err: unknown) {
    const errDetail = err instanceof Error ? (err.stack || err.message) : String(err);
    intLog.error(`Integration failed: ${errDetail}`);
    const elapsed = Date.now() - (integrationState.startedAt || Date.now());
    resetIntegrationState();
    return { status: "completed", succeeded: 0, failed: 1, attempted: 1, tokensBefore: 0, tokensAfter: 0, elapsedMs: elapsed, reason: errDetail };
  }
}

export async function cleanupDuplicateLayerEntries(): Promise<{ cleaned: number; details: string[] }> {
  const { db } = await import("../db");
  const { sql } = await import("drizzle-orm");
  const cleanupLog = createLogger("MemoryCleanup");
  const details: string[] = [];

  const layerPairs: Array<{ lowerLayer: string; upperLayer: MemoryLayer }> = [
    { lowerLayer: "mid", upperLayer: "long" },
    { lowerLayer: "short", upperLayer: "mid" },
  ];

  for (const { lowerLayer, upperLayer } of layerPairs) {
    const dupRows = await db.execute(sql`
      SELECT lo.id AS deleted_id, lo.source, lo.source_id, hi.id AS kept_id
      FROM memory_entries lo
      JOIN memory_entries hi ON lo.source = hi.source AND lo.source_id = hi.source_id
      WHERE lo.layer = ${lowerLayer} AND hi.layer = ${upperLayer}
        AND lo.source_id IS NOT NULL AND lo.id != hi.id
      LIMIT 1000
    `);
    const dups = Array.isArray(dupRows) ? dupRows : (dupRows.rows || []);

    for (const row of dups) {
      const r = row as Record<string, unknown>;
      const deletedId = Number(r.deleted_id);
      const keptId = Number(r.kept_id);
      const transferred = await memoryStorage.transferLinks(deletedId, keptId);
      if (transferred > 0) {
        cleanupLog.log(`Transferred ${transferred} links from ${lowerLayer} #${deletedId} to ${upperLayer} #${keptId}`);
      }
      await memoryStorage.deleteEntry(deletedId);
      details.push(`Deleted ${lowerLayer} #${deletedId} (source=${r.source}, sourceId=${r.source_id}), kept ${upperLayer} #${keptId}, links transferred: ${transferred}`);
    }
  }

  const totalCleaned = details.length;
  if (totalCleaned > 0) {
    cleanupLog.log(`Cleaned ${totalCleaned} duplicate layer entries`);
    for (const d of details) {
      cleanupLog.log(d);
    }
  } else {
    cleanupLog.log(`No duplicate layer entries found — all clean`);
  }

  return { cleaned: totalCleaned, details };
}

const graphLog = createLogger("GraphMyelination");

interface GraphMyelinationState {
  running: boolean;
  total: number;
  remaining: number;
  current: number;
  detail: string;
  startedAt: number | null;
}

const graphMyelinationState: GraphMyelinationState = {
  running: false,
  total: 0,
  remaining: 0,
  current: 0,
  detail: "",
  startedAt: null,
};

function resetGraphMyelinationState(): void {
  graphMyelinationState.running = false;
  graphMyelinationState.total = 0;
  graphMyelinationState.remaining = 0;
  graphMyelinationState.current = 0;
  graphMyelinationState.detail = "";
  graphMyelinationState.startedAt = null;
}

export interface GraphMyelinationStatus {
  running: boolean;
  total: number;
  remaining: number;
  current: number;
  detail: string;
  startedAt: number | null;
  ungraphedCount: number;
}

export async function getGraphMyelinationStatus(): Promise<GraphMyelinationStatus> {
  let ungraphedCount = 0;
  if (!graphMyelinationState.running) {
    try {
      const longEntries = await memoryStorage.getLayer("long", 500, 0);
      ungraphedCount = longEntries.filter(e => !e.graphed).length;
    } catch (err) { log.warn("ungraphed count failed", err); }
  }
  return {
    running: graphMyelinationState.running,
    total: graphMyelinationState.total,
    remaining: graphMyelinationState.remaining,
    current: graphMyelinationState.current,
    detail: graphMyelinationState.detail,
    startedAt: graphMyelinationState.startedAt,
    ungraphedCount,
  };
}

export async function runGraphEnrichment(): Promise<void> {
  if (graphMyelinationState.running) {
    graphLog.log(`Already running — skipping`);
    return;
  }

  graphMyelinationState.running = true;
  graphMyelinationState.startedAt = Date.now();
  graphMyelinationState.detail = "Starting...";

  graphLog.log(`Starting long-to-graph enrichment`);

  try {
    const longEntries = await memoryStorage.getLayer("long", 500, 0);
    const ungraphed = longEntries.filter(e => !e.graphed);

    ungraphed.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return aTime - bTime;
    });

    graphMyelinationState.total = ungraphed.length;
    graphMyelinationState.remaining = ungraphed.length;
    graphMyelinationState.current = 0;

    if (ungraphed.length === 0) {
      graphLog.log(`No ungraphed long entries — nothing to do`);
      resetGraphMyelinationState();
      return;
    }

    graphLog.log(`Found ${ungraphed.length} ungraphed long entries to process`);

    for (let i = 0; i < ungraphed.length; i++) {
      await new Promise(resolve => setImmediate(resolve));
      const entry = ungraphed[i];
      graphMyelinationState.current = i + 1;
      graphMyelinationState.remaining = ungraphed.length - i - 1;
      graphMyelinationState.detail = entry.title || entry.content.slice(0, 40).replace(/\n/g, " ") + "...";

      graphLog.debug(`[${i + 1}/${ungraphed.length}] Graphing #${entry.id} "${graphMyelinationState.detail}"`);

      try {
        const entryStart = Date.now();

        await memoryStorage.deleteLinksForEntry(entry.id);
        await memoryStorage.setGraphed(entry.id, true);

        try {
          const { generateEmbedding, isEmbeddingsAvailable } = await import("./embedding");
          if (isEmbeddingsAvailable() && !entry.processedAt) {
            const textForEmbed = entry.summary || entry.content;
            const embedding = await generateEmbedding(textForEmbed);
            await memoryStorage.updateEmbedding(entry.id, embedding);
          }

          const candidates = await memoryStorage.findSimilarEntries(entry.id, 8);
          if (candidates.length > 0) {
            const { evaluateLinks } = await import("./graph-discovery");
            const { links } = await evaluateLinks(entry, candidates);
            for (const link of links) {
              await memoryStorage.createLink(link.from, link.to, link.relationship, link.strength, link.relationshipType);
            }
            graphLog.debug(`Created ${links.length} links for #${entry.id}`);
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          graphLog.warn(`Graph discovery failed for #${entry.id}: ${errMsg}`);
        }

        eventBus.publish({
          category: "memory",
          event: "entries_changed",
          payload: { action: "graph-myelinated", layer: "long", current: i + 1, total: ungraphed.length, level: "info" },
        });

        const elapsed = Date.now() - entryStart;
        graphLog.debug(`[${i + 1}/${ungraphed.length}] Done in ${elapsed}ms — ${ungraphed.length - i - 1} remaining`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        graphLog.error(`Error processing entry #${entry.id}: ${errMsg}`);
      }
    }

    const totalElapsed = Date.now() - (graphMyelinationState.startedAt || Date.now());
    graphLog.log(`Complete: processed ${ungraphed.length} entries in ${totalElapsed}ms`);
    resetGraphMyelinationState();
  } catch (err: unknown) {
    const errDetail = err instanceof Error ? (err.stack || err.message) : String(err);
    graphLog.error(`Graph enrichment failed: ${errDetail}`);
    resetGraphMyelinationState();
  }
}
