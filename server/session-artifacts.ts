/**
 * Session Artifacts
 *
 * Structural, bidirectional linking between sessions and the artifacts they
 * produce. Recorded at the tool layer the moment an artifact is created.
 *
 * Write path: Tool handler succeeds → recordSessionArtifact() → INSERT ON CONFLICT DO NOTHING
 * Read paths:
 *   - getArtifactsBySession(sessionId) → scorer enrichment, session output buffer, UI
 *   - getSessionsByArtifact(type, id) → Library page linked sessions UI
 *   - resolveArtifactContent(artifacts) → scorer transcript enrichment
 */

import { db } from "./db";
import { sessionArtifacts } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { combineWithVisibleScope, ownedInsertValues } from "./scoped-storage";

const log = createLogger("SessionArtifacts");
const sessionArtifactScopeColumns = { ownerUserId: sessionArtifacts.ownerUserId, accountId: sessionArtifacts.accountId };

/**
 * Record a session-artifact link. Best-effort: failures are logged but never
 * propagated to the tool call. Idempotent via UNIQUE constraint + ON CONFLICT DO NOTHING.
 */
export async function recordSessionArtifact(
  sessionId: string | undefined | null,
  artifactType: string,
  artifactId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (!sessionId) return; // No session context (e.g., REST API call)
  try {
    await db.insert(sessionArtifacts).values({
      sessionId,
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), sessionArtifactScopeColumns),
      artifactType,
      artifactId,
      metadata: metadata ?? {},
    }).onConflictDoNothing();
  } catch (err) {
    log.warn(
      `recordSessionArtifact failed: session=${sessionId} type=${artifactType} id=${artifactId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Never throw — artifact recording must not fail the tool call
  }
}

/**
 * Get all artifacts linked to a session, ordered by creation time.
 */
export async function getArtifactsBySession(sessionId: string) {
  return db
    .select()
    .from(sessionArtifacts)
    .where(combineWithVisibleScope(getCurrentPrincipalOrSystem(), sessionArtifactScopeColumns, eq(sessionArtifacts.sessionId, sessionId)))
    .orderBy(sessionArtifacts.createdAt);
}

/**
 * Get all sessions that link to a given artifact.
 */
export async function getSessionsByArtifact(artifactType: string, artifactId: string) {
  return db
    .select()
    .from(sessionArtifacts)
    .where(
      combineWithVisibleScope(getCurrentPrincipalOrSystem(), sessionArtifactScopeColumns, and(
        eq(sessionArtifacts.artifactType, artifactType),
        eq(sessionArtifacts.artifactId, artifactId),
      )),
    )
    .orderBy(desc(sessionArtifacts.createdAt));
}

/**
 * Resolve artifact content for scorer enrichment. Fetches actual content per
 * type, formats as XML blocks, and respects a character budget.
 *
 * - library_page: Load page plainTextContent
 * - memory_entry: Load memory file content
 * - content_draft: Load from content queue
 * - file/docx: Skip (binary, not useful for text scoring)
 */
export async function resolveArtifactContent(
  artifacts: Array<{ artifactType: string; artifactId: string; metadata: unknown }>,
  charBudget = 30000,
): Promise<string | null> {
  const INDIVIDUAL_CAP = 20000;
  const blocks: string[] = [];
  let totalChars = 0;

  for (const artifact of artifacts) {
    if (totalChars >= charBudget) break;

    const remaining = charBudget - totalChars;
    if (remaining < 200) break;

    let content: string | null = null;
    const meta = (artifact.metadata || {}) as Record<string, unknown>;

    try {
      switch (artifact.artifactType) {
        case "library_page": {
          const { db: dbImport } = await import("./db");
          const { libraryPages } = await import("@shared/schema");
          const { eq: eqImport } = await import("drizzle-orm");

          // Try by slug first, then by id
          let rows = await dbImport
            .select({ plainTextContent: libraryPages.plainTextContent, title: libraryPages.title })
            .from(libraryPages)
            .where(eqImport(libraryPages.slug, artifact.artifactId))
            .limit(1);

          if (rows.length === 0) {
            rows = await dbImport
              .select({ plainTextContent: libraryPages.plainTextContent, title: libraryPages.title })
              .from(libraryPages)
              .where(eqImport(libraryPages.id, artifact.artifactId))
              .limit(1);
          }

          if (rows[0]?.plainTextContent) {
            content = rows[0].plainTextContent;
          }
          break;
        }

        case "memory_entry": {
          const { documentStorage } = await import("./memory/document-storage");
          const doc = await documentStorage.getDocumentByPath(artifact.artifactId);
          if (doc?.content) {
            content = doc.content;
          }
          break;
        }

        case "content_draft": {
          // Content queue entries are short — include them
          const { getContent } = await import("./content-storage");
          const post = await getContent(artifact.artifactId);
          if (post?.content) {
            content = post.content;
          }
          break;
        }

        // file, docx: skip binary artifacts
        default:
          break;
      }
    } catch (err) {
      log.warn(
        `resolveArtifactContent: failed to fetch ${artifact.artifactType}/${artifact.artifactId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (!content) continue;

    // Truncate individual artifacts
    const cap = Math.min(INDIVIDUAL_CAP, remaining);
    const truncated = content.length > cap
      ? content.slice(0, cap) + `\n[... truncated, ${content.length - cap} more chars ...]`
      : content;

    const title = (meta.title as string) || artifact.artifactId;
    blocks.push(
      `<artifact type="${artifact.artifactType}" id="${artifact.artifactId}" title="${title}">\n${truncated}\n</artifact>`,
    );
    totalChars += truncated.length;
  }

  if (blocks.length === 0) return null;
  return `<session_artifacts>\n${blocks.join("\n")}\n</session_artifacts>`;
}
