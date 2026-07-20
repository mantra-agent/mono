import { chatCompletion } from "./model-client";
import type { SemanticTier } from "@shared/model-connectors";
import { ACTIVITY_FRAMING } from "./job-profiles";
import { estimateTokens } from "./context-builder";
import { safeStringify } from "./utils/safe-stringify";
import { createLogger } from "./log";

const log = createLogger("CompactionSummarizer");

/**
 * Narrative summarization for between-turn session compaction.
 *
 * Contract: input is NEVER truncated. The transcript is split into chunks at
 * message boundaries (oversized single messages split at line boundaries),
 * each chunk is summarized independently (map), and the segment notes are
 * merged into one narrative (reduce). A chunk whose model calls fail after a
 * retry degrades to a mechanical excerpt for that segment only; total failure
 * of the reduce step returns null and the caller falls back to the
 * deterministic continuation capsule. This module never throws.
 */

export interface SummarizableMessage {
  role: string;
  content: string;
  thinking?: string;
  toolCalls?: Array<{
    toolName?: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
    output?: string;
    error?: boolean | string | Record<string, unknown>;
  }>;
}

export interface CompactionSummaryResult {
  narrative: string;
  segmentCount: number;
  degradedSegments: number;
}

/** Input-token budget per map call. Grows adaptively if the transcript would exceed MAX_SEGMENTS. */
const SEGMENT_INPUT_TOKENS = 20_000;
/** Hard cap on model calls for one compaction; chunk size grows instead of dropping content. */
const MAX_SEGMENTS = 32;
/** Parallel map calls. */
const MAP_CONCURRENCY = 3;
const MAP_OUTPUT_TOKENS = 500;
const REDUCE_OUTPUT_TOKENS = 1_400;
const MAP_TIMEOUT_MS = 60_000;
const REDUCE_TIMEOUT_MS = 90_000;

const NARRATIVE_FORMAT = `Write a continuation summary in markdown with exactly these sections (omit a section only when it has no content):
## Objective
## What happened
## Decisions
## State changes
## Failures and blockers
## Open threads
## Resume point

Rules: dense prose and short bullets, no preamble, no meta-commentary about summarizing. Preserve exact identifiers verbatim: canonical references like @page:slug or @pr:repo/123, session IDs, archive ref IDs, file paths, branch names, commit SHAs, numbers. State what was concluded and why, not a play-by-play of tool calls. Target 500-800 tokens.`;

function renderToolCall(toolCall: NonNullable<SummarizableMessage["toolCalls"]>[number]): string {
  const name = toolCall.toolName || "tool";
  const args = toolCall.arguments
    ? safeStringify(toolCall.arguments, { maxBytes: 4_000, maxDepth: 5, maxKeys: 32, maxArrayItems: 24, maxStrLen: 800, label: "compaction-summarizer.tool-args" })
    : "";
  const rawResult = toolCall.result ?? toolCall.output;
  const result = rawResult == null
    ? ""
    : typeof rawResult === "string"
      ? rawResult
      : safeStringify(rawResult, { maxBytes: 100_000, maxDepth: 8, maxKeys: 64, maxArrayItems: 64, maxStrLen: 20_000, label: "compaction-summarizer.tool-result" });
  const status = toolCall.error ? "ERROR" : "ok";
  return `[tool] ${name}${args ? ` args=${args}` : ""} → ${status}${result ? `\n${result}` : ""}`;
}

function renderMessage(message: SummarizableMessage): string {
  const parts: string[] = [];
  if (message.content?.trim()) parts.push(`[${message.role}]\n${message.content}`);
  for (const toolCall of message.toolCalls || []) parts.push(renderToolCall(toolCall));
  return parts.join("\n");
}

/** Split one oversized text at line boundaries into pieces at or under the token budget. */
function splitOversized(text: string, budgetTokens: number): string[] {
  const budgetChars = budgetTokens * 4;
  if (text.length <= budgetChars) return [text];
  const pieces: string[] = [];
  const lines = text.split("\n");
  let current: string[] = [];
  let currentLength = 0;
  for (const line of lines) {
    // A single line longer than the budget is split by character range as a last resort.
    if (line.length > budgetChars) {
      if (current.length) {
        pieces.push(current.join("\n"));
        current = [];
        currentLength = 0;
      }
      for (let offset = 0; offset < line.length; offset += budgetChars) {
        pieces.push(line.slice(offset, offset + budgetChars));
      }
      continue;
    }
    if (currentLength + line.length + 1 > budgetChars && current.length) {
      pieces.push(current.join("\n"));
      current = [];
      currentLength = 0;
    }
    current.push(line);
    currentLength += line.length + 1;
  }
  if (current.length) pieces.push(current.join("\n"));
  return pieces;
}

/** Group rendered messages into segments at message boundaries, never dropping content. */
function buildSegments(messages: SummarizableMessage[]): string[] {
  const rendered = messages.map(renderMessage).filter((text) => text.trim().length > 0);
  const totalTokens = rendered.reduce((sum, text) => sum + estimateTokens(text), 0);
  const budget = Math.max(SEGMENT_INPUT_TOKENS, Math.ceil(totalTokens / MAX_SEGMENTS) + 1_000);
  const segments: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  const flush = () => {
    if (current.length) {
      segments.push(current.join("\n\n"));
      current = [];
      currentTokens = 0;
    }
  };
  for (const text of rendered) {
    const tokens = estimateTokens(text);
    if (tokens > budget) {
      flush();
      for (const piece of splitOversized(text, budget)) segments.push(piece);
      continue;
    }
    if (currentTokens + tokens > budget) flush();
    current.push(text);
    currentTokens += tokens;
  }
  flush();
  return segments;
}

