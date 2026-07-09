/**
 * vNext Claim Extraction Module
 *
 * Owns all claim extraction, scoring, budgeting, and persistence logic
 * for the vNext memory pipeline. No imports from legacy consolidation.ts
 * or memory-enrichment.ts.
 *
 * Extraction prompt, claim parsing, dedup, budget scoring, and the
 * processVnextClaimsForSource entry point all live here.
 */

import { executeVnextClaimSemanticSearch, memoryVnextClaimStorage } from "./vnext-claim-storage";
import { executeSemanticSearch } from "./memory-storage";
import { resolveVnextEntityMentions } from "./vnext-entity-resolution";
import { chatCompletion } from "../model-client";
import { ACTIVITY_MEMORY } from "../job-profiles";
import { extractJson } from "../utils/extract-json";
import { getSetting } from "../system-settings";
import { createLogger } from "../log";
import type { MemoryEntry, MemorySource } from "@shared/schema";

const log = createLogger("VnextClaimExtraction");

// ---------------------------------------------------------------------------
// Claim types
// ---------------------------------------------------------------------------

export interface ClaimCandidate {
  /** 1-3 word display title for UI visibility (Layers page, graph) */
  title: string;
  content: string;
  claimType: "state" | "cause" | "action";
  confidence: number;
  topics: string[];
  entityMentions: Array<{ name: string; entityType: string }>;
  /** Index of another claim in this batch that this claim is causally linked to */
  sourceClaimIndex?: number;
}

// ---------------------------------------------------------------------------
// Title normalization
// ---------------------------------------------------------------------------

const CLAIM_TITLE_STOPWORDS = new Set(["the", "a", "an", "is", "are", "was", "were", "has", "have", "and", "or", "of", "to", "for", "in", "on", "that", "with", "as", "his", "her", "its", "their"]);

/** Normalize an LLM-provided claim title to 1-3 words; derive from content when missing. */
export function normalizeClaimTitle(rawTitle: string, content: string): string {
  const cleaned = rawTitle.trim().replace(/[.,;:!?"]+$/, "");
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 3) return words.join(" ");
  if (words.length > 3) return words.slice(0, 3).join(" ");
  const significant = content
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ""))
    .filter((w) => w.length > 1 && !CLAIM_TITLE_STOPWORDS.has(w.toLowerCase()));
  return significant.slice(0, 3).join(" ") || "Claim";
}

// ---------------------------------------------------------------------------
// Claim response parsing
// ---------------------------------------------------------------------------

function parseClaimsFromResponse(parsed: Record<string, unknown>): ClaimCandidate[] {
  if (!Array.isArray(parsed.claims)) return [];

  const validTypes = new Set(["state", "cause", "action"]);
  const legacyTypeMap: Record<string, ClaimCandidate["claimType"]> = { event: "action" };
  const validEntityTypes = new Set(["person", "project", "goal"]);

  return (parsed.claims as unknown[])
    .filter((c): c is Record<string, unknown> => c != null && typeof c === "object")
    .map((c) => {
      const content = typeof c.content === "string" ? c.content.trim() : "";
      const title = normalizeClaimTitle(typeof c.title === "string" ? c.title : "", content);
      const rawType = typeof c.claimType === "string" ? c.claimType : "";
      const claimType = validTypes.has(rawType)
        ? (rawType as ClaimCandidate["claimType"])
        : (legacyTypeMap[rawType] ?? null);
      const confidence = typeof c.confidence === "number" ? c.confidence : 0;
      const topics = Array.isArray(c.topics)
        ? (c.topics as unknown[]).filter((t): t is string => typeof t === "string").map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 4)
        : [];
      const entityMentions = Array.isArray(c.entityMentions)
        ? (c.entityMentions as unknown[])
            .filter((e): e is Record<string, unknown> => e != null && typeof e === "object")
            .filter((e) => typeof e.name === "string" && typeof e.entityType === "string" && validEntityTypes.has(e.entityType as string))
            .map((e) => ({ name: (e.name as string).trim(), entityType: (e.entityType as string).trim() }))
        : [];
      const sourceClaimIndex = typeof c.sourceClaimIndex === "number" ? c.sourceClaimIndex : undefined;
      return { title, content, claimType, confidence, topics, entityMentions, sourceClaimIndex } as ClaimCandidate & { claimType: ClaimCandidate["claimType"] | null };
    })
    .filter((c): c is ClaimCandidate => !!c.content && c.claimType !== null && c.confidence >= 0.4)
    .slice(0, 7);
}

// ---------------------------------------------------------------------------
// Extraction prompt (v6 — proven 18/18 test cases, do not modify here)
// ---------------------------------------------------------------------------

