import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { documentStorage } from "./document-storage";
import { libraryPages } from "@shared/models/info";
import { createLogger } from "../log";

const log = createLogger("VnextContentChunking");

/** Default chunk size target in characters (~16K) */
const DEFAULT_MAX_CHUNK_SIZE = 16_000;

/** Marker used to detect message boundaries in session content */
const MESSAGE_BOUNDARY_PATTERN = /\n(?=(?:user|assistant|tool|message): )/;

/** Marker used to detect paragraph/heading boundaries in library content */
const PARAGRAPH_BOUNDARY_PATTERN = /\n(?=#{1,6} |\n)/;

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * SHA-256 hash of content for change detection.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Content chunking
// ---------------------------------------------------------------------------

export type SplitMode = "message" | "paragraph";

/**
 * Split content into chunks on natural boundaries.
 *
 * - `message` mode splits on message role prefixes (for session transcripts).
 * - `paragraph` mode splits on headings and double-newlines (for library pages).
 *
 * Each chunk receives the provided `header` so the extraction LLM has
 * title/topic context even in later chunks.
 *
 * A single segment that exceeds `maxChunkSize` becomes its own chunk (rare).
 */
export function chunkContent(
  content: string,
  maxChunkSize: number = DEFAULT_MAX_CHUNK_SIZE,
  splitMode: SplitMode = "message",
  header?: string,
): string[] {
  if (!content.trim()) return [];

  const headerPrefix = header ? `${header}\n\n` : "";
  const headerLen = headerPrefix.length;
  const effectiveMax = maxChunkSize - headerLen;

  if (effectiveMax <= 0) {
    log.warn(`header alone exceeds maxChunkSize=${maxChunkSize}, returning single chunk`);
    return [headerPrefix + content];
  }

  // If content fits in one chunk, skip splitting
  if (content.length <= effectiveMax) {
    return [headerPrefix + content];
  }

  const pattern =
    splitMode === "message"
      ? MESSAGE_BOUNDARY_PATTERN
      : PARAGRAPH_BOUNDARY_PATTERN;

  const segments = content.split(pattern).filter((s) => s.trim());

  const chunks: string[] = [];
  let currentParts: string[] = [];
  let currentLen = 0;

  for (const segment of segments) {
    const segLen = segment.length + (currentParts.length > 0 ? 1 : 0); // +1 for newline joiner

    if (currentLen + segLen > effectiveMax && currentParts.length > 0) {
      // Flush current chunk
      chunks.push(headerPrefix + currentParts.join("\n"));
      currentParts = [];
      currentLen = 0;
    }

    // Single segment exceeds max — emit as its own chunk
    if (segment.length > effectiveMax && currentParts.length === 0) {
      chunks.push(headerPrefix + segment);
      continue;
    }

    currentParts.push(segment);
    currentLen += segLen;
  }

  if (currentParts.length > 0) {
    chunks.push(headerPrefix + currentParts.join("\n"));
  }

  log.debug(
    `chunked content: mode=${splitMode} totalLen=${content.length} chunks=${chunks.length} maxChunkSize=${maxChunkSize}`,
  );

  return chunks;
}

// ---------------------------------------------------------------------------
// Session content building
// ---------------------------------------------------------------------------

interface SessionContentResult {
  content: string;
  messageCount: number;
}

/**
 * Load ALL messages from a session and format them for vNext extraction.
 *
 * Loads every message without caps or slicing. The caller is expected
 * to use `chunkContent` to break the result into extraction-sized batches.
 */
export async function buildFullSessionContent(
  sessionId: string,
): Promise<SessionContentResult> {
  const doc = await documentStorage.getDocument("chat", sessionId);
  if (!doc) {
    log.warn(`buildFullSessionContent: session not found id=${sessionId}`);
    return { content: "", messageCount: 0 };
  }

  let data: {
    title?: string;
    topics?: string[];
    summary?: string;
    memorySummary?: string;
    messages?: Array<{
      role?: string;
      content?: string;
      isError?: boolean;
    }>;
  };

  try {
    data = JSON.parse(doc.content);
  } catch {
    log.warn(`buildFullSessionContent: parse error id=${sessionId}`);
    return { content: "", messageCount: 0 };
  }

  const sections: string[] = [];
  sections.push(`Session title: ${data.title || "Untitled"}`);

  if (data.topics?.length) {
    sections.push(`Topics: ${data.topics.join(", ")}`);
  }

  if (data.memorySummary?.trim()) {
    sections.push(`Existing memory summary: ${data.memorySummary.trim()}`);
  }

  if (data.summary?.trim()) {
    sections.push(`Session summary: ${data.summary.trim()}`);
  }

  const messages = data.messages || [];
  let messageCount = 0;

  const formatted: string[] = [];
  for (const msg of messages) {
    if (!msg.content?.trim()) continue;
    if (msg.role === "system") continue;
    if (msg.isError) continue;

    const content = msg.content.replace(/\s+/g, " ").trim();
    if (!content) continue;

    const role = msg.role || "message";
    formatted.push(`${role}: ${content}`);
    messageCount++;
  }

  if (formatted.length > 0) {
    sections.push(`Conversation:\n${formatted.join("\n")}`);
  }

  return {
    content: sections.join("\n\n"),
    messageCount,
  };
}

// ---------------------------------------------------------------------------
// Library page content building
// ---------------------------------------------------------------------------

interface LibraryPageContentResult {
  content: string;
}

/**
 * Load a library page's full plain-text content and format it for extraction.
 *
 * Returns the title, tags, and full body content. The caller should use
 * `chunkContent` with `splitMode: 'paragraph'` for large pages.
 */
export async function buildLibraryPageContent(
  pageId: string,
): Promise<LibraryPageContentResult> {
  const rows = await db
    .select({
      title: libraryPages.title,
      plainTextContent: libraryPages.plainTextContent,
      tags: libraryPages.tags,
      oneLiner: libraryPages.oneLiner,
    })
    .from(libraryPages)
    .where(eq(libraryPages.id, pageId))
    .limit(1);

  const page = rows[0];
  if (!page) {
    log.warn(`buildLibraryPageContent: page not found id=${pageId}`);
    return { content: "" };
  }

  if (!page.plainTextContent?.trim()) {
    log.debug(`buildLibraryPageContent: empty content id=${pageId}`);
    return { content: "" };
  }

  const sections: string[] = [];
  sections.push(`Page title: ${page.title || "Untitled"}`);

  if (page.oneLiner?.trim()) {
    sections.push(`Summary: ${page.oneLiner.trim()}`);
  }

  if (page.tags?.length) {
    sections.push(`Tags: ${page.tags.join(", ")}`);
  }

  sections.push(`Content:\n${page.plainTextContent}`);

  return {
    content: sections.join("\n\n"),
  };
}

/**
 * Build a context header from session or page metadata for chunk prefixing.
 */
export function buildChunkHeader(
  title: string,
  topics?: string[],
): string {
  const parts = [`Title: ${title}`];
  if (topics?.length) {
    parts.push(`Topics: ${topics.join(", ")}`);
  }
  return parts.join("\n");
}
