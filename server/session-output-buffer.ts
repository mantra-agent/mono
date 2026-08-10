/**
 * Session Output Buffer
 *
 * Bounded REM seed layer: writes a compact summary of every completed session
 * to a rolling 50-row PostgreSQL table. HISTORY owns bootstrap chronology;
 * this table remains source material for dream generation only.
 *
 * Write path:  session.status transitions to saved → chat.session.status_changed event
 *              → writeSessionToBuffer(sessionId) → INSERT + prune
 *
 * Read path:   REM dream engine calls getRecentSessions()
 *              → single indexed SELECT on a ≤50-row table
 */

import { db } from "./db";
import { sessionOutputBuffer } from "@shared/schema";
import { sql, desc, ne } from "drizzle-orm";
import { chatFileStorage, type FileMessage } from "./chat-file-storage";
import { createLogger } from "./log";
import { requireCurrentUserPrincipal } from "./principal-context";
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
        ...ownedInsertValues(requireCurrentUserPrincipal(), sessionOutputScopeColumns),
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
    .where(combineWithVisibleScope(requireCurrentUserPrincipal(), sessionOutputScopeColumns, ne(sessionOutputBuffer.sessionType, "autonomous")))
    .orderBy(desc(sessionOutputBuffer.createdAt))
    .limit(limit);
}

