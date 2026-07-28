import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import {
  sessionSearchProjections,
  sessionSearchSegments,
  type ToolCallInfo,
} from "@shared/schema";
import { db, withQueryAttributionAsync } from "../db";
import { redactSensitiveValue } from "../sensitive-data-redaction";

export const SESSION_SEARCH_PROJECTION_VERSION = 1;
const MAX_SEGMENTS = 256;
const MAX_SEGMENT_CHARS = 4_096;
const MAX_MESSAGE_CHARS = 3_000;
const MAX_TOOL_CHARS = 2_000;
const INSERT_BATCH_SIZE = 100;

type ProjectionAgendaItem = {
  id: string;
  title: string;
  description: string;
  status: string;
  resolution?: string;
};

type ProjectionMessage = {
  id: string;
  role: string;
  content: string;
  visibility?: string;
  compaction?: { summary?: string };
  toolCalls?: unknown;
};

export type SessionProjectionSource = {
  id: string;
  title: string;
  summary?: string | null;
  updatedAt: string;
  endReason?: string;
  agenda?: { items: ProjectionAgendaItem[] };
  messages: ProjectionMessage[];
};

export type SessionSearchSegmentInput = {
  segmentKey: string;
  segmentKind: string;
  sourceOrdinal: number;
  text: string;
};

export type SessionProjectionBuild = {
  segments: SessionSearchSegmentInput[];
  eligibleSegmentCount: number;
  truncatedSegmentCount: number;
  sourceContentHash: string;
};

function normalizeText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ").slice(0, maxChars);
}

function safeBoundedJson(value: unknown, maxChars: number): string {
  try {
    const redacted = redactSensitiveValue(value, {
      maxDepth: 5,
      maxObjectKeys: 32,
      maxArrayItems: 24,
      maxStringLength: Math.min(maxChars, 1_000),
      maxNodes: 512,
    });
    return normalizeText(JSON.stringify(redacted), maxChars);
  } catch {
    return "";
  }
}

function asToolCalls(value: unknown): ToolCallInfo[] {
  return Array.isArray(value)
    ? value.filter((item): item is ToolCallInfo => Boolean(item) && typeof item === "object")
    : [];
}

function pushSegment(
  target: SessionSearchSegmentInput[],
  segmentKey: string,
  segmentKind: string,
  sourceOrdinal: number,
  text: unknown,
  maxChars = MAX_SEGMENT_CHARS,
): void {
  const normalized = normalizeText(text, Math.min(maxChars, MAX_SEGMENT_CHARS));
  if (!normalized) return;
  target.push({ segmentKey, segmentKind, sourceOrdinal, text: normalized });
}

