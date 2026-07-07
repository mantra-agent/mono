/**
 * Session Output Buffer
 *
 * Episodic memory layer: writes a compact summary of every completed session
 * to a rolling 50-row PostgreSQL table. The memory.recent_sessions context
 * section reads from this table to give every skill run direct, factual
 * knowledge of what was produced in prior sessions — without semantic search.
 *
 * Write path:  session.status transitions to saved → chat.session.status_changed event
 *              → writeSessionToBuffer(sessionId) → INSERT + prune
 *              → eventBus.publish("system.session.buffer_written")
 *              → context cache invalidation
 *
 * Read path:   context resolver calls getRecentSessions()
 *              → single indexed SELECT on a ≤50-row table
 *              → renderRecentSessionsBlock()
 */

import { db } from "./db";
import { sessionOutputBuffer } from "@shared/schema";
import { sql, desc, ne } from "drizzle-orm";
import { chatFileStorage, type FileMessage } from "./chat-file-storage";
import { eventBus } from "./event-bus";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, ownedInsertValues } from "./scoped-storage";

const log = createLogger("SessionOutputBuffer");

const BUFFER_MAX_ROWS = 50;
const sessionOutputScopeColumns = { ownerUserId: sessionOutputBuffer.ownerUserId, accountId: sessionOutputBuffer.accountId };

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract people IDs from a session's message history.
 * Library page tracking is now handled by session_artifacts; this function
 * only extracts peopleTouched from people tool calls.
 */
export function extractPeopleTouched(messages: FileMessage[]): string[] {
  const peopleTouched: string[] = [];

  for (const msg of messages) {
    if (!msg.toolCalls) continue;

    const calls = msg.toolCalls as Array<{
      name?: string;
      args?: Record<string, unknown>;
      error?: boolean;
    }>;

    for (const call of calls) {
      if (!call || call.error) continue;

      const toolName = call.name ?? "";
      const args = call.args ?? {};

      if (toolName.includes("people")) {
        if (typeof args.id === "string" && args.id) {
          peopleTouched.push(args.id);
        }
      }
    }
  }

  return [...new Set(peopleTouched)];
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Write a session's output summary to the buffer.
 * Idempotent: UNIQUE(session_id) with ON CONFLICT DO NOTHING prevents duplicates.
 * Fail-safe: any error is logged but not rethrown — session close must succeed.
 */
export async function writeSessionToBuffer(sessionId: string): Promise<void> {
  try {
    const session = await chatFileStorage.getSession(sessionId);
    if (!session) {
      log.warn(`writeSessionToBuffer: session ${sessionId} not found, skipping`);
      return;
    }

    const messages = await chatFileStorage.getMessagesBySession(sessionId);

    // Library page tracking comes from session_artifacts (structural)
    const { getArtifactsBySession } = await import("./session-artifacts");
    const artifacts = await getArtifactsBySession(sessionId);
    const linkedPages = artifacts
      .filter(a => a.artifactType === "library_page")
      .map(a => a.artifactId);

    // People tracking still uses regex extraction (different concern)
    const peopleTouched = extractPeopleTouched(messages);

    log.log(
      `writeSessionToBuffer: sessionId=${sessionId} type=${session.sessionType} ` +
        `title="${session.title ?? ""}" topics=${session.topics?.length ?? 0} ` +
        `linkedPages=${linkedPages.length} ` +
        `peopleTouched=${peopleTouched.length}`,
    );

    await db
      .insert(sessionOutputBuffer)
      .values({
        sessionId,
        ...ownedInsertValues(getCurrentPrincipalOrSystem(), sessionOutputScopeColumns),
        sessionType: session.sessionType ?? "user",
        title: session.title ?? null,
        topics: session.topics ?? [],
        pagesCreated: linkedPages,
        pagesUpdated: [],
        peopleTouched,
      })
      .onConflictDoNothing(); // idempotent — second write for same session is a no-op

    // Rolling enforcement: prune to BUFFER_MAX_ROWS after every insert.
    // Using a raw sql.raw DELETE since drizzle's notInArray doesn't support
    // subquery references to the same table in all drivers.
    await db.execute(sql`
      DELETE FROM session_output_buffer
      WHERE id NOT IN (
        SELECT id FROM session_output_buffer
        ORDER BY created_at DESC
        LIMIT ${BUFFER_MAX_ROWS}
      )
    `);

    // Emit invalidation event so context cache clears memory.recent_sessions
    eventBus.publish({
      category: "system",
      event: "system.session.buffer_written",
      payload: { sessionId },
    });

    log.log(`writeSessionToBuffer: complete sessionId=${sessionId}`);
  } catch (err: unknown) {
    // Buffer write must never block session close
    log.warn(
      `writeSessionToBuffer: failed for ${sessionId} — ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

export async function getRecentSessions(limit = BUFFER_MAX_ROWS) {
  return db
    .select()
    .from(sessionOutputBuffer)
    .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), sessionOutputScopeColumns, ne(sessionOutputBuffer.sessionType, "autonomous")))
    .orderBy(desc(sessionOutputBuffer.createdAt))
    .limit(limit);
}

type SessionBufferRow = Awaited<ReturnType<typeof getRecentSessions>>[number];

/**
 * Render the recent sessions buffer as a compact context block.
 * Groups sessions by calendar date with bold date headers, time-only per line.
 */
export function renderRecentSessionsBlock(rows: SessionBufferRow[]): string {
  if (rows.length === 0) {
    return "No recent sessions recorded yet — buffer populates as sessions close.";
  }

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const d = new Date(row.createdAt);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const parts: string[] = [
      `${time} (${row.sessionType}) "${row.title ?? "Untitled"}"`,
    ];
    if (row.topics?.length) parts.push(`topics: ${row.topics.join(", ")}`);
    if (row.pagesCreated?.length)
      parts.push(`created: ${row.pagesCreated.join(", ")}`);
    if (row.pagesUpdated?.length)
      parts.push(`updated: ${row.pagesUpdated.join(", ")}`);
    if (row.peopleTouched?.length)
      parts.push(`people: ${row.peopleTouched.join(", ")}`);
    if (!grouped.has(dateKey)) grouped.set(dateKey, []);
    grouped.get(dateKey)!.push(`- ${parts.join(" | ")}`);
  }

  const sections: string[] = [];
  for (const [date, lines] of grouped) {
    sections.push(`**${date}**\n${lines.join("\n")}`);
  }

  return (
    `_Use this section before creating any artifact — check if it already exists in a recent session._\n\n` +
    sections.join("\n\n")
  );
}
