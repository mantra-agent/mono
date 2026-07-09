import { memoryStorage, computeContentHash, memoryEntryLightColumns, wrapLightEntry, memoryKnowledgeEligibleCondition } from "./memory-storage";
import { generateEmbedding, generateEmbeddings, isEmbeddingsAvailable } from "./embedding";
import { parseLinkResults } from "./graph-discovery";
import { chatCompletion } from "../model-client";
import { ACTIVITY_MEMORY } from "../job-profiles";
import { getPromptModulePrompt } from "../prompt-modules";
import type { MemoryEntry, MemoryLink } from "@shared/schema";
import { db } from "../db";
import { extractJson } from "../utils/extract-json";
import { sanitizeSummary, validateSummary } from "../utils/sanitize-summary";
import { memoryEntries, memoryLinks } from "@shared/schema";
import { eq, sql, and, or, isNull, isNotNull } from "drizzle-orm";
import { eventBus } from "../event-bus";
import { contextBuilder } from "../context-builder";
import { createLogger } from "../log";

const log = createLogger("MemoryEnrichment");

function emitLog(event: string, payload: Record<string, any>, level: "info" | "debug" | "error" = "info") {
  eventBus.publish({
    category: "memory",
    event,
    payload: { ...payload, level },
  });
}

// --- Progressive Summarization Constants ---
const SINGLE_PASS_LIMIT = 30_000;  // chars — above this, use progressive summarization
const CHUNK_TARGET = 20_000;       // target chunk size in chars
const CHUNK_MIN = 5_000;           // minimum chunk size — merge trailing runts

// --- Claim Extraction Types ---

export interface ClaimCandidate {
  content: string;
  claimType: "state" | "cause" | "action";
  confidence: number;
  topics: string[];
  entityMentions: Array<{ name: string; entityType: string }>;
  /** Index of another claim in this batch that this claim is causally linked to */
  sourceClaimIndex?: number;
}

export interface EnrichmentWithClaims {
  title: string;
  oneLiner: string;
  summary: string;
  tags: string[];
  claims: ClaimCandidate[];
  claimReasoning?: string;
}

export interface MyelinationProgress {
  phase: string;
  current: number;
  total: number;
  detail?: string;
}

export interface MyelinationResult {
  summarized: number;
  embedded: number;
  linked: number;
  errors: string[];
  durationMs: number;
}

type ProgressCallback = (progress: MyelinationProgress) => void;

interface MyelinationStatus {
  running: boolean;
  phase: string;
  current: number;
  total: number;
  detail: string;
  result: MyelinationResult | null;
  error: string | null;
}

const myelinationStatus: MyelinationStatus = {
  running: false,
  phase: "idle",
  current: 0,
  total: 0,
  detail: "",
  result: null,
  error: null,
};

export function getMyelinationStatus(): MyelinationStatus {
  return { ...myelinationStatus };
}

export function startMyelinationBackground(phase: "all" | "summarize" | "embed" | "link" = "all") {
  if (myelinationStatus.running) {
    return { alreadyRunning: true };
  }

  myelinationStatus.running = true;
  myelinationStatus.phase = "starting";
  myelinationStatus.current = 0;
  myelinationStatus.total = 0;
  myelinationStatus.detail = "Starting memory enrichment...";
  myelinationStatus.result = null;
  myelinationStatus.error = null;

  runMemoryEnrichment({
    phase,
    onProgress: (progress) => {
      myelinationStatus.phase = progress.phase;
      myelinationStatus.current = progress.current;
      myelinationStatus.total = progress.total;
      myelinationStatus.detail = progress.detail || "";
    },
  })
    .then((result) => {
      myelinationStatus.running = false;
      myelinationStatus.phase = "complete";
      myelinationStatus.detail = `Done: ${result.summarized} summarized, ${result.embedded} embedded, ${result.linked} linked`;
      myelinationStatus.result = result;
    })
    .catch((err) => {
      myelinationStatus.running = false;
      myelinationStatus.phase = "error";
      myelinationStatus.detail = err.message;
      myelinationStatus.error = err.message;
      log.error(`Background memory enrichment failed:`, err);
    });

  return { alreadyRunning: false };
}

// --- Decomposed summarization pipeline ---

function buildSummarizationPrompt(tagHint: string, internalContext: string, promptProcess: string): string {
  const systemMessage = tagHint ? promptProcess + tagHint : promptProcess;
  return internalContext ? `${internalContext}\n\n${systemMessage}` : systemMessage;
}