export function buildSessionSearchProjection(
  source: SessionProjectionSource,
  sourceContent: string,
): SessionProjectionBuild {
  const fixed: SessionSearchSegmentInput[] = [];
  pushSegment(fixed, "title", "title", 0, source.title);
  pushSegment(fixed, "outcome:summary", "outcome", 0, source.summary);
  pushSegment(fixed, "outcome:end-reason", "outcome", 1, source.endReason);

  for (const [index, item] of (source.agenda?.items ?? []).entries()) {
    const identity = item.id || String(index);
    pushSegment(
      fixed,
      `agenda:${identity}`,
      "agenda",
      index,
      [item.title, item.description, item.status].filter(Boolean).join(" — "),
    );
    pushSegment(
      fixed,
      `resolution:${identity}`,
      "resolution",
      index,
      item.resolution,
    );
  }

  const chronological: SessionSearchSegmentInput[] = [];
  for (const [messageIndex, message] of source.messages.entries()) {
    if (message.visibility === "diagnostic") continue;
    const messageIdentity = message.id || String(messageIndex);
    pushSegment(
      chronological,
      `message:${messageIdentity}`,
      message.compaction?.summary ? "compaction" : "message",
      messageIndex,
      message.compaction?.summary || message.content,
      MAX_MESSAGE_CHARS,
    );

    for (const [toolIndex, tool] of asToolCalls(message.toolCalls).entries()) {
      const toolIdentity = tool.toolCallId || String(toolIndex);
      const label = normalizeText(tool.toolName, 120);
      const input = safeBoundedJson(tool.arguments, MAX_TOOL_CHARS);
      const result = safeBoundedJson(tool.result ?? tool.output ?? tool.error, MAX_TOOL_CHARS);
      pushSegment(
        chronological,
        `tool:${messageIdentity}:${toolIdentity}`,
        "tool",
        messageIndex,
        [label, input, result].filter(Boolean).join(" — "),
        MAX_TOOL_CHARS,
      );
    }
  }

  const eligibleSegmentCount = fixed.length + chronological.length;
  const remaining = Math.max(0, MAX_SEGMENTS - fixed.length);
  const selectedChronological = chronological.slice(-remaining);
  const segments = [...fixed.slice(0, MAX_SEGMENTS), ...selectedChronological].slice(0, MAX_SEGMENTS);
  return {
    segments,
    eligibleSegmentCount,
    truncatedSegmentCount: Math.max(0, eligibleSegmentCount - segments.length),
    sourceContentHash: createHash("sha256").update(sourceContent).digest("hex"),
  };
}

export async function replaceSessionSearchProjection(input: {
  documentId: number;
  source: SessionProjectionSource;
  sourceContent: string;
  sourceUpdatedAt: Date;
}): Promise<SessionProjectionBuild> {
  const projection = buildSessionSearchProjection(input.source, input.sourceContent);
  await withQueryAttributionAsync("document-write", async () => {
    await db
      .delete(sessionSearchSegments)
      .where(eq(sessionSearchSegments.documentId, input.documentId));

    for (let index = 0; index < projection.segments.length; index += INSERT_BATCH_SIZE) {
      const batch = projection.segments.slice(index, index + INSERT_BATCH_SIZE);
      if (batch.length === 0) continue;
      await db.insert(sessionSearchSegments).values(
        batch.map((segment) => ({ documentId: input.documentId, ...segment })),
      );
    }

    await db
      .insert(sessionSearchProjections)
      .values({
        documentId: input.documentId,
        projectionVersion: SESSION_SEARCH_PROJECTION_VERSION,
        sourceUpdatedAt: input.sourceUpdatedAt,
        sourceContentHash: projection.sourceContentHash,
        segmentCount: projection.segments.length,
        eligibleSegmentCount: projection.eligibleSegmentCount,
        truncatedSegmentCount: projection.truncatedSegmentCount,
        projectedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: sessionSearchProjections.documentId,
        set: {
          projectionVersion: SESSION_SEARCH_PROJECTION_VERSION,
          sourceUpdatedAt: input.sourceUpdatedAt,
          sourceContentHash: projection.sourceContentHash,
          segmentCount: projection.segments.length,
          eligibleSegmentCount: projection.eligibleSegmentCount,
          truncatedSegmentCount: projection.truncatedSegmentCount,
          projectedAt: new Date(),
        },
      });
  }, "session-search-projection-replace");
  return projection;
}

export async function sessionProjectionMatchesSource(input: {
  documentId: number;
  sourceUpdatedAt: Date;
  sourceContentHash: string;
}): Promise<boolean> {
  const [projection] = await db
    .select({ documentId: sessionSearchProjections.documentId })
    .from(sessionSearchProjections)
    .where(
      and(
        eq(sessionSearchProjections.documentId, input.documentId),
        eq(sessionSearchProjections.projectionVersion, SESSION_SEARCH_PROJECTION_VERSION),
        eq(sessionSearchProjections.sourceUpdatedAt, input.sourceUpdatedAt),
        eq(sessionSearchProjections.sourceContentHash, input.sourceContentHash),
      ),
    )
    .limit(1);
  return Boolean(projection);
}
