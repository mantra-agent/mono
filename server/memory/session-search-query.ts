import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import {
  documentStoreDocuments,
  sessionSearchProjections,
  sessionSearchSegments,
} from "@shared/schema";
import { db } from "../db";
import type { Principal } from "../principal";
import { combineWithVisibleScope } from "../scoped-storage";
import { SESSION_SEARCH_PROJECTION_VERSION } from "./session-search-projection";

const targetChatDocumentScopeColumns = {
  scope: documentStoreDocuments.scope,
  ownerUserId: documentStoreDocuments.ownerUserId,
  accountId: documentStoreDocuments.accountId,
  vaultId: documentStoreDocuments.vaultId,
};

export function buildLiteralSubstringPattern(searchTerm: string): string {
  const escaped = searchTerm.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
  return `%${escaped}%`;
}

function eligibleSessionPredicate(cutoffIso: string): SQL {
  return and(
    eq(documentStoreDocuments.documentType, "chat"),
    sql`coalesce(${documentStoreDocuments.metadata}->>'updatedAt', ${documentStoreDocuments.updatedAt}::text, ${documentStoreDocuments.createdAt}::text) >= ${cutoffIso}`,
    sql`coalesce((${documentStoreDocuments.metadata}->>'messageCount')::int, 0) > 0`,
  )!;
}

export function buildProjectionSessionSearchQuery(
  principal: Principal,
  cutoffIso: string,
  searchTerm: string,
  maxResults: number,
) {
  const searchPattern = buildLiteralSubstringPattern(searchTerm);
  const boundedLimit = Math.max(1, Math.min(maxResults, 100));
  const canonicalUpdatedAt = sql<string>`coalesce(${documentStoreDocuments.metadata}->>'updatedAt', ${documentStoreDocuments.updatedAt}::text, ${documentStoreDocuments.createdAt}::text)`;
  const matches = db
    .selectDistinctOn([documentStoreDocuments.id], {
      docId: documentStoreDocuments.documentId,
      title: documentStoreDocuments.title,
      snippet: sessionSearchSegments.text,
      metadata: documentStoreDocuments.metadata,
      updatedAt: documentStoreDocuments.updatedAt,
      canonicalUpdatedAt,
      segmentKind: sessionSearchSegments.segmentKind,
      projectedSegmentCount: sessionSearchProjections.segmentCount,
      eligibleSegmentCount: sessionSearchProjections.eligibleSegmentCount,
      truncatedSegmentCount: sessionSearchProjections.truncatedSegmentCount,
    })
    .from(sessionSearchSegments)
    .innerJoin(
      sessionSearchProjections,
      eq(sessionSearchProjections.documentId, sessionSearchSegments.documentId),
    )
    .innerJoin(
      documentStoreDocuments,
      eq(documentStoreDocuments.id, sessionSearchSegments.documentId),
    )
    .where(
      combineWithVisibleScope(
        principal,
        targetChatDocumentScopeColumns,
        and(
          eligibleSessionPredicate(cutoffIso),
          eq(sessionSearchProjections.projectionVersion, SESSION_SEARCH_PROJECTION_VERSION),
          sql`${sessionSearchProjections.sourceUpdatedAt} = (${documentStoreDocuments.metadata}->>'updatedAt')::timestamptz`,
          sql`${sessionSearchSegments.text} ILIKE ${searchPattern} ESCAPE '!'`,
        ),
      ),
    )
    .orderBy(documentStoreDocuments.id, sessionSearchSegments.sourceOrdinal)
    .as("session_search_matches");

  return db
    .select({
      docId: matches.docId,
      title: matches.title,
      snippet: matches.snippet,
      metadata: matches.metadata,
      updatedAt: matches.updatedAt,
      segmentKind: matches.segmentKind,
      projectedSegmentCount: matches.projectedSegmentCount,
      eligibleSegmentCount: matches.eligibleSegmentCount,
      truncatedSegmentCount: matches.truncatedSegmentCount,
    })
    .from(matches)
    .orderBy(desc(matches.canonicalUpdatedAt))
    .limit(boundedLimit);
}

export async function hasIncompleteSessionSearchProjection(
  principal: Principal,
  cutoffIso: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: documentStoreDocuments.id })
    .from(documentStoreDocuments)
    .leftJoin(
      sessionSearchProjections,
      and(
        eq(sessionSearchProjections.documentId, documentStoreDocuments.id),
        eq(sessionSearchProjections.projectionVersion, SESSION_SEARCH_PROJECTION_VERSION),
        eq(sessionSearchProjections.sourceUpdatedAt, documentStoreDocuments.updatedAt),
      ),
    )
    .where(
      combineWithVisibleScope(
        principal,
        targetChatDocumentScopeColumns,
        and(
          eligibleSessionPredicate(cutoffIso),
          sql`${sessionSearchProjections.documentId} IS NULL`,
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

function legacySessionSearchCandidatePredicate(searchTerm: string): SQL {
  const searchPattern = buildLiteralSubstringPattern(searchTerm);
  return sql`${documentStoreDocuments.id} IN (
    WITH session_search_candidates AS MATERIALIZED (
      SELECT ${documentStoreDocuments.id} AS candidate_id
      FROM ${documentStoreDocuments}
      WHERE ${documentStoreDocuments.documentType} = 'chat'
        AND ${documentStoreDocuments.title} ILIKE ${searchPattern} ESCAPE '!'
      UNION
      SELECT ${documentStoreDocuments.id} AS candidate_id
      FROM ${documentStoreDocuments}
      WHERE ${documentStoreDocuments.documentType} = 'chat'
        AND ${documentStoreDocuments.content} ILIKE ${searchPattern} ESCAPE '!'
    )
    SELECT candidate_id FROM session_search_candidates
  )`;
}

/** Rollback and incomplete-backfill fallback only. */
export function buildLegacySessionSearchQuery(
  principal: Principal,
  cutoffIso: string,
  searchTerm: string,
  maxResults: number,
) {
  return db
    .select({
      docId: documentStoreDocuments.documentId,
      title: documentStoreDocuments.title,
      content: documentStoreDocuments.content,
      metadata: documentStoreDocuments.metadata,
      updatedAt: documentStoreDocuments.updatedAt,
    })
    .from(documentStoreDocuments)
    .where(
      combineWithVisibleScope(
        principal,
        targetChatDocumentScopeColumns,
        and(
          eligibleSessionPredicate(cutoffIso),
          legacySessionSearchCandidatePredicate(searchTerm),
        ),
      ),
    )
    .orderBy(
      desc(
        sql`coalesce(${documentStoreDocuments.metadata}->>'updatedAt', ${documentStoreDocuments.updatedAt}::text, ${documentStoreDocuments.createdAt}::text)`,
      ),
    )
    .limit(Math.max(1, Math.min(maxResults, 100)));
}