async function timedCompletion(options: {
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  sessionId: string;
  purpose: string;
  /** Optional semantic tier override for the call's explicit quality/resource budget. */
  tier?: SemanticTier;
}): Promise<string> {
  const result = await Promise.race([
    chatCompletion({
      activity: ACTIVITY_FRAMING,
      ...(options.tier
        ? { semanticTierOverride: options.tier, overrideReason: "compaction narrative synthesis quality" }
        : {}),
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: options.user },
      ],
      maxTokens: options.maxTokens,
      temperature: 0.2,
      metadata: { source: `compaction-summarizer.${options.purpose}`, sessionId: options.sessionId, activity: ACTIVITY_FRAMING },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`compaction summarization timeout (${options.purpose})`)), options.timeoutMs),
    ),
  ]);
  const content = result.content?.trim();
  if (!content) throw new Error(`compaction summarization returned empty content (${options.purpose})`);
  return content;
}

async function withRetry(fn: () => Promise<string>, label: string, sessionId: string): Promise<string> {
  try {
    return await fn();
  } catch (firstError) {
    log.warn(`retrying ${label} sessionId=${sessionId} error=${firstError instanceof Error ? firstError.message : String(firstError)}`);
    return await fn();
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Deterministic per-segment fallback when both model attempts fail. Bounded and disclosed; the archive holds the exact record. */
function degradedSegmentNote(segment: string, index: number, total: number): string {
  const head = collapse(segment.slice(0, 700));
  const tail = segment.length > 1_400 ? collapse(segment.slice(-500)) : "";
  return `[Segment ${index + 1}/${total}: summary unavailable, mechanical excerpt] ${head}${tail ? ` … ${tail}` : ""}`;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Produce a narrative continuation summary for compacted messages.
 * Returns null when the final narrative cannot be produced; callers fall back
 * to the deterministic continuation capsule.
 */
export async function summarizeCompactedMessages(input: {
  sessionId: string;
  messages: SummarizableMessage[];
  capsuleFacts: string;
}): Promise<CompactionSummaryResult | null> {
  try {
    const segments = buildSegments(input.messages);
    if (segments.length === 0) return null;
    let degradedSegments = 0;

    if (segments.length === 1) {
      const narrative = await withRetry(
        () => timedCompletion({
          system: `You are summarizing an archived portion of a conversation between a user and their AI agent so the conversation can continue seamlessly with the summary in place of the original messages.\n\n${NARRATIVE_FORMAT}`,
          user: `Deterministic extraction of key facts (use to anchor identifiers and outcomes):\n${input.capsuleFacts}\n\nFull transcript segment:\n${segments[0]}`,
          maxTokens: REDUCE_OUTPUT_TOKENS,
          timeoutMs: REDUCE_TIMEOUT_MS,
          sessionId: input.sessionId,
          purpose: "single",
          tier: "balanced",
        }),
        "single-segment summary",
        input.sessionId,
      );
      return { narrative, segmentCount: 1, degradedSegments: 0 };
    }

    const notes = await mapWithConcurrency(segments, MAP_CONCURRENCY, async (segment, index) => {
      try {
        return await withRetry(
          () => timedCompletion({
            system: `You are summarizing segment ${index + 1} of ${segments.length} from an archived conversation between a user and their AI agent. Produce dense factual notes for a later merge step. Cover: what was being worked on, conclusions reached, actions taken and their outcomes, state changes, failures, and unresolved threads. Preserve exact identifiers verbatim (references like @page:slug, IDs, paths, branches, SHAs, numbers). Bullets only, no preamble. Target under 300 tokens.`,
            user: segment,
            maxTokens: MAP_OUTPUT_TOKENS,
            timeoutMs: MAP_TIMEOUT_MS,
            sessionId: input.sessionId,
            purpose: `map-${index + 1}`,
            tier: "fast",
          }),
          `segment ${index + 1}/${segments.length}`,
          input.sessionId,
        );
      } catch (error) {
        degradedSegments++;
        log.warn(`segment degraded to mechanical excerpt sessionId=${input.sessionId} segment=${index + 1}/${segments.length} error=${error instanceof Error ? error.message : String(error)}`);
        return degradedSegmentNote(segment, index, segments.length);
      }
    });

    const narrative = await withRetry(
      () => timedCompletion({
        system: `You are merging sequential segment notes from an archived conversation between a user and their AI agent into one continuation summary, so the conversation can continue seamlessly with the summary in place of the original messages.\n\n${NARRATIVE_FORMAT}`,
        user: `Deterministic extraction of key facts (use to anchor identifiers and outcomes):\n${input.capsuleFacts}\n\nSegment notes in chronological order:\n\n${notes.map((note, index) => `### Segment ${index + 1}\n${note}`).join("\n\n")}`,
        maxTokens: REDUCE_OUTPUT_TOKENS,
        timeoutMs: REDUCE_TIMEOUT_MS,
        sessionId: input.sessionId,
        purpose: "reduce",
        tier: "balanced",
      }),
      "reduce summary",
      input.sessionId,
    );

    log.log(`narrative summary produced sessionId=${input.sessionId} segments=${segments.length} degradedSegments=${degradedSegments} narrativeLen=${narrative.length}`);
    return { narrative, segmentCount: segments.length, degradedSegments };
  } catch (error) {
    log.warn(`narrative summarization failed; caller should fall back to capsule sessionId=${input.sessionId} error=${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