function parseSummarizationResponse(
  resultContent: string,
  preferredFallbackTitle: string
): { title: string; oneLiner: string; summary: string; tags: string[] } {
  try {
    const parsed = JSON.parse(extractJson(resultContent));
    const rawTitle = (parsed.title || "").trim();
    const isUntitledLLMFallback = !rawTitle || rawTitle.toLowerCase() === "untitled";
    let title = isUntitledLLMFallback ? preferredFallbackTitle : rawTitle;
    const titleWords = title.split(/\s+/);
    if (titleWords.length > 5) {
      log.warn(`parseSummarizationResponse: title too long (${titleWords.length} words), truncating: "${title}"`);
      title = titleWords.slice(0, 3).join(" ");
    }
    const oneLiner = (parsed.oneLiner || "").trim();
    const summary = (parsed.summary || "").trim();
    const tags: string[] = Array.isArray(parsed.tags)
      ? parsed.tags.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8)
      : [];
    return { title, oneLiner, summary, tags };
  } catch (parseErr) {
    log.warn(`parseSummarizationResponse: Failed to parse as JSON, trying fallback. Content: "${resultContent.slice(0, 200)}"`, parseErr);
    let fallbackSummary = resultContent.trim();
    try {
      const directParsed = JSON.parse(fallbackSummary);
      if (directParsed && typeof directParsed.summary === "string" && directParsed.summary.trim()) {
        const rawTitle = (typeof directParsed.title === "string") ? directParsed.title.trim() : "";
        const title = (!rawTitle || rawTitle.toLowerCase() === "untitled") ? preferredFallbackTitle : rawTitle;
        const oneLiner = (typeof directParsed.oneLiner === "string") ? directParsed.oneLiner.trim() : "";
        const tags: string[] = Array.isArray(directParsed.tags)
          ? directParsed.tags.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8)
          : [];
        return { title, oneLiner, summary: directParsed.summary.trim(), tags };
      }
    } catch {}
    fallbackSummary = sanitizeSummary(fallbackSummary);
    return { title: preferredFallbackTitle, oneLiner: "", summary: fallbackSummary, tags: [] };
  }
}

async function singlePassSummarize(
  entry: { content: string; source?: string | null; title?: string | null }
): Promise<{ title: string; oneLiner: string; summary: string; tags: string[] }> {
  let existingTagHint = "";
  try {
    const { tagRegistry } = await import("../file-storage/tags");
    const existing = await tagRegistry.listTags();
    if (existing.length > 0) {
      const topTags = existing.slice(0, 50).map(t => t.slug);
      existingTagHint = `\n\nExisting tags in the system (prefer reusing these when they fit): ${topTags.join(", ")}`;
    }
  } catch (err) { log.warn("tag hint lookup failed", err); }

  const promptProcess = await getPromptModulePrompt("myelination-summarize");
  const internalSpine = await contextBuilder.resolve({ callType: 'internal', llmMode: 'text' });
  const internalContext = contextBuilder.renderToPrompt(internalSpine);
  const systemContent = buildSummarizationPrompt(existingTagHint, internalContext, promptProcess);

  const startTime = Date.now();
  const summarizeMessages = [
    { role: "system" as const, content: systemContent },
    {
      role: "user" as const,
      content: `Source: ${entry.source || "unknown"}\nTitle: ${entry.title || "untitled"}\n\n${entry.content}`,
    },
  ];
  const result = await chatCompletion({
    activity: ACTIVITY_MEMORY,
    metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
    maxTokens: 2000,
    messages: summarizeMessages,
    temperature: 0.3,
    jsonMode: true,
  });

  const passedInTitle = (entry.title || "").trim();
  const preferredFallbackTitle = passedInTitle || "Untitled";

  const parsed = parseSummarizationResponse(result.content, preferredFallbackTitle);

  // Validate summary quality (Task 4)
  const validation = validateSummary(parsed.summary, entry.content.length);
  if (!validation.valid) {
    emitLog("myelination.summarize.failed", {
      entryTitle: parsed.title,
      reason: validation.reason,
      contentLength: entry.content.length,
      summaryLength: parsed.summary.length,
    }, "error");
    log.warn(`singlePassSummarize: Summary failed validation (${validation.reason}) for "${parsed.title}", returning empty summary`);
    return { ...parsed, summary: "" };
  }

  emitLog("myelination.summarize.quality", {
    entryTitle: parsed.title,
    contentLength: entry.content.length,
    summaryLength: parsed.summary.length,
    compressionRatio: validation.compressionRatio,
  }, "debug");

  return parsed;
}

// --- Chunking utilities for progressive summarization ---

function chunkContent(content: string, targetSize: number = CHUNK_TARGET): string[] {
  if (content.length <= targetSize) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= targetSize) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary (double newline)
    let splitIdx = remaining.lastIndexOf("\n\n", targetSize);
    if (splitIdx < targetSize * 0.5) {
      // Try single newline
      splitIdx = remaining.lastIndexOf("\n", targetSize);
    }
    if (splitIdx < targetSize * 0.3) {
      // Try sentence boundary
      splitIdx = remaining.lastIndexOf(". ", targetSize);
      if (splitIdx > 0) splitIdx += 1; // include the period
    }
    if (splitIdx < targetSize * 0.2) {
      // Hard split as last resort
      splitIdx = targetSize;
    }

    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }

  // Merge trailing runts
  if (chunks.length > 1 && chunks[chunks.length - 1].length < CHUNK_MIN) {
    const runt = chunks.pop()!;
    chunks[chunks.length - 1] += "\n\n" + runt;
  }

  return chunks;
}

