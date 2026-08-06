import { chatCompletion } from "./model-client";
import { ACTIVITY_MEMORY } from "./job-profiles";
import { getPromptModulePrompt } from "./prompt-modules";
import { extractJson } from "./utils/extract-json";
import { sanitizeSummary, validateSummary } from "./utils/sanitize-summary";
import { contextBuilder } from "./context-builder";
import { eventBus } from "./event-bus";
import { createLogger } from "./log";
import { buildTagGuidance } from "@shared/tag-taxonomy";
import { gateProposedTags } from "./tag-proposal";

const log = createLogger("TitleSummaryTags");
const SINGLE_PASS_LIMIT = 30_000;
const CHUNK_TARGET = 20_000;
const CHUNK_MIN = 5_000;

export interface TitleSummaryTagsInput {
  content: string;
  source?: string | null;
  title?: string | null;
}

export interface TitleSummaryTagsResult {
  title: string;
  oneLiner: string;
  summary: string;
  tags: string[];
}

function emitSummarizationEvent(
  event: string,
  payload: Record<string, unknown>,
  level: "info" | "debug" | "error" = "info",
): void {
  eventBus.publish({
    category: "memory",
    event,
    payload: { ...payload, level },
  });
}

function buildSummarizationPrompt(
  tagHint: string,
  internalContext: string,
  promptProcess: string,
): string {
  const systemMessage = tagHint ? promptProcess + tagHint : promptProcess;
  return internalContext ? `${internalContext}\n\n${systemMessage}` : systemMessage;
}

function parseSummarizationResponse(
  resultContent: string,
  preferredFallbackTitle: string,
): TitleSummaryTagsResult {
  try {
    const parsed = JSON.parse(extractJson(resultContent));
    const rawTitle = (parsed.title || "").trim();
    let title = !rawTitle || rawTitle.toLowerCase() === "untitled"
      ? preferredFallbackTitle
      : rawTitle;
    const titleWords = title.split(/\s+/);
    if (titleWords.length > 5) {
      log.warn(`summarization title too long (${titleWords.length} words), truncating`);
      title = titleWords.slice(0, 3).join(" ");
    }
    const oneLiner = (parsed.oneLiner || "").trim();
    const summary = (parsed.summary || "").trim();
    const tags: string[] = Array.isArray(parsed.tags)
      ? parsed.tags
          .map((tag: unknown) => String(tag).trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 8)
      : [];
    return { title, oneLiner, summary, tags };
  } catch (parseError) {
    log.warn("summarization response was not valid structured JSON", parseError);
    let fallbackSummary = resultContent.trim();
    try {
      const directParsed = JSON.parse(fallbackSummary);
      if (
        directParsed &&
        typeof directParsed.summary === "string" &&
        directParsed.summary.trim()
      ) {
        const rawTitle = typeof directParsed.title === "string"
          ? directParsed.title.trim()
          : "";
        const title = !rawTitle || rawTitle.toLowerCase() === "untitled"
          ? preferredFallbackTitle
          : rawTitle;
        const oneLiner = typeof directParsed.oneLiner === "string"
          ? directParsed.oneLiner.trim()
          : "";
        const tags: string[] = Array.isArray(directParsed.tags)
          ? directParsed.tags
              .map((tag: unknown) => String(tag).trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 8)
          : [];
        return {
          title,
          oneLiner,
          summary: directParsed.summary.trim(),
          tags,
        };
      }
    } catch {
      // Fall through to the bounded plain-text sanitizer.
    }
    fallbackSummary = sanitizeSummary(fallbackSummary);
    return {
      title: preferredFallbackTitle,
      oneLiner: "",
      summary: fallbackSummary,
      tags: [],
    };
  }
}

