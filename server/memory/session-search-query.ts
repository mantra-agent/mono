import { and, desc, eq, sql } from "drizzle-orm";
import {
  documentStoreDocuments,
  sessionSearchSegments,
  SESSION_SEARCH_PROJECTION_VERSION,
} from "@shared/schema";
import { db } from "../db";
import type { Principal } from "../principal";
import { combineWithVisibleScope } from "../scoped-storage";

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

function legacySessionSearchCandidatePredicate(searchTerm: string) {
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

export function buildLegacySessionSearchQuery(
  principal: Principal,
  cutoffIso: string,
  searchTerm: string,
  maxResults: number,
) {
  const updatedAt = sql`coalesce(${documentStoreDocuments.metadata}->>'updatedAt', ${documentStoreDocuments.updatedAt}::text, ${documentStoreDocuments.createdAt}::text)`;
  return db
    .select({
      docId: documentStoreDocuments.documentId,
      title: documentStoreDocuments.title,
      content: documentStoreDocuments.content,
      metadata: documentStoreDocuments.metadata,
      updatedAt: documentStoreDocuments.updatedAt,
    })
    .from(documentStoreDocuments)
    .where(combineWithVisibleScope(
      principal,
      targetChatDocumentScopeColumns,
      and(
        sql`${documentStoreDocuments.documentType} = 'chat'`,
        sql`${updatedAt} >= ${cutoffIso}`,
        sql`coalesce((${documentStoreDocuments.metadata}->>'messageCount')::int, 0) > 0`,
        legacySessionSearchCandidatePredicate(searchTerm),
      ),
    ))
    .orderBy(desc(updatedAt))
    .limit(Math.max(1, Math.min(maxResults, 100)));
}

export function buildTargetSessionSearchQuery(
  principal: Principal,
  cutoffIso: string,
  searchTerm: string,
  maxResults: number,
) {
  const searchPattern = buildLiteralSubstringPattern(searchTerm);
  const updatedAt = sql`coalesce(${documentStoreDocuments.metadata}->>'updatedAt', ${documentStoreDocuments.updatedAt}::text, ${documentStoreDocuments.createdAt}::text)`;
  const matchOffset = sql`greatest(strpos(lower(${sessionSearchSegments.content}), lower(${searchTerm})) - 80, 1)`;

  return db
    .select({
      docId: documentStoreDocuments.documentId,
      title: documentStoreDocuments.title,
      metadata: documentStoreDocuments.metadata,
      updatedAt: documentStoreDocuments.updatedAt,
      matchSnippet: sql<string>`min(substring(${sessionSearchSegments.content} from ${matchOffset} for 280))`,
    })
    .from(sessionSearchSegments)
    .innerJoin(
      documentStoreDocuments,
      eq(sessionSearchSegments.documentStoreId, documentStoreDocuments.id),
    )
    .where(
      combineWithVisibleScope(
        principal,
        targetChatDocumentScopeColumns,
        and(
          sql`${documentStoreDocuments.documentType} = 'chat'`,
          sql`${updatedAt} >= ${cutoffIso}`,
          sql`coalesce((${documentStoreDocuments.metadata}->>'messageCount')::int, 0) > 0`,
          eq(sessionSearchSegments.projectionVersion, SESSION_SEARCH_PROJECTION_VERSION),
          sql`${sessionSearchSegments.content} ILIKE ${searchPattern} ESCAPE '!'`,
        ),
      ),
    )
    .groupBy(documentStoreDocuments.id)
    .orderBy(desc(updatedAt))
    .limit(Math.max(1, Math.min(maxResults, 100)));
}