async function summarizeChunk(chunk: string, index: number, total: number): Promise<string> {
  const startTime = Date.now();
  const messages = [
    {
      role: "system" as const,
      content: `You are summarizing part ${index + 1} of ${total} of a larger document. Extract the key information, decisions, outcomes, and insights from this section. Be thorough but concise. Output plain text, not JSON.`,
    },
    {
      role: "user" as const,
      content: chunk,
    },
  ];

  const result = await chatCompletion({
    activity: ACTIVITY_MEMORY,
    metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
    maxTokens: 1500,
    messages,
    temperature: 0.3,
  });

  return result.content.trim();
}

async function progressiveSummarize(
  entry: { content: string; source?: string | null; title?: string | null }
): Promise<{ title: string; oneLiner: string; summary: string; tags: string[] }> {
  const chunks = chunkContent(entry.content);
  log.verbose(() => `progressiveSummarize: Content ${entry.content.length} chars → ${chunks.length} chunks`);

  emitLog("myelination.progressive.start", {
    contentLength: entry.content.length,
    chunkCount: chunks.length,
    title: entry.title || "untitled",
  }, "info");

  // Map phase: summarize each chunk sequentially
  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const chunkSummary = await summarizeChunk(chunks[i], i, chunks.length);
      chunkSummaries.push(chunkSummary);
      log.verbose(() => `progressiveSummarize: Chunk ${i + 1}/${chunks.length} → ${chunkSummary.length} chars`);
    } catch (err) {
      log.error(`progressiveSummarize: Chunk ${i + 1}/${chunks.length} failed:`, err);
      chunkSummaries.push(`[Chunk ${i + 1} summarization failed]`);
    }
  }

  // Reduce phase: concatenate chunk summaries and run through singlePassSummarize
  const concatenated = chunkSummaries.join("\n\n---\n\n");
  log.verbose(() => `progressiveSummarize: Concatenated chunk summaries: ${concatenated.length} chars`);

  // If concatenated is still too large, recurse
  if (concatenated.length > SINGLE_PASS_LIMIT) {
    log.verbose(() => `progressiveSummarize: Concatenated summaries still ${concatenated.length} chars, recursing`);
    return progressiveSummarize({ ...entry, content: concatenated });
  }

  const result = await singlePassSummarize({ ...entry, content: concatenated });

  emitLog("myelination.progressive.complete", {
    contentLength: entry.content.length,
    chunkCount: chunks.length,
    finalSummaryLength: result.summary.length,
    compressionRatio: entry.content.length > 0 ? result.summary.length / entry.content.length : 0,
  }, "info");

  return result;
}

// --- vNext claim extraction prompt and parsing ---

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

For each claim, include 1-4 topics and entityMentions for named people, projects, or goals when present. entityType must be "person", "project", or "goal". If one claim is caused by another claim in this batch, set sourceClaimIndex to that claim's 0-based index; otherwise use null.

