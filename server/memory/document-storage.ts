import { db, withQueryAttributionAsync } from "../db";
import {
  documentStoreDocuments,
  type DocumentStoreDocument,
  type DocType,
} from "@shared/schema";
import { eq, and, like, desc, inArray, sql, type SQL } from "drizzle-orm";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import { createLogger } from "../log";

const VALID_METADATA_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const DOCUMENT_READ_BATCH_SIZE = 500;
const log = createLogger("DocStorage");

function assertSafeFieldName(field: string): void {
  if (!VALID_METADATA_FIELD_RE.test(field)) {
    throw new Error(`Invalid metadata field name: "${field}"`);
  }
}

export interface WorkspaceDocCompat {
  id: number;
  documentStoreId: number;
  docType: string;
  docId: string;
  path: string;
  title: string | null;
  content: string;
  metadata: unknown;
  vaultId: string | null;
  embedding: number[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentVaultMovePatch {
  title?: string | null;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface InterruptedChatRecoveryCandidate {
  docId: string;
  ownerUserId: string;
  accountId: string;
  vaultId: string | null;
  runtimeOwner: string | null;
}

function targetToDoc(entry: DocumentStoreDocument): WorkspaceDocCompat {
  return {
    id: entry.sourceMemoryEntryId ?? entry.id,
    documentStoreId: entry.id,
    docType: entry.documentType,
    docId: entry.documentId,
    path: entry.path || "",
    title: entry.title || null,
    content: entry.content,
    metadata: entry.metadata,
    vaultId: entry.vaultId ?? null,
    embedding: null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function chunkDocumentIds(documentIds: string[]): string[][] {
  const uniqueIds = Array.from(new Set(documentIds.filter(Boolean)));
  const batches: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += DOCUMENT_READ_BATCH_SIZE) {
    batches.push(uniqueIds.slice(index, index + DOCUMENT_READ_BATCH_SIZE));
  }
  return batches;
}

const documentScopeColumns = {
  scope: documentStoreDocuments.scope,
  ownerUserId: documentStoreDocuments.ownerUserId,
  accountId: documentStoreDocuments.accountId,
  vaultId: documentStoreDocuments.vaultId,
};

export class DocumentStorage {
  async upsertDocument(
    docType: DocType,
    docId: string,
    path: string,
    title: string | null,
    content: string,
    metadata: Record<string, unknown> = {},
    timestamps?: { createdAt?: Date; updatedAt?: Date },
    noReturn = false,
  ): Promise<WorkspaceDocCompat> {
    const now = new Date();
    const principal = getCurrentPrincipalOrSystem();
    const ownerValues = ownedInsertValues(principal, documentScopeColumns);
    if (!ownerValues.ownerUserId || !ownerValues.accountId) {
      throw new Error(
        `Document writes require an explicit user and account owner: ${docType}/${docId}`,
      );
    }
    const createdAt = timestamps?.createdAt ?? now;
    const updatedAt = timestamps?.updatedAt ?? now;
    const query = db
      .insert(documentStoreDocuments)
      .values({
        documentType: docType,
        documentId: docId,
        sourceId: docId,
        path,
        title,
        content,
        metadata,
        tags: [],
        migrationKey: "document_store_independent_v1",
        migratedAt: now,
        ...ownerValues,
        createdByUserId: principal.userId ?? undefined,
        updatedByUserId: principal.userId ?? undefined,
        createdAt,
        updatedAt,
      } as typeof documentStoreDocuments.$inferInsert)
      .onConflictDoUpdate({
        target: [
          documentStoreDocuments.scope,
          documentStoreDocuments.ownerUserId,
          documentStoreDocuments.accountId,
          documentStoreDocuments.documentType,
          documentStoreDocuments.documentId,
        ],
        set: {
          sourceId: docId,
          path,
          title,
          content,
          metadata,
          updatedByUserId: principal.userId ?? undefined,
          updatedAt,
          ...(timestamps?.createdAt ? { createdAt: timestamps.createdAt } : {}),
          sourceContentHash: null,
          sourceMetadataHash: null,
          sourceIdentityHash: null,
        },
      });

    if (noReturn) {
      await withQueryAttributionAsync("document-write", () => query, "document-upsert");
      log.verbose(() => `upsertDocument docType=${docType} docId=${docId} (no-return)`);
      return {
        id: 0,
        documentStoreId: 0,
        docType,
        docId,
        path,
        title,
        content,
        metadata,
        vaultId: principal.activeVaultId ?? null,
        embedding: null,
        createdAt,
        updatedAt,
      };
    }

    const [result] = await withQueryAttributionAsync(
      "document-write",
      () => query.returning(),
      "document-upsert",
    );
    if (!result) throw new Error(`Document upsert returned no row: ${docType}/${docId}`);
    log.verbose(() => `upsertDocument docType=${docType} docId=${docId} id=${result.id}`);
    return targetToDoc(result);
  }

  async getDocument(docType: DocType, docId: string): Promise<WorkspaceDocCompat | null> {
    const rows = await db
      .select()
      .from(documentStoreDocuments)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          documentScopeColumns,
          and(
            eq(documentStoreDocuments.documentType, docType),
            eq(documentStoreDocuments.documentId, docId),
          ),
        ),
      )
      .limit(1);
    log.verbose(() => `getDocument docType=${docType} docId=${docId} found=${rows.length > 0}`);
    return rows[0] ? targetToDoc(rows[0]) : null;
  }

  async getDocuments(docType: DocType, documentIds: string[]): Promise<WorkspaceDocCompat[]> {
    const batches = chunkDocumentIds(documentIds);
    if (batches.length === 0) return [];
    const principal = getCurrentPrincipalOrSystem();
    const documents: WorkspaceDocCompat[] = [];
    for (const batch of batches) {
      const rows = await db
        .select()
        .from(documentStoreDocuments)
        .where(
          combineWithVisibleScope(
            principal,
            documentScopeColumns,
            and(
              eq(documentStoreDocuments.documentType, docType),
              inArray(documentStoreDocuments.documentId, batch),
            ),
          ),
        );
      documents.push(...rows.map(targetToDoc));
    }
    log.verbose(() => `getDocuments docType=${docType} requested=${documentIds.length} found=${documents.length}`);
    return documents;
  }

  async getDocumentsByType(
    docType: DocType,
    filters?: Record<string, unknown>,
  ): Promise<WorkspaceDocCompat[]> {
    const conditions = [eq(documentStoreDocuments.documentType, docType)];
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        assertSafeFieldName(key);
        conditions.push(
          sql`${documentStoreDocuments.metadata}->>${sql.raw(`'${key}'`)} = ${String(value)}`,
        );
      }
    }
    const rows = await db
      .select()
      .from(documentStoreDocuments)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          documentScopeColumns,
          and(...conditions),
        ),
      )
      .orderBy(desc(documentStoreDocuments.updatedAt));
    log.verbose(() => `getDocumentsByType docType=${docType} count=${rows.length}`);
    return rows.map(targetToDoc);
  }

  async getDocumentByPath(path: string): Promise<WorkspaceDocCompat | null> {
    const rows = await db
      .select()
      .from(documentStoreDocuments)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          documentScopeColumns,
          eq(documentStoreDocuments.path, path),
        ),
      )
      .limit(1);
    log.verbose(() => `getDocumentByPath path=${path} found=${rows.length > 0}`);
    return rows[0] ? targetToDoc(rows[0]) : null;
  }

  async listDirectory(dirPath: string): Promise<WorkspaceDocCompat[]> {
    const root = !dirPath || dirPath === "/";
    const prefix = root ? null : (dirPath.endsWith("/") ? dirPath : `${dirPath}/`);
    const rows = await db
      .select()
      .from(documentStoreDocuments)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          documentScopeColumns,
          prefix ? like(documentStoreDocuments.path, `${prefix}%`) : sql`TRUE`,
        ),
      )
      .orderBy(documentStoreDocuments.path);
    log.debug(`listDirectory path=${dirPath || "/"} count=${rows.length}`);
    return rows.map(targetToDoc);
  }

  async searchText(
    query: string,
    docType?: DocType,
    limit = 20,
  ): Promise<WorkspaceDocCompat[]> {
    const tsQuery = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.replace(/[^a-zA-Z0-9]/g, ""))
      .filter(Boolean)
      .join(" & ");
    if (!tsQuery) return [];

    const conditions: SQL[] = [
      sql`to_tsvector('english', coalesce(${documentStoreDocuments.title}, '') || ' ' || ${documentStoreDocuments.content}) @@ to_tsquery('english', ${tsQuery})`,
    ];
    if (docType) conditions.push(eq(documentStoreDocuments.documentType, docType));
    const rows = await db
      .select()
      .from(documentStoreDocuments)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          documentScopeColumns,
          and(...conditions),
        ),
      )
      .orderBy(
        sql`ts_rank(to_tsvector('english', coalesce(${documentStoreDocuments.title}, '') || ' ' || ${documentStoreDocuments.content}), to_tsquery('english', ${tsQuery})) DESC`,
      )
      .limit(limit);
    return rows.map(targetToDoc);
  }

  async searchSemantic(
    _queryEmbedding: number[],
    _limit = 10,
  ): Promise<(WorkspaceDocCompat & { similarity: number })[]> {
    throw new Error("Semantic workspace-document search is unavailable for the document store");
  }

  async deleteDocument(docType: DocType, docId: string): Promise<boolean> {
    const result = await db
      .delete(documentStoreDocuments)
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          documentScopeColumns,
          and(
            eq(documentStoreDocuments.documentType, docType),
            eq(documentStoreDocuments.documentId, docId),
          ),
        ),
      )
      .returning({ id: documentStoreDocuments.id });
    log.debug(`deleteDocument docType=${docType} docId=${docId} deleted=${result.length > 0}`);
    return result.length > 0;
  }

  async patchDocumentMetadata(
    docType: DocType,
    docId: string,
    metadataPatch: Record<string, unknown>,
  ): Promise<WorkspaceDocCompat | null> {
    const principal = getCurrentPrincipalOrSystem();
    const metadataJson = JSON.stringify(metadataPatch);
    const rows = await db
      .update(documentStoreDocuments)
      .set({
        metadata: sql`COALESCE(${documentStoreDocuments.metadata}, '{}'::jsonb) || ${metadataJson}::jsonb`,
        updatedAt: new Date(),
        updatedByUserId: principal.userId ?? undefined,
        sourceContentHash: null,
        sourceMetadataHash: null,
        sourceIdentityHash: null,
      })
      .where(
        combineWithWritableScope(
          principal,
          documentScopeColumns,
          and(
            eq(documentStoreDocuments.documentType, docType),
            eq(documentStoreDocuments.documentId, docId),
          ),
        ),
      )
      .returning();
    log.debug(`patchDocumentMetadata docType=${docType} docId=${docId} updated=${rows.length > 0}`);
    return rows[0] ? targetToDoc(rows[0]) : null;
  }

  async updateDocument(
    docType: DocType,
    docId: string,
    updates: Partial<Pick<WorkspaceDocCompat, "title" | "content" | "metadata" | "path">>,
  ): Promise<WorkspaceDocCompat | null> {
    const principal = getCurrentPrincipalOrSystem();
    const setData: Record<string, unknown> = {
      updatedAt: new Date(),
      updatedByUserId: principal.userId ?? undefined,
      sourceContentHash: null,
      sourceMetadataHash: null,
      sourceIdentityHash: null,
    };
    if (updates.title !== undefined) setData.title = updates.title;
    if (updates.content !== undefined) setData.content = updates.content;
    if (updates.metadata !== undefined) setData.metadata = updates.metadata;
    if (updates.path !== undefined) setData.path = updates.path;
    const rows = await db
      .update(documentStoreDocuments)
      .set(setData)
      .where(
        combineWithWritableScope(
          principal,
          documentScopeColumns,
          and(
            eq(documentStoreDocuments.documentType, docType),
            eq(documentStoreDocuments.documentId, docId),
          ),
        ),
      )
      .returning();
    log.debug(`updateDocument docType=${docType} docId=${docId} updated=${rows.length > 0}`);
    return rows[0] ? targetToDoc(rows[0]) : null;
  }

  async getMaxNumericId(docType: DocType): Promise<number> {
    const rows = await db.execute(sql`
      SELECT COALESCE(MAX((metadata->>'id')::int), 0)::int AS max_id
      FROM document_store_documents
      WHERE ${combineWithVisibleScope(getCurrentPrincipalOrSystem(), documentScopeColumns, sql`TRUE`)}
        AND document_type = ${docType}
        AND metadata->>'id' IS NOT NULL
    `);
    return Number(((rows.rows ?? rows) as Array<{ max_id: number }>)[0]?.max_id ?? 0);
  }

  async aggregateMetadataByDate(
    docType: DocType,
    dateStr: string,
    sumFields: string[],
    countAlias = "count",
  ): Promise<{ count: number; sums: Record<string, number> }> {
    assertSafeFieldName(countAlias);
    sumFields.forEach(assertSafeFieldName);
    const sumExpressions = sumFields.map(
      (field) =>
        sql`COALESCE(SUM((${documentStoreDocuments.metadata}->>${sql.raw(`'${field}'`)})::numeric), 0) AS ${sql.raw(field)}`,
    );
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS ${sql.raw(countAlias)}, ${sql.join(sumExpressions, sql`, `)}
      FROM document_store_documents
      WHERE ${combineWithVisibleScope(getCurrentPrincipalOrSystem(), documentScopeColumns, sql`TRUE`)}
        AND document_type = ${docType}
        AND metadata->>'timestamp' LIKE ${dateStr + "%"}
    `);
    const row = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0];
    return {
      count: Number(row?.[countAlias] ?? 0),
      sums: Object.fromEntries(sumFields.map((field) => [field, Number(row?.[field] ?? 0)])),
    };
  }

  async moveDocumentToVault(
    docType: DocType,
    docId: string,
    destinationVaultId: string,
    patch: DocumentVaultMovePatch = {},
  ): Promise<WorkspaceDocCompat> {
    const principal = getCurrentPrincipalOrSystem();
    if (!principal.userId || !principal.accountId) {
      throw new Error(`Document Vault moves require an explicit user and account owner: ${docType}/${docId}`);
    }
    const [result] = await db
      .update(documentStoreDocuments)
      .set({
        vaultId: destinationVaultId,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        updatedByUserId: principal.userId,
        updatedAt: new Date(),
      })
      .where(
        combineWithWritableScope(
          principal,
          documentScopeColumns,
          and(
            eq(documentStoreDocuments.documentType, docType),
            eq(documentStoreDocuments.documentId, docId),
          ),
        ),
      )
      .returning();
    if (!result) throw new Error(`Document not found or not writable: ${docType}/${docId}`);
    return targetToDoc(result);
  }

  async countByType(docType: DocType, sinceTimestamp?: string): Promise<number> {
    const conditions = [
      sql`document_type = ${docType}`,
      combineWithVisibleScope(getCurrentPrincipalOrSystem(), documentScopeColumns, sql`TRUE`),
    ];
    if (sinceTimestamp) conditions.push(sql`metadata->>'timestamp' >= ${sinceTimestamp}`);
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM document_store_documents
      WHERE ${sql.join(conditions, sql` AND `)}
    `);
    return Number(((rows.rows ?? rows) as Array<{ cnt: number }>)[0]?.cnt ?? 0);
  }

  async discoverInterruptedChatRecoveryCandidates(
    limit = 100,
  ): Promise<InterruptedChatRecoveryCandidate[]> {
    const principal = getCurrentPrincipalOrSystem();
    if (principal.actorType !== "system" || principal.jobName !== "chat-recovery") {
      throw Object.assign(
        new Error("Interrupted chat recovery discovery requires the named chat-recovery system principal"),
        { status: 403 },
      );
    }
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = await db
      .select({
        docId: documentStoreDocuments.documentId,
        ownerUserId: documentStoreDocuments.ownerUserId,
        accountId: documentStoreDocuments.accountId,
        vaultId: documentStoreDocuments.vaultId,
        runtimeOwner: sql<string | null>`${documentStoreDocuments.metadata}->>'activeRuntimeOwner'`,
      })
      .from(documentStoreDocuments)
      .where(
        and(
          eq(documentStoreDocuments.documentType, "chat"),
          eq(documentStoreDocuments.scope, "user"),
          sql`${documentStoreDocuments.metadata}->>'status' = 'streaming'`,
          sql`COALESCE(${documentStoreDocuments.metadata}->>'type', 'text') = 'text'`,
          sql`COALESCE(${documentStoreDocuments.metadata}->>'sessionType', 'user') = 'user'`,
          sql`${documentStoreDocuments.ownerUserId} IS NOT NULL`,
          sql`${documentStoreDocuments.accountId} IS NOT NULL`,
        ),
      )
      .orderBy(documentStoreDocuments.updatedAt)
      .limit(boundedLimit);
    log.info("interrupted chat recovery candidates discovered", {
      count: rows.length,
      limit: boundedLimit,
      jobName: principal.jobName,
    });
    return rows.map((row) => ({
      docId: row.docId,
      ownerUserId: row.ownerUserId!,
      accountId: row.accountId!,
      vaultId: row.vaultId,
      runtimeOwner: row.runtimeOwner,
    }));
  }

  async getDocumentsMetadataOnly(
    docType: DocType,
    sinceTimestamp?: string,
  ): Promise<Array<{
    id: number;
    docId: string;
    title: string | null;
    createdAt: string | null;
    metadata: Record<string, unknown>;
    ownerUserId: string | null;
    accountId: string | null;
    vaultId: string | null;
  }>> {
    const conditions = [
      sql`document_type = ${docType}`,
      combineWithVisibleScope(getCurrentPrincipalOrSystem(), documentScopeColumns, sql`TRUE`),
    ];
    if (sinceTimestamp) conditions.push(sql`metadata->>'timestamp' >= ${sinceTimestamp}`);
    const rows = await db.execute(sql`
      SELECT source_memory_entry_id, id, document_id, title, created_at, metadata,
             owner_user_id, account_id, vault_id
      FROM document_store_documents
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY updated_at DESC
    `);
    return ((rows.rows ?? rows) as Array<{
      source_memory_entry_id: number | null;
      id: number;
      document_id: string;
      title: string | null;
      created_at: string | Date | null;
      metadata: Record<string, unknown>;
      owner_user_id: string | null;
      account_id: string | null;
      vault_id: string | null;
    }>).map((row) => ({
      id: row.source_memory_entry_id ?? row.id,
      docId: row.document_id,
      title: row.title,
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at
          ? String(row.created_at)
          : null,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata || {},
      ownerUserId: row.owner_user_id,
      accountId: row.account_id,
      vaultId: row.vault_id,
    }));
  }

  async aggregateMetadataGroupBy(
    docType: DocType,
    groupByField: string,
    sumFields: string[],
    sinceTimestamp?: string,
  ): Promise<Array<{ groupKey: string; count: number; sums: Record<string, number> }>> {
    assertSafeFieldName(groupByField);
    sumFields.forEach(assertSafeFieldName);
    const conditions = [
      sql`document_type = ${docType}`,
      combineWithVisibleScope(getCurrentPrincipalOrSystem(), documentScopeColumns, sql`TRUE`),
    ];
    if (sinceTimestamp) conditions.push(sql`metadata->>'timestamp' >= ${sinceTimestamp}`);
    const sumExpressions = sumFields.map(
      (field) =>
        sql`COALESCE(SUM((metadata->>${sql.raw(`'${field}'`)})::numeric), 0) AS ${sql.raw(`sum_${field}`)}`,
    );
    const rows = await db.execute(sql`
      SELECT metadata->>${sql.raw(`'${groupByField}'`)} AS group_key,
             COUNT(*)::int AS cnt, ${sql.join(sumExpressions, sql`, `)}
      FROM document_store_documents
      WHERE ${sql.join(conditions, sql` AND `)}
      GROUP BY metadata->>${sql.raw(`'${groupByField}'`)}
    `);
    return ((rows.rows ?? rows) as Array<Record<string, unknown>>).map((row) => ({
      groupKey: String(row.group_key ?? ""),
      count: Number(row.cnt ?? 0),
      sums: Object.fromEntries(
        sumFields.map((field) => [field, Number(row[`sum_${field}`] ?? 0)]),
      ),
    }));
  }

  async aggregateSummary(
    docType: DocType,
    sumFields: string[],
    sinceTimestamp?: string,
  ): Promise<{ count: number; sums: Record<string, number> }> {
    sumFields.forEach(assertSafeFieldName);
    const conditions = [
      sql`document_type = ${docType}`,
      combineWithVisibleScope(getCurrentPrincipalOrSystem(), documentScopeColumns, sql`TRUE`),
    ];
    if (sinceTimestamp) conditions.push(sql`metadata->>'timestamp' >= ${sinceTimestamp}`);
    const sumExpressions = sumFields.map(
      (field) =>
        sql`COALESCE(SUM((metadata->>${sql.raw(`'${field}'`)})::numeric), 0) AS ${sql.raw(`"${field}"`)}`,
    );
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt, ${sql.join(sumExpressions, sql`, `)}
      FROM document_store_documents
      WHERE ${sql.join(conditions, sql` AND `)}
    `);
    const row = ((rows.rows ?? rows) as Array<Record<string, unknown>>)[0];
    return {
      count: Number(row?.cnt ?? 0),
      sums: Object.fromEntries(sumFields.map((field) => [field, Number(row?.[field] ?? 0)])),
    };
  }

  async getStats(): Promise<Record<string, number>> {
    const rows = await db.execute(sql`
      SELECT document_type AS doc_type, COUNT(*)::int AS count
      FROM document_store_documents
      WHERE ${combineWithVisibleScope(getCurrentPrincipalOrSystem(), documentScopeColumns, sql`TRUE`)}
      GROUP BY document_type
      ORDER BY document_type
    `);
    const stats: Record<string, number> = {};
    for (const row of (rows.rows ?? rows) as Array<{ doc_type: string; count: number }>) {
      stats[row.doc_type] = Number(row.count);
    }
    return stats;
  }
}

export const documentStorage = new DocumentStorage();