const VNEXT_CLAIM_EXTRACTION_PROMPT = `You extract durable vNext memory claims. You are not summarizing.

Default to returning no claims. Most sources should produce {"claims": []}.

Goal: extract only memories that improve Agent's future model of the external world: people, relationships, organizations, incentives, constraints, preferences, decisions, commitments, markets, family, money, health, time, logistics, or non-obvious causal dynamics outside the codebase.

Internal system facts are usually not memory. Do not store ordinary facts about code changes, UI behavior, PRs, migrations, deploys, logs, builds, database row counts, task movement, workflow stages, or Agent's own activity. Agent can recover these from code, git, logs, tools, and structured records.

Internal facts qualify only when they reveal a durable behavioral rule about Ray or how Agent should work with Ray.

Extract 0-3 claims. Never extract more than 3.

A claim must be a standalone sentence that would change future prediction, judgment, relationship handling, prioritization, or decision-making. If the source merely says what happened, return no claims.

Claim types:
- "state": durable external reality about people, relationships, organizations, finances, constraints, preferences, or beliefs. Includes: who works where, who manages what for whom, financial service relationships, account structures, organizational affiliations, team structures, identity facts, and relationship dynamics between named people. These claims serve as anchor nodes for the memory graph — even if the fact exists in another tool, having it as a claim enables fast cross-domain linking in later lifecycle stages.
- "cause": why an external behavior, decision, pressure, preference, or constraint exists.
- "action": a commitment, plan, or intended action — including event-specific ones when they reveal strategy, positioning, or relationship-building intent. Reject actions that are purely logistical with no strategic signal.

Extraction principle: look through the process wrapper to the underlying facts. "Enriched 1 email thread about X" is not a claim, but the X itself may contain one. "Agent updated person record with Y" is not a claim, but Y may be. "Consolidation promoted N entries" contains no underlying fact.

Indexing test: a good claim is one that, if pre-indexed and linked in the memory graph, would accelerate future reasoning about people, relationships, or strategy without requiring deep searches across calendar, tasks, people records, or opportunity pipelines. Think of claims as the fast-lookup index, not a replacement for source-of-truth tools.

Reject:
- implementation summaries, UI changelog facts, git/deploy/log/build facts, migration details, runtime errors, row counts, task/project status snapshots
- short-lived calendar/scheduling facts (specific meeting times, dates that expire within days)
- generic advice, procedural how-to, and weak restatements of the source
- claims below 0.4 confidence
- process status messages with no underlying external fact

For each claim, include a "title": a 1-3 word Title Case label naming the subject of the claim (e.g. "Toku Outreach", "Brand Colors", "Eric Kamont"). Never more than 3 words. It is used as the claim's display name in list and graph UIs.

For each claim, include 1-4 topics and entityMentions for named people, projects, or goals when present. entityType must be "person", "project", or "goal". If one claim is caused by another claim in this batch, set sourceClaimIndex to that claim's 0-based index; otherwise use null.

Respond with only valid JSON:
{"claims":[{"title":"1-3 Word Title","content":"...","claimType":"state|cause|action","confidence":0.0,"topics":["..."],"entityMentions":[{"name":"...","entityType":"person|project|goal"}],"sourceClaimIndex":null}],"reasoning":"short reason, or why no claims were worth storing"}`;

// ---------------------------------------------------------------------------
// Chunk-level claim extraction
// ---------------------------------------------------------------------------

