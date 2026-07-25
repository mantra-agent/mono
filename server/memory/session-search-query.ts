import { and, desc, sql, type SQL } from "drizzle-orm";
import { documentStoreDocuments } from "@shared/schema";
import { db } from "../db";
import type { Principal } from "../principal";
import { combineWithVisibleScope } from "../scoped-storage";

const targetChatDocumentScopeColumns = {
  scope: documentStoreDocuments.scope,
  ownerUserId: documentStoreDocuments.ownerUserId,
  accountId: documentStoreDocuments.accountId,
  vaultId: documentStoreDocuments.vaultId,
};

function sessionSearchCandidatePredicate(searchPattern: string): SQL {
  return sql`${documentStoreDocuments.id} IN (
    WITH session_search_candidates AS MATERIALIZED (
      SELECT ${documentStoreDocuments.id} AS candidate_id
      FROM ${documentStoreDocuments}
      WHERE ${documentStoreDocuments.documentType} = 'chat'
        AND ${documentStoreDocuments.title} ILIKE ${searchPattern}
      UNION
      SELECT ${documentStoreDocuments.id} AS candidate_id
      FROM ${documentStoreDocuments}
      WHERE ${documentStoreDocuments.documentType} = 'chat'
        AND ${documentStoreDocuments.content} ILIKE ${searchPattern}
    )
    SELECT candidate_id FROM session_search_candidates
  )`;
}

export function buildTargetSessionSearchQuery(
  principal: Principal,
  cutoffIso: string,
  searchPattern: string,
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
          sql`${documentStoreDocuments.documentType} = 'chat'`,
          sql`coalesce(${documentStoreDocuments.metadata}->>'updatedAt', ${documentStoreDocuments.updatedAt}::text, ${documentStoreDocuments.createdAt}::text) >= ${cutoffIso}`,
          sql`coalesce((${documentStoreDocuments.metadata}->>'messageCount')::int, 0) > 0`,
          sessionSearchCandidatePredicate(searchPattern),
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
