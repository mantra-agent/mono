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

import { memoryVnextClaimStorage, persistClaimCandidates } from "./vnext-claim-storage";
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
// Extraction prompt (v7 — predictive-value filter, preference/rule rejection)
// ---------------------------------------------------------------------------

const VNEXT_CLAIM_EXTRACTION_PROMPT = `You extract durable vNext memory claims. You are not summarizing.

Default to returning no claims. Most sources should produce {"claims": []}.

Goal: extract only claims that improve Agent's ability to predict the external world — people's behavior, relationship dynamics, organizational incentives, market forces, financial constraints, family dynamics, health trajectories, or non-obvious causal patterns. Every claim must pass this test: "Does this improve prediction of the external world or people in it?"

## Hard rejections — never extract these

1. **Ray's preferences about how Agent should work.** These are stored in the preferences system. Examples: "Ray prefers short responses," "Ray wants workflow steps to be self-contained," "Ray considers conservative animations too safe."
2. **Agent behavioral rules or constraints.** These are stored in the rules system. Examples: "Agent should not force workflow acceptance without approval," "Agent is prohibited from logging wellness activities autonomously."
3. **Agent/system architecture facts.** Recoverable from code, docs, and tools. Examples: "Lightway is hosted on Cloudflare Pages," "The scan service uses a dispatch table pattern."
4. **Implementation summaries.** Code changes, PRs, migrations, deploys, builds, database row counts, task/project status snapshots, UI changelog facts.
5. **Short-lived calendar/scheduling facts.** Specific meeting times and dates that expire within days.
6. **Process status messages** with no underlying external-world fact.
7. **Near-restatements of the source.** If the claim just paraphrases a sentence from the source, reject it.

## What to extract

Claims about the external world that Agent cannot recover from structured tools:

- Who a person is, what they do, how they relate to Ray or each other, what motivates them
- Organizational dynamics, power structures, incentive alignment
- Financial facts: compensation ranges, funding status, account structures, deal terms
- Relationship context: trust level shifts, communication patterns, conflict dynamics, family dynamics
- Strategic context: why a decision was made, what pressure created it, what constraints bind it
- Commitments and promises between people (not task assignments to Agent)
- Market signals: industry shifts, competitor moves, pricing dynamics

Extract 0-3 claims. Never extract more than 3.

Claim types:
- "state": durable external reality about people, relationships, organizations, finances, or constraints. Who works where, who manages what, family relationships, financial structures, identity facts, relationship dynamics. These anchor the memory graph for cross-domain linking.
- "cause": why an external behavior, decision, pressure, or constraint exists. Causal claims are the most valuable — they explain the mechanism, not just the fact.
- "action": a commitment, plan, or intended action between people — especially when it reveals strategy, positioning, or relationship-building intent. Reject actions that are purely Agent task assignments.

## Negative examples — do NOT extract claims like these

BAD: "Ray prefers Mantra's landing page animations to feel more ambitious and premium." → This is a preference. It belongs in the preferences system.
BAD: "Agent should not force workflow acceptance past browser evidence gates without Ray's approval." → This is an Agent rule. It belongs in the rules system.
BAD: "Ray expects implementation reviews to explicitly compare code against engineering principles." → This is a work preference/rule.
BAD: "The Lightway site is hosted on Cloudflare Pages rather than Railway." → This is an architecture fact recoverable from infrastructure tools.
BAD: "PR #175 merged at 60e5f30, extending the FTUE flow." → This is an implementation summary.
BAD: "Workflow child sessions should be spawned with full stage definitions." → This is an Agent architecture preference.

## Positive examples — these ARE worth extracting

GOOD: "Rob Topping just had hip surgery and expects to be mobile again by end of July." → External fact about a person that predicts availability and explains communication gaps.
GOOD: "Jeremie and Mike have started discussing Mantra funding; Mike is thinking on it." → Relationship dynamic between two external people with strategic implications.
GOOD: "ServiceNow VP Interactive Experiences base compensation is $355k–$430k." → External market fact that anchors future negotiation.
GOOD: "Toku McCree is expected to give unusually blunt, skeptical feedback on Mantra." → Prediction about a person's behavior that changes preparation strategy.
GOOD: "Mom felt off-put by Anna's no-kissing rule and is weighing whether she feels welcome enough to invest deeper in the family." → Causal dynamic between family members that predicts future relationship trajectory.

Extraction principle: look through the process wrapper to the underlying facts. "Enriched 1 email thread about X" is not a claim, but the X itself may contain one. "Agent updated person record with Y" is not a claim, but Y may be.

For each claim, include a "title": a 1-3 word Title Case label naming the subject of the claim (e.g. "Toku Outreach", "Brand Colors", "Eric Kamont"). Never more than 3 words.

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

// ---------------------------------------------------------------------------
// Preference/rule pattern detection for scorer penalty
// ---------------------------------------------------------------------------

const PREFERENCE_RULE_PATTERNS = [
  /^ray\s+(prefers?|wants?|expects?|considers?|likes?|dislikes?|values?)\b/i,
  /^agent\s+(should|must|is\s+prohibited|is\s+not\s+allowed|cannot)\b/i,
  /\bray\s+prefers?\b/i,
  /\bagent\s+should\b/i,
  /\bagent\s+is\s+prohibited\b/i,
  /\bbehavioral\s+rule\b/i,
  /\bwork(flow|space)\s+(child\s+)?sessions?\s+should\b/i,
];

const ARCHITECTURE_PATTERNS = [
  /\bis\s+hosted\s+on\b/i,
  /\bPR\s+#?\d+\s+merged\b/i,
  /\bmigration\s+\d+\b/i,
  /\bbranch\s+(feat|fix|chore)\//i,
  /\bnpm\s+run\s+build\b/i,
];

function isPreferenceOrRuleShaped(content: string): boolean {
  return PREFERENCE_RULE_PATTERNS.some((p) => p.test(content));
}

function isArchitectureShaped(content: string): boolean {
  return ARCHITECTURE_PATTERNS.some((p) => p.test(content));
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

  // Hard reject preference/rule restatements and architecture facts
  if (claim.claimType === "state" && isPreferenceOrRuleShaped(content)) {
    return { score: 0, reasons: ["preference_or_rule"], rejectedReason: "preference_rule_restatement" };
  }
  if (isArchitectureShaped(content)) {
    return { score: 0, reasons: ["architecture_fact"], rejectedReason: "architecture_restatement" };
  }

  score += Math.max(0, Math.min(1, claim.confidence)) * 40;
  reasons.push("confidence");

  // Favor cause and action claims over state
  if (claim.claimType === "cause") {
    score += 30;
    reasons.push("causal");
  } else if (claim.claimType === "action") {
    score += 25;
    reasons.push("action_relevant");
  } else {
    // State claims get a smaller base but can recover through entity/topic richness
    score += 10;
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
// Process extracted claims — budget scoring + canonical persist
// ---------------------------------------------------------------------------

async function processExtractedClaims(
  claims: ClaimCandidate[],
  parentEntry: MemoryEntry,
  _index: number,
  _total: number,
  options?: {
    sourceRefs?: VnextExtractionSource["sourceRefs"];
    sourceLabel?: string;
  },
): Promise<ClaimProcessingResult> {
  const maxClaims = await getClaimExtractionBudget();
  const budgetKey = getClaimExtractionBudgetKey(parentEntry);
  const budgetScope = {
    budgetKey,
    maxClaims,
    source: (parentEntry.source || "chat_journal") as MemorySource,
    sourceId: parentEntry.sourceId,
    sourceMemoryId: parentEntry.id,
  };
  const existingAccepted = await memoryVnextClaimStorage.countClaimsForExtractionBudget(budgetScope);
  const remainingBudget = Math.max(0, maxClaims - existingAccepted);
  const ranked = rankClaimsForBudget(claims, remainingBudget);

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

  if (ranked.accepted.length === 0) {
    return { created: 0, reinforced: 0, skipped: ranked.rejected.length };
  }

  // Build budget metadata for each accepted claim
  const acceptedClaims = ranked.accepted.map((candidate) => candidate.claim);

  // Determine createdAt from parent entry's source session date
  const parentMeta = (parentEntry.metadata as Record<string, unknown>) || {};
  const sourceDate = parentMeta.sessionDate
    ? new Date(parentMeta.sessionDate as string)
    : parentEntry.createdAt;

  // Delegate to canonical persist path
  const result = await persistClaimCandidates({
    claims: acceptedClaims,
    source: (parentEntry.source || "chat_journal") as MemorySource,
    sourceId: parentEntry.sourceId,
    sourceMemoryId: parentEntry.id,
    createdAt: sourceDate,
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
    writeBudget: {
      budget: budgetScope,
      acceptedRank: 1,
      candidatesSeen: claims.length,
      candidateIndex: 0,
      candidateScore: ranked.accepted[0]?.score ? Number(ranked.accepted[0].score.toFixed(2)) : 0,
      candidateReasons: ranked.accepted[0]?.reasons || [],
      existingAcceptedAtStart: existingAccepted,
    },
    logPrefix: `extraction[${parentEntry.id}]`,
  });

  return {
    created: result.created,
    reinforced: result.reinforced,
    skipped: result.skipped + ranked.rejected.length,
  };
}