export async function extractClaimsFromChunk(
  chunk: string,
  index: number,
  total: number,
  source?: string | null,
  title?: string | null,
): Promise<ClaimCandidate[]> {
  try {
    const messages = [
      { role: "system" as const, content: VNEXT_CLAIM_EXTRACTION_PROMPT },
      {
        role: "user" as const,
        content: `Section ${index + 1} of ${total}\nSource: ${source || "unknown"}\nTitle: ${title || "untitled"}\n\n${chunk}`,
      },
    ];

    const result = await chatCompletion({
      activity: ACTIVITY_MEMORY,
      metadata: { source: "memory-vnext-claim-extraction", activity: ACTIVITY_MEMORY },
      maxTokens: 1200,
      messages,
      temperature: 0.2,
      jsonMode: true,
    });

    const parsed = JSON.parse(extractJson(result.content));
    return parseClaimsFromResponse(parsed).slice(0, 3);
  } catch (err) {
    log.warn(`extractClaimsFromChunk: Chunk ${index + 1}/${total} vNext claim extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cross-chunk claim deduplication
// ---------------------------------------------------------------------------

export function deduplicateChunkClaims(allClaims: ClaimCandidate[]): ClaimCandidate[] {
  const seen: ClaimCandidate[] = [];
  for (const claim of allClaims) {
    const isDupe = seen.some(
      (s) => s.content === claim.content || s.content.includes(claim.content) || claim.content.includes(s.content),
    );
    if (!isDupe) seen.push(claim);
  }
  return seen.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Budget scoring & ranking
// ---------------------------------------------------------------------------

const CLAIM_EXTRACTION_BUDGET_SETTINGS_KEY = "memory.vnext.extractionBudget";
const CLAIM_EXTRACTION_BUDGET_DEFAULT = 3;
const CLAIM_EXTRACTION_BUDGET_MIN = 1;
const CLAIM_EXTRACTION_BUDGET_MAX = 3;

interface ClaimExtractionBudgetSettings {
  maxClaimsPerSession: number;
}

interface ClaimBudgetDecision {
  claim: ClaimCandidate;
  originalIndex: number;
  score: number;
  reasons: string[];
  rejectedReason?: string;
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

export function scoreClaimForBudget(claim: ClaimCandidate): { score: number; reasons: string[]; rejectedReason?: string } {
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

// ---------------------------------------------------------------------------
// Semantic dedup threshold
// ---------------------------------------------------------------------------

const CLAIM_DEDUP_SIMILARITY_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Source extraction interface
// ---------------------------------------------------------------------------

export interface VnextExtractionSource {
  sourceMemoryEntry: MemoryEntry;
  content: string;
  title?: string | null;
  sourceLabel?: string;
  sourceRefs?: Array<{
    sourceType: string;
    sourceId: string;
    relationship?: string;
    context?: string;
    strength?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Claim processing result
// ---------------------------------------------------------------------------

interface ClaimProcessingResult {
  created: number;
  reinforced: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Extract claims for a source (standalone, replaces fused enrichment call)
// ---------------------------------------------------------------------------

async function extractClaimsForSource(
  content: string,
  source?: string | null,
  title?: string | null,
): Promise<{ claims: ClaimCandidate[]; claimReasoning?: string }> {
  try {
    const messages = [
      { role: "system" as const, content: VNEXT_CLAIM_EXTRACTION_PROMPT },
      {
        role: "user" as const,
        content: `Source: ${source || "unknown"}\nTitle: ${title || "untitled"}\n\n${content}`,
      },
    ];

    const result = await chatCompletion({
      activity: ACTIVITY_MEMORY,
      metadata: { source: "memory-vnext-claim-extraction", activity: ACTIVITY_MEMORY },
      maxTokens: 1200,
      messages,
      temperature: 0.2,
      jsonMode: true,
    });

    const parsed = JSON.parse(extractJson(result.content));
    const claims = parseClaimsFromResponse(parsed).slice(0, 3);
    const claimReasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : undefined;
    return { claims, claimReasoning };
  } catch (err) {
    log.warn(`extractClaimsForSource: claim extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    return { claims: [] };
  }
}

// ---------------------------------------------------------------------------
// Main entry point: process claims for a source
// ---------------------------------------------------------------------------

export async function processVnextClaimsForSource(
  source: VnextExtractionSource,
  trigger: string = "manual",
): Promise<ClaimProcessingResult> {
  const entry = source.sourceMemoryEntry;
  const content = source.content.trim();
  if (!content) {
    log.warn(`[vnext_ingest] skip reason=empty_source_content memoryEntryId=${entry.id} trigger=${trigger} sourceLabel=${source.sourceLabel || "unknown"}`);
    return { created: 0, reinforced: 0, skipped: 0 };
  }

  const meta = (entry.metadata as Record<string, unknown> | null) || {};
  log.info(
    `[vnext_ingest] start memoryEntryId=${entry.id} source=${entry.source || "unknown"} sourceId=${entry.sourceId || "none"} ` +
    `trigger=${trigger} sourceLabel=${source.sourceLabel || "unknown"} layer=${entry.layer} integrationStage=${entry.integrationStage} ` +
    `contentLength=${content.length} mirrorContentLength=${entry.content.length} ` +
    `mirrorKind=${typeof meta.mirrorKind === "string" ? meta.mirrorKind : "none"}`,
  );

  try {
    const { claims, claimReasoning } = await extractClaimsForSource(content, entry.source, source.title || undefined);

    log.info(
      `[vnext_ingest] candidates memoryEntryId=${entry.id} trigger=${trigger} sourceLabel=${source.sourceLabel || "unknown"} candidates=${claims.length}` +
      `${claimReasoning ? ` reasoning="${claimReasoning.slice(0, 120).replace(/"/g, "'")}"` : ""}`,
    );

    if (claims.length === 0) {
      return { created: 0, reinforced: 0, skipped: 0 };
    }

    const result = await processExtractedClaims(claims, entry, 0, 1, {
      sourceRefs: source.sourceRefs,
      sourceLabel: source.sourceLabel,
    });
    log.info(
      `[vnext_ingest] complete memoryEntryId=${entry.id} trigger=${trigger} sourceLabel=${source.sourceLabel || "unknown"} ` +
      `created=${result.created} reinforced=${result.reinforced} skipped=${result.skipped}`,
    );
    return result;
  } catch (err: unknown) {
    log.error(`[vnext_ingest] error memoryEntryId=${entry.id} trigger=${trigger} sourceLabel=${source.sourceLabel || "unknown"} error=${err instanceof Error ? (err.stack || err.message) : String(err)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Process extracted claims (dedup, budget, persist, entity link)
// ---------------------------------------------------------------------------

async function processExtractedClaims(
  claims: ClaimCandidate[],
  parentEntry: MemoryEntry,
  index: number,
  total: number,
  options?: {
    sourceRefs?: VnextExtractionSource["sourceRefs"];
    sourceLabel?: string;
  },
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

      // Vector-search existing vNext claims for near-duplicates. Semantic dedupe is
      // optional enrichment: if vector search fails, the source-backed vNext claim
      // must still be durably written through the idempotent vNext storage boundary.
      let nearDuplicateVnextClaim: Awaited<ReturnType<typeof executeVnextClaimSemanticSearch>>[number] | undefined;
      try {
        const similarVnextClaims = await executeVnextClaimSemanticSearch(embedding, 3);
        nearDuplicateVnextClaim = similarVnextClaims.find(
          (s) => s.similarity >= CLAIM_DEDUP_SIMILARITY_THRESHOLD,
        );
      } catch (semanticErr: unknown) {
        log.warn(
          `[${index + 1}/${total}] vNext semantic dedupe failed open for claim "${claim.content.slice(0, 80)}...": ` +
          `${semanticErr instanceof Error ? semanticErr.message : String(semanticErr)}`,
        );
      }

      if (nearDuplicateVnextClaim) {
        await memoryVnextClaimStorage.reinforceClaim(nearDuplicateVnextClaim.row.id);
        log.debug(`[${index + 1}/${total}] Claim dedup: reinforced existing vNext claim #${nearDuplicateVnextClaim.row.id} (similarity=${nearDuplicateVnextClaim.similarity.toFixed(3)}) for "${claim.content.slice(0, 60)}..."`);
        reinforced++;
        continue;
      }

      let legacyDuplicateSignal: { id: number; similarity: number } | null = null;
      try {
        const similarLegacy = await executeSemanticSearch(embedding, 3);
        const nearDuplicateLegacy = similarLegacy.find(
          (s) => s.similarity >= CLAIM_DEDUP_SIMILARITY_THRESHOLD && (s.row.metadata as Record<string, unknown> | null)?.claimType,
        );

        if (nearDuplicateLegacy) {
          legacyDuplicateSignal = { id: nearDuplicateLegacy.row.id, similarity: nearDuplicateLegacy.similarity };
          log.debug(`[${index + 1}/${total}] Legacy duplicate signal for vNext claim: legacy #${nearDuplicateLegacy.row.id} (similarity=${nearDuplicateLegacy.similarity.toFixed(3)}) for "${claim.content.slice(0, 60)}..." — inserting vNext claim anyway`);
        }
      } catch (legacySemanticErr: unknown) {
        log.warn(
          `[${index + 1}/${total}] Legacy semantic dedupe failed open for vNext claim "${claim.content.slice(0, 80)}...": ` +
          `${legacySemanticErr instanceof Error ? legacySemanticErr.message : String(legacySemanticErr)}`,
        );
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
          ...(legacyDuplicateSignal
            ? { legacyDuplicateSignal }
            : {}),
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
        sourceRefs: options?.sourceRefs?.length
          ? options.sourceRefs
          : [
              {
                sourceType: "memory",
                sourceId: String(parentEntry.id),
                relationship: "extracted_from",
                context: "Claim extracted from source memory entry",
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
      logClaimBudgetDecision("memory.vnext.claim_failed", {
        sourceMemoryId: parentEntry.id,
        budgetKey,
        candidateIndex: claimIdx,
        claimType: claim.claimType,
        confidence: claim.confidence,
        preview: claim.content.slice(0, 120),
        error: claimErr instanceof Error ? claimErr.message : String(claimErr),
        stack: claimErr instanceof Error ? claimErr.stack : undefined,
      }, "info");
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