Respond with only valid JSON:
{"claims":[{"content":"...","claimType":"state|cause|action","confidence":0.0,"topics":["..."],"entityMentions":[{"name":"...","entityType":"person|project|goal"}],"sourceClaimIndex":null}],"reasoning":"short reason, or why no claims were worth storing"}`;

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
function parseClaimsFromResponse(parsed: Record<string, unknown>): ClaimCandidate[] {
  if (!Array.isArray(parsed.claims)) return [];

  const validTypes = new Set(["state", "cause", "action"]);
  const legacyTypeMap: Record<string, ClaimCandidate["claimType"]> = { event: "action" };
  const validEntityTypes = new Set(["person", "project", "goal"]);

  return (parsed.claims as unknown[])
    .filter((c): c is Record<string, unknown> => c != null && typeof c === "object")
    .map((c) => {
      const content = typeof c.content === "string" ? c.content.trim() : "";
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
      return { content, claimType, confidence, topics, entityMentions, sourceClaimIndex } as ClaimCandidate & { claimType: ClaimCandidate["claimType"] | null };
    })
    .filter((c): c is ClaimCandidate => !!c.content && c.claimType !== null && c.confidence >= 0.4)
    .slice(0, 7);
}

function parseSummarizationWithClaimsResponse(
  resultContent: string,
  preferredFallbackTitle: string
): EnrichmentWithClaims {
  try {
    const parsed = JSON.parse(extractJson(resultContent));
    const rawTitle = (parsed.title || "").trim();
    const isUntitledLLMFallback = !rawTitle || rawTitle.toLowerCase() === "untitled";
    let title = isUntitledLLMFallback ? preferredFallbackTitle : rawTitle;
    const titleWords = title.split(/\s+/);
    if (titleWords.length > 5) {
      log.warn(`parseSummarizationWithClaimsResponse: title too long (${titleWords.length} words), truncating: "${title}"`);
      title = titleWords.slice(0, 3).join(" ");
    }
    const oneLiner = (parsed.oneLiner || "").trim();
    const summary = (parsed.summary || "").trim();
    const tags: string[] = Array.isArray(parsed.tags)
      ? parsed.tags.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8)
      : [];
    const claims = parseClaimsFromResponse(parsed);
    const claimReasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : undefined;
    return { title, oneLiner, summary, tags, claims, claimReasoning };
  } catch (parseErr) {
    log.warn(`parseSummarizationWithClaimsResponse: Failed to parse as JSON, trying fallback. Content: "${resultContent.slice(0, 200)}"`, parseErr);
    let fallbackSummary = resultContent.trim();
    try {
      const directParsed = JSON.parse(fallbackSummary);
      if (directParsed && typeof directParsed.summary === "string" && directParsed.summary.trim()) {
        const rawTitle = (typeof directParsed.title === "string") ? directParsed.title.trim() : "";
        const title = (!rawTitle || rawTitle.toLowerCase() === "untitled") ? preferredFallbackTitle : rawTitle;
        const oneLiner = (typeof directParsed.oneLiner === "string") ? directParsed.oneLiner.trim() : "";
        const tags: string[] = Array.isArray(directParsed.tags)
          ? directParsed.tags.map((t: unknown) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8)
          : [];
        const claims = parseClaimsFromResponse(directParsed);
        return { title, oneLiner, summary: directParsed.summary.trim(), tags, claims };
      }
    } catch {}
    fallbackSummary = sanitizeSummary(fallbackSummary);
    return { title: preferredFallbackTitle, oneLiner: "", summary: fallbackSummary, tags: [], claims: [] };
  }
}

async function singlePassSummarizeWithClaims(
  entry: { content: string; source?: string | null; title?: string | null }
): Promise<EnrichmentWithClaims> {
  const messages = [
    { role: "system" as const, content: VNEXT_CLAIM_EXTRACTION_PROMPT },
    {
      role: "user" as const,
      content: `Source: ${entry.source || "unknown"}\nTitle: ${entry.title || "untitled"}\n\n${entry.content}`,
    },
  ];

  const result = await chatCompletion({
    activity: ACTIVITY_MEMORY,
    metadata: { source: "memory-vnext-claim-extraction", activity: ACTIVITY_MEMORY },
    maxTokens: 1600,
    messages,
    temperature: 0.2,
    jsonMode: true,
  });

  const parsed = JSON.parse(extractJson(result.content));
  const claims = parseClaimsFromResponse(parsed).slice(0, 3);
  const claimReasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : undefined;
  const title = (entry.title || "Untitled").trim() || "Untitled";

  if (claims.length > 0) {
    log.debug(`singlePassSummarizeWithClaims: Extracted ${claims.length} vNext claims for "${title}"`);
  }

  return {
    title,
    oneLiner: "",
    summary: "",
    tags: [],
    claims,
    claimReasoning,
  };
}

async function progressiveSummarizeWithClaims(
  entry: { content: string; source?: string | null; title?: string | null }
): Promise<EnrichmentWithClaims> {
  // For large content:
  // 1. Extract claims from each ORIGINAL chunk (preserves source fidelity)
  // 2. Summarize each chunk to plain text (for title/summary/tags)
  // 3. Reduce concatenated summaries through the standard progressive path (no claims)
  const chunks = chunkContent(entry.content);
  log.verbose(() => `progressiveSummarizeWithClaims: Content ${entry.content.length} chars → ${chunks.length} chunks`);

  emitLog("myelination.progressive.start", {
    contentLength: entry.content.length,
    chunkCount: chunks.length,
    title: entry.title || "untitled",
  }, "info");

  // Map phase: summarize chunks AND extract claims from original content in parallel
  const chunkSummaries: string[] = [];
  const allChunkClaims: ClaimCandidate[] = [];

  for (let i = 0; i < chunks.length; i++) {
    // Run summary and claim extraction concurrently on each chunk
    const [summaryResult, claimsResult] = await Promise.allSettled([
      summarizeChunk(chunks[i], i, chunks.length),
      extractClaimsFromChunk(chunks[i], i, chunks.length, entry.source, entry.title),
    ]);

    if (summaryResult.status === "fulfilled") {
      chunkSummaries.push(summaryResult.value);
      log.verbose(() => `progressiveSummarizeWithClaims: Chunk ${i + 1}/${chunks.length} summary → ${summaryResult.value.length} chars`);
    } else {
      log.error(`progressiveSummarizeWithClaims: Chunk ${i + 1}/${chunks.length} summary failed:`, summaryResult.reason);
      chunkSummaries.push(`[Chunk ${i + 1} summarization failed]`);
    }

    if (claimsResult.status === "fulfilled") {
      allChunkClaims.push(...claimsResult.value);
      log.verbose(() => `progressiveSummarizeWithClaims: Chunk ${i + 1}/${chunks.length} → ${claimsResult.value.length} claims`);
    } else {
      log.error(`progressiveSummarizeWithClaims: Chunk ${i + 1}/${chunks.length} claim extraction failed:`, claimsResult.reason);
    }
  }

  // Dedup claims across chunks and cap at 3 per source. vNext memory is sparse by default.
  const MAX_CLAIMS_PER_ENTRY = 3;
  const dedupedClaims = deduplicateChunkClaims(allChunkClaims).slice(0, MAX_CLAIMS_PER_ENTRY);
  if (allChunkClaims.length > MAX_CLAIMS_PER_ENTRY) {
    log.debug(`progressiveSummarizeWithClaims: Capped claims from ${allChunkClaims.length} to ${dedupedClaims.length} (max ${MAX_CLAIMS_PER_ENTRY} per source)`);
  }

  // Reduce phase: get title/summary/tags from concatenated summaries (no claims needed)
  const concatenated = chunkSummaries.join("\n\n---\n\n");
  log.verbose(() => `progressiveSummarizeWithClaims: Concatenated chunk summaries: ${concatenated.length} chars, ${dedupedClaims.length} claims from source`);

  let titleSummaryTags: { title: string; oneLiner: string; summary: string; tags: string[] };
  if (concatenated.length > SINGLE_PASS_LIMIT) {
    log.verbose(() => `progressiveSummarizeWithClaims: Concatenated summaries still ${concatenated.length} chars, recursing for title/summary/tags`);
    titleSummaryTags = await progressiveSummarize({ ...entry, content: concatenated });
  } else {
    titleSummaryTags = await singlePassSummarize({ ...entry, content: concatenated });
  }

  emitLog("myelination.progressive.complete", {
    contentLength: entry.content.length,
    chunkCount: chunks.length,
    finalSummaryLength: titleSummaryTags.summary.length,
    compressionRatio: entry.content.length > 0 ? titleSummaryTags.summary.length / entry.content.length : 0,
    claimCount: dedupedClaims.length,
    claimSource: "original_chunks",
  }, "info");

  return { ...titleSummaryTags, claims: dedupedClaims };
}

// --- Main entry point with claims: routes to single-pass or progressive ---

export async function generateTitleSummaryTagsAndClaims(
  entry: { content: string; source?: string | null; title?: string | null }
): Promise<EnrichmentWithClaims> {
  if (entry.content.length > SINGLE_PASS_LIMIT) {
    log.debug(`generateTitleSummaryTagsAndClaims: Content ${entry.content.length} chars exceeds ${SINGLE_PASS_LIMIT} limit, using progressive summarization with claims`);
    return progressiveSummarizeWithClaims(entry);
  }
  return singlePassSummarizeWithClaims(entry);
}

// --- Legacy entry point: backward compatible, strips claims ---

export async function generateTitleSummaryTags(
  entry: { content: string; source?: string | null; title?: string | null }
): Promise<{ title: string; oneLiner: string; summary: string; tags: string[] }> {
  if (entry.content.length > SINGLE_PASS_LIMIT) {
    log.debug(`generateTitleSummaryTags: Content ${entry.content.length} chars exceeds ${SINGLE_PASS_LIMIT} limit, using progressive summarization`);
    return progressiveSummarize(entry);
  }
  return singlePassSummarize(entry);
}

export async function summarizeBatch(
  entries: MemoryEntry[],
  onProgress?: ProgressCallback
): Promise<{ summarized: number; errors: string[] }> {
  let summarized = 0;
  let skipped = 0;
  const errors: string[] = [];
  const total = entries.length;

  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5);

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j];
      const progressCurrent = i + j + 1;
      const titleHint = entry.title || entry.sourceId || "untitled";

      log.verbose(() => `summarizeBatch: Processing entry #${entry.id} (${progressCurrent}/${total}) layer=${entry.layer} source=${entry.source} hasSummary=${!!entry.summary} hasContentHash=${!!entry.contentHash}`);

      const currentHash = computeContentHash(entry.content);
      if (entry.contentHash && entry.contentHash === currentHash && entry.summary) {
        log.verbose(() => `summarizeBatch: Skipping entry #${entry.id} — content hash unchanged (${currentHash}), summary already exists`);
        skipped++;
        continue;
      }

      onProgress?.({
        phase: "summarize",
        current: progressCurrent,
        total,
        detail: `Summarizing ${progressCurrent}/${total}: ${titleHint.slice(0, 40)}`,
      });

      try {
        const { title, oneLiner, summary, tags } = await generateTitleSummaryTags(entry);
        const hash = currentHash;
        log.verbose(() => `summarizeBatch: Generated for entry #${entry.id}: title="${title}", oneLiner="${oneLiner.slice(0, 60)}", summaryLen=${summary.length}, tags=[${tags.join(",")}], hash=${hash}`);
        await memoryStorage.updateSummaryTitleAndHash(entry.id, summary, title, hash, tags, oneLiner);
        summarized++;
      } catch (err: unknown) {
        const errDetail = err instanceof Error ? (err.stack || err.message) : String(err);
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`summarizeBatch: Error on entry #${entry.id}: ${errDetail}`);
        errors.push(`Entry #${entry.id}: ${errMsg}`);
      }
    }

    const batchEnd = Math.min(i + 5, total);
    emitLog("myelination.progress", { phase: "summarize", current: batchEnd, total }, "debug");
  }

  if (skipped > 0) {
    log.verbose(() => `summarizeBatch: Skipped ${skipped} entries with unchanged content hash`);
  }

  return { summarized, errors };
}