async function singlePassSummarize(
  entry: TitleSummaryTagsInput,
): Promise<TitleSummaryTagsResult> {
  let existingTagHint = buildTagGuidance([]);
  try {
    const { tagService } = await import("./tag-service");
    const existing = await tagService.listTags();
    existingTagHint = buildTagGuidance(existing.slice(0, 50).map((tag) => tag.slug));
  } catch (error) {
    log.warn("tag hint lookup failed", error);
  }

  const promptProcess = await getPromptModulePrompt("myelination-summarize");
  const internalSpine = await contextBuilder.resolve({
    callType: "internal",
    llmMode: "text",
  });
  const internalContext = contextBuilder.renderToPrompt(internalSpine);
  const result = await chatCompletion({
    activity: ACTIVITY_MEMORY,
    metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
    maxTokens: 2000,
    messages: [
      {
        role: "system" as const,
        content: buildSummarizationPrompt(existingTagHint, internalContext, promptProcess),
      },
      {
        role: "user" as const,
        content: `Source: ${entry.source || "unknown"}\nTitle: ${entry.title || "untitled"}\n\n${entry.content}`,
      },
    ],
    temperature: 0.3,
    jsonMode: true,
  });

  const preferredFallbackTitle = (entry.title || "").trim() || "Untitled";
  const parsed = parseSummarizationResponse(result.content, preferredFallbackTitle);
  const validation = validateSummary(parsed.summary, entry.content.length);
  if (!validation.valid) {
    emitSummarizationEvent(
      "myelination.summarize.failed",
      {
        entryTitle: parsed.title,
        reason: validation.reason,
        contentLength: entry.content.length,
        summaryLength: parsed.summary.length,
      },
      "error",
    );
    log.warn(`summary failed validation (${validation.reason})`);
    return { ...parsed, summary: "" };
  }

  emitSummarizationEvent(
    "myelination.summarize.quality",
    {
      entryTitle: parsed.title,
      contentLength: entry.content.length,
      summaryLength: parsed.summary.length,
      compressionRatio: validation.compressionRatio,
    },
    "debug",
  );
  return parsed;
}

function chunkContent(content: string, targetSize = CHUNK_TARGET): string[] {
  if (content.length <= targetSize) return [content];
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= targetSize) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf("\n\n", targetSize);
    if (splitIndex < targetSize * 0.5) {
      splitIndex = remaining.lastIndexOf("\n", targetSize);
    }
    if (splitIndex < targetSize * 0.3) {
      splitIndex = remaining.lastIndexOf(". ", targetSize);
      if (splitIndex > 0) splitIndex += 1;
    }
    if (splitIndex < targetSize * 0.2) splitIndex = targetSize;
    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  if (chunks.length > 1 && chunks[chunks.length - 1].length < CHUNK_MIN) {
    const trailingChunk = chunks.pop()!;
    chunks[chunks.length - 1] += `\n\n${trailingChunk}`;
  }
  return chunks;
}

async function summarizeChunk(chunk: string, index: number, total: number): Promise<string> {
  const result = await chatCompletion({
    activity: ACTIVITY_MEMORY,
    metadata: { source: "memory-consolidation", activity: ACTIVITY_MEMORY },
    maxTokens: 1500,
    messages: [
      {
        role: "system" as const,
        content: `You are summarizing part ${index + 1} of ${total} of a larger document. Extract the key information, decisions, outcomes, and insights from this section. Be thorough but concise. Output plain text, not JSON.`,
      },
      { role: "user" as const, content: chunk },
    ],
    temperature: 0.3,
  });
  return result.content.trim();
}

async function progressiveSummarize(
  entry: TitleSummaryTagsInput,
): Promise<TitleSummaryTagsResult> {
  const chunks = chunkContent(entry.content);
  emitSummarizationEvent("myelination.progressive.start", {
    contentLength: entry.content.length,
    chunkCount: chunks.length,
    title: entry.title || "untitled",
  });

  const chunkSummaries: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    try {
      chunkSummaries.push(await summarizeChunk(chunks[index], index, chunks.length));
    } catch (error) {
      log.error(`chunk summarization failed at ${index + 1}/${chunks.length}`, error);
      chunkSummaries.push(`[Chunk ${index + 1} summarization failed]`);
    }
  }

  const concatenated = chunkSummaries.join("\n\n---\n\n");
  const result = concatenated.length > SINGLE_PASS_LIMIT
    ? await progressiveSummarize({ ...entry, content: concatenated })
    : await singlePassSummarize({ ...entry, content: concatenated });

  emitSummarizationEvent("myelination.progressive.complete", {
    contentLength: entry.content.length,
    chunkCount: chunks.length,
    finalSummaryLength: result.summary.length,
    compressionRatio: entry.content.length > 0
      ? result.summary.length / entry.content.length
      : 0,
  });
  return result;
}

export async function generateTitleSummaryTags(
  entry: TitleSummaryTagsInput,
): Promise<TitleSummaryTagsResult> {
  const useProgressive = entry.content.length > SINGLE_PASS_LIMIT;
  if (useProgressive) {
    log.debug(`content exceeds ${SINGLE_PASS_LIMIT} chars; using progressive summarization`);
  }
  const result = useProgressive
    ? await progressiveSummarize(entry)
    : await singlePassSummarize(entry);
  return { ...result, tags: gateProposedTags(result.tags).tags };
}