async function embedBatch(
  entries: MemoryEntry[],
  onProgress?: ProgressCallback
): Promise<{ embedded: number; errors: string[] }> {
  let embedded = 0;
  const errors: string[] = [];
  const total = entries.length;

  for (let i = 0; i < entries.length; i += 20) {
    const batch = entries.slice(i, i + 20);
    const texts = batch.map(e => e.summary || e.content);

    try {
      const embeddings = await generateEmbeddings(texts);

      for (let j = 0; j < batch.length; j++) {
        try {
          await memoryStorage.updateEmbedding(batch[j].id, embeddings[j]);
          embedded++;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push(`Entry #${batch[j].id} embedding save: ${errMsg}`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`Embedding batch ${i}-${i + batch.length}: ${errMsg}`);
    }

    const embedCurrent = Math.min(i + batch.length, total);
    onProgress?.({
      phase: "embed",
      current: embedCurrent,
      total,
      detail: `Embedding ${embedCurrent}/${total} entries`,
    });
    emitLog("myelination.progress", { phase: "embed", current: embedCurrent, total }, "debug");
  }

  return { embedded, errors };
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

async function crossBatchLinkBySimilarity(
  entries: MemoryEntry[],
  existingPairs: Set<string>,
  onProgress?: ProgressCallback
): Promise<{ linked: number; errors: string[] }> {
  let linked = 0;
  const errors: string[] = [];

  let withEmbeddings = entries.filter(e => e.embedding && e.summary);
  if (withEmbeddings.length < 2) return { linked: 0, errors: [] };

  onProgress?.({
    phase: "cross-link",
    current: 0,
    total: 1,
    detail: `Analyzing ${withEmbeddings.length} entries for cross-batch similarity...`,
  });

  const MAX_ENTRIES = 500;
  if (withEmbeddings.length > MAX_ENTRIES) {
    withEmbeddings.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt as unknown as string).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt as unknown as string).getTime() : 0;
      return bTime - aTime;
    });
    withEmbeddings = withEmbeddings.slice(0, MAX_ENTRIES);
    log.verbose(() => `crossBatchLinkBySimilarity: capped to ${MAX_ENTRIES} most recent entries (was ${entries.filter(e => e.embedding && e.summary).length})`);
  }

  const totalPairs = (withEmbeddings.length * (withEmbeddings.length - 1)) / 2;
  log.verbose(() => `crossBatchLinkBySimilarity: ${withEmbeddings.length} entries, ~${totalPairs} pairs to compare`);

  const SIMILARITY_THRESHOLD = 0.82;
  const candidatePairs: Array<{ a: MemoryEntry; b: MemoryEntry; sim: number }> = [];
  let pairsProcessed = 0;

  for (let i = 0; i < withEmbeddings.length; i++) {
    for (let j = i + 1; j < withEmbeddings.length; j++) {
      const a = withEmbeddings[i];
      const b = withEmbeddings[j];
      const pairKey = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
      if (existingPairs.has(pairKey)) continue;

      const sim = cosineSimilarity(a.embedding as number[], b.embedding as number[]);
      if (sim >= SIMILARITY_THRESHOLD) {
        candidatePairs.push({ a, b, sim });
      }

      pairsProcessed++;
      if (pairsProcessed % 500 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }

  if (candidatePairs.length === 0) {
    onProgress?.({
      phase: "cross-link",
      current: 1,
      total: 1,
      detail: "No high-similarity cross-batch pairs found",
    });
    return { linked: 0, errors: [] };
  }

  candidatePairs.sort((x, y) => y.sim - x.sim);
  const topPairs = candidatePairs.slice(0, 100);

  const CROSS_BATCH = 10;
  const totalCrossBatches = Math.ceil(topPairs.length / CROSS_BATCH);

  for (let bi = 0; bi < totalCrossBatches; bi++) {
    const batch = topPairs.slice(bi * CROSS_BATCH, (bi + 1) * CROSS_BATCH);
    const pairDescriptions = batch.map((p, idx) =>
      `[PAIR ${idx + 1}] ID:${p.a.id} "${p.a.summary?.slice(0, 80)}" <-> ID:${p.b.id} "${p.b.summary?.slice(0, 80)}" (similarity: ${p.sim.toFixed(3)})`
    ).join("\n");

    try {
      const crossInternalSpine = await contextBuilder.resolve({ callType: 'internal', llmMode: 'text' });
      const crossInternalContext = contextBuilder.renderToPrompt(crossInternalSpine);
      const crossLinkSystemPrompt = await getPromptModulePrompt("myelination-link");
      const crossLinkMessages = [
        {
          role: "system" as const,
          content: crossInternalContext ? `${crossInternalContext}\n\n${crossLinkSystemPrompt}` : crossLinkSystemPrompt,
        },
        { role: "user" as const, content: `Candidate pairs:\n${pairDescriptions}` },
      ];
      const result = await chatCompletion({
        activity: ACTIVITY_MEMORY,
        metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
        maxTokens: 2000,
        messages: crossLinkMessages,
    temperature: 0.3,
        jsonMode: true,
      });

      const validIds = new Set(batch.flatMap(p => [p.a.id, p.b.id]));
      const parsedLinks = parseLinkResults(result.content, validIds);
      for (const link of parsedLinks) {
        const pairKey = `${Math.min(link.from, link.to)}-${Math.max(link.from, link.to)}`;
        if (existingPairs.has(pairKey)) continue;

        try {
          await memoryStorage.createLink(link.from, link.to, link.relationship, link.strength, link.relationshipType);
          existingPairs.add(pairKey);
          linked++;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push(`CrossLink ${link.from}→${link.to}: ${errMsg}`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`Cross-link batch ${bi}: ${errMsg}`);
    }

    onProgress?.({
      phase: "cross-link",
      current: bi + 1,
      total: totalCrossBatches,
      detail: `Cross-linking batch ${bi + 1}/${totalCrossBatches} — ${linked} new links from ${candidatePairs.length} candidates`,
    });
  }

  return { linked, errors };
}

async function linkEntries(
  entries: MemoryEntry[],
  onProgress?: ProgressCallback
): Promise<{ linked: number; errors: string[] }> {
  let linked = 0;
  const errors: string[] = [];

  const entriesWithSummaries = shuffleArray(entries.filter(e => e.summary));
  if (entriesWithSummaries.length < 2) {
    return { linked: 0, errors: [] };
  }

  const existingLinks = await db.select().from(memoryLinks);
  const existingPairs = new Set(
    existingLinks.map(l => `${Math.min(l.fromId, l.toId)}-${Math.max(l.fromId, l.toId)}`)
  );

  const BATCH_SIZE = 30;
  const totalBatches = Math.ceil(entriesWithSummaries.length / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = entriesWithSummaries.slice(batchIdx * BATCH_SIZE, (batchIdx + 1) * BATCH_SIZE);

    const summaryBlock = batch
      .map(e => `[ID:${e.id}] (${e.source}) ${e.summary}`)
      .join("\n");

    try {
      const linkInternalSpine = await contextBuilder.resolve({ callType: 'internal', llmMode: 'text' });
      const linkInternalContext = contextBuilder.renderToPrompt(linkInternalSpine);
      const linkSystemPrompt = await getPromptModulePrompt("myelination-link");
      const batchLinkMessages = [
        {
          role: "system" as const,
          content: linkInternalContext ? `${linkInternalContext}\n\n${linkSystemPrompt}` : linkSystemPrompt,
        },
        {
          role: "user" as const,
          content: `Entries:\n${summaryBlock}`,
        },
      ];
      const result = await chatCompletion({
        activity: ACTIVITY_MEMORY,
        metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
        maxTokens: 2000,
        messages: batchLinkMessages,
    temperature: 0.3,
        jsonMode: true,
      });

      const validIds = new Set(batch.map(e => e.id));
      const parsedLinks = parseLinkResults(result.content, validIds);
      for (const link of parsedLinks) {
        const pairKey = `${Math.min(link.from, link.to)}-${Math.max(link.from, link.to)}`;
        if (existingPairs.has(pairKey)) continue;

        try {
          await memoryStorage.createLink(link.from, link.to, link.relationship, link.strength, link.relationshipType);
          existingPairs.add(pairKey);
          linked++;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push(`Link ${link.from}→${link.to}: ${errMsg}`);
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`Link batch ${batchIdx}: ${errMsg}`);
    }

    onProgress?.({
      phase: "link",
      current: batchIdx + 1,
      total: totalBatches,
      detail: `Linking batch ${batchIdx + 1}/${totalBatches} — ${linked} links found`,
    });
    emitLog("myelination.progress", { phase: "link", current: batchIdx + 1, total: totalBatches, linked }, "debug");
  }

  return { linked, errors };
}

export async function runMemoryEnrichment(
  options: {
    phase?: "all" | "summarize" | "embed" | "link";
    batchSize?: number;
    onProgress?: ProgressCallback;
  } = {}
): Promise<MyelinationResult> {
  const startTime = Date.now();
  const phase = options.phase || "all";
  const onProgress = options.onProgress;
  const allErrors: string[] = [];
  let totalSummarized = 0;
  let totalEmbedded = 0;
  let totalLinked = 0;

  log.debug(`Starting memory enrichment (phase=${phase})`);
  emitLog("myelination.start", { phase });

  if (phase === "all" || phase === "summarize") {
    onProgress?.({ phase: "summarize", current: 0, total: 0, detail: "Querying entries needing summaries..." });

    const needsSummary = await memoryStorage.getEntriesNeedingSummary();
    log.debug(`Phase 1: ${needsSummary.length} entries need summaries`);
    emitLog("myelination.phase.start", { phase: "summarize", count: needsSummary.length });

    if (needsSummary.length === 0) {
      onProgress?.({ phase: "summarize", current: 0, total: 0, detail: "All entries already summarized — skipping" });
    } else {
      onProgress?.({ phase: "summarize", current: 0, total: needsSummary.length, detail: `Found ${needsSummary.length} entries needing summaries` });
      const result = await summarizeBatch(needsSummary, onProgress);
      totalSummarized = result.summarized;
      allErrors.push(...result.errors);
      log.debug(`Phase 1 complete: ${totalSummarized} summarized, ${result.errors.length} errors`);
      emitLog("myelination.phase.complete", { phase: "summarize", summarized: totalSummarized, errors: result.errors.length });
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          log.error(`Summarize error: ${err}`);
          emitLog("myelination.error", { phase: "summarize", error: err }, "error");
        }
      }
    }
  }

  if (phase === "all" || phase === "embed") {
    if (!isEmbeddingsAvailable()) {
      log.debug(`Phase 2 skipped: embeddings not available (no OpenAI API key)`);
      emitLog("myelination.phase.skipped", { phase: "embed", reason: "no OpenAI API key" });
      allErrors.push("Embedding phase skipped: no OpenAI API key configured");
    } else {
      onProgress?.({ phase: "embed", current: 0, total: 0, detail: "Querying entries needing embeddings..." });

      const needsEmbedding = await memoryStorage.getEntriesNeedingEmbedding();
      log.debug(`Phase 2: ${needsEmbedding.length} entries need embeddings`);
      emitLog("myelination.phase.start", { phase: "embed", count: needsEmbedding.length });

      if (needsEmbedding.length === 0) {
        onProgress?.({ phase: "embed", current: 0, total: 0, detail: "All entries already embedded — skipping" });
      } else {
        onProgress?.({ phase: "embed", current: 0, total: needsEmbedding.length, detail: `Found ${needsEmbedding.length} entries needing embeddings` });
        const result = await embedBatch(needsEmbedding, onProgress);
        totalEmbedded = result.embedded;
        allErrors.push(...result.errors);
        log.debug(`Phase 2 complete: ${totalEmbedded} embedded, ${result.errors.length} errors`);
        emitLog("myelination.phase.complete", { phase: "embed", embedded: totalEmbedded, errors: result.errors.length });
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            log.error(`Embed error: ${err}`);
            emitLog("myelination.error", { phase: "embed", error: err }, "error");
          }
        }
      }
    }
  }

  if (phase === "all" || phase === "link") {
    onProgress?.({ phase: "link", current: 0, total: 0, detail: "Querying entries for connection analysis..." });

    const allEntries = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        and(
          or(eq(memoryEntries.layer, "long"), eq(memoryEntries.layer, "workspace")),
          memoryKnowledgeEligibleCondition(),
          sql`summary IS NOT NULL`
        )
      )
      .then(rows => rows.map(r => wrapLightEntry(r as Omit<MemoryEntry, "embedding">)));

    log.debug(`Phase 3: ${allEntries.length} entries with summaries for linking`);
    emitLog("myelination.phase.start", { phase: "link", count: allEntries.length });

    if (allEntries.length < 2) {
      onProgress?.({ phase: "link", current: 0, total: 0, detail: "Not enough entries for linking — skipping" });
    } else {
      const linkResult = await linkEntries(allEntries, onProgress);
      totalLinked = linkResult.linked;
      allErrors.push(...linkResult.errors);
      log.debug(`Phase 3 complete: ${totalLinked} links created, ${linkResult.errors.length} errors`);
      emitLog("myelination.phase.complete", { phase: "link", linked: totalLinked, errors: linkResult.errors.length });

      const existingLinks = await db.select().from(memoryLinks);
      const existingPairsForCross = new Set(
        existingLinks.map(l => `${Math.min(l.fromId, l.toId)}-${Math.max(l.fromId, l.toId)}`)
      );

      onProgress?.({ phase: "cross-link", current: 0, total: 1, detail: "Starting cross-batch similarity analysis..." });
      const crossLinkEntries = await db
        .select()
        .from(memoryEntries)
        .where(
          and(
            or(eq(memoryEntries.layer, "long"), eq(memoryEntries.layer, "workspace")),
            memoryKnowledgeEligibleCondition(),
            sql`summary IS NOT NULL`,
            isNotNull(memoryEntries.embedding)
          )
        );
      const crossResult = await crossBatchLinkBySimilarity(crossLinkEntries, existingPairsForCross, onProgress);
      totalLinked += crossResult.linked;
      allErrors.push(...crossResult.errors);
      if (crossResult.linked > 0) {
        log.debug(`Phase 3b: ${crossResult.linked} cross-batch links created`);
        emitLog("myelination.phase.complete", { phase: "cross-link", linked: crossResult.linked });
      }

      if (linkResult.errors.length > 0 || crossResult.errors.length > 0) {
        for (const err of [...linkResult.errors, ...crossResult.errors]) {
          log.error(`Link error: ${err}`);
          emitLog("myelination.error", { phase: "link", error: err }, "error");
        }
      }
    }
  }

  const durationMs = Date.now() - startTime;
  log.debug(`Memory enrichment complete in ${Math.round(durationMs / 1000)}s: ${totalSummarized} summarized, ${totalEmbedded} embedded, ${totalLinked} linked`);
  emitLog("myelination.complete", { durationMs, summarized: totalSummarized, embedded: totalEmbedded, linked: totalLinked, errors: allErrors.length });

  onProgress?.({
    phase: "complete",
    current: 1,
    total: 1,
    detail: `Done: ${totalSummarized} summarized, ${totalEmbedded} embedded, ${totalLinked} linked`,
  });

  return {
    summarized: totalSummarized,
    embedded: totalEmbedded,
    linked: totalLinked,
    errors: allErrors,
    durationMs,
  };
}
