import { db, withQueryAttributionAsync } from "../db";
import {
  memoryEntries,
  documentStoreDocuments,
  type MemoryEntry,
  type DocumentStoreDocument,
  type MemoryLayer,
  type MemorySource,
  type DocType,
} from "@shared/schema";
import { eq, and, like, desc, sql, type SQL } from "drizzle-orm";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import { createLogger } from "../log";
import {
  DOCUMENT_STORE_CUTOVER_KEY,
  documentStoreIndependentWritesEnabled,
} from "./document-store-cutover";
import {
  executeSemanticSearch,
  mapRawRowToEntry,
  memoryEntryLightColumns,
  memoryStorage,
  wrapLightEntry,
} from "./memory-storage";

const VALID_METADATA_FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

function assertSafeFieldName(field: string): void {
  if (!VALID_METADATA_FIELD_RE.test(field)) {
    throw new Error(`Invalid metadata field name: "${field}"`);
  }
}

export interface WorkspaceDocCompat {
  id: number;
  docType: string;
  docId: string;
  path: string;
  title: string | null;
  content: string;
  metadata: unknown;
  embedding: number[] | null;
  createdAt: Date;
  updatedAt: Date;
}

function entryToDoc(entry: MemoryEntry): WorkspaceDocCompat {
  return {
    id: entry.id,
    docType: entry.source,
    docId: entry.sourceId || "",
    path: entry.path || "",
    title: entry.title || null,
    content: entry.content,
    metadata: entry.metadata,
    embedding: null,
    createdAt: entry.createdAt,
    updatedAt: entry.processedAt || entry.createdAt,
  };
}

function targetToDoc(entry: DocumentStoreDocument): WorkspaceDocCompat {
  return {
    id: entry.sourceMemoryEntryId ?? entry.id,
    docType: entry.documentType,
    docId: entry.documentId,
    path: entry.path || "",
    title: entry.title || null,
    content: entry.content,
    metadata: entry.metadata,
    embedding: null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export async function targetReadsEnabled(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT read_enabled
    FROM document_store_cutover_state
    WHERE cutover_key = ${DOCUMENT_STORE_CUTOVER_KEY}
    LIMIT 1
  `);
  const row = ((result.rows ?? result) as Array<{ read_enabled: boolean }>)[0];
  if (!row) {
    throw new Error("Document-store cutover state is missing after startup readiness");
  }
  if (row.read_enabled !== true) {
    throw new Error("Document-store cutover is not reconciled; legacy read fallback is disabled");
  }
  return true;
}

const WORKSPACE_LAYER = "workspace";
const log = createLogger("DocStorage");

const memoryScopeColumns = {
  scope: memoryEntries.scope,
  ownerUserId: memoryEntries.ownerUserId,
  accountId: memoryEntries.accountId,
  vaultId: memoryEntries.vaultId,
};

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
    if (await documentStoreIndependentWritesEnabled()) {
      await targetReadsEnabled();
      const principal = getCurrentPrincipalOrSystem();
      const ownerValues = ownedInsertValues(principal, documentScopeColumns);
      if (!ownerValues.ownerUserId || !ownerValues.accountId) {
        throw new Error(
          `Independent document writes require an explicit user and account owner: ${docType}/${docId}`,
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
        log.verbose(() => `upsertDocument target docType=${docType} docId=${docId} (no-return)`);
        return {
          id: 0, docType, docId, path, title, content, metadata, embedding: null,
          createdAt, updatedAt,
        };
      }
      const [result] = await withQueryAttributionAsync(
        "document-write",
        () => query.returning(),
        "document-upsert",
      );
      if (!result) throw new Error(`Document upsert returned no row: ${docType}/${docId}`);
      log.verbose(() => `upsertDocument target docType=${docType} docId=${docId} id=${result.id}`);
      return targetToDoc(result);
    }
    const insertValues: Record<string, unknown> = {
      layer: WORKSPACE_LAYER,
      source: docType,
      sourceId: docId,
      path,
      title,
      content,
      metadata,
      tags: [],
      processedAt: timestamps?.updatedAt || now,
      ...ownedInsertValues(getCurrentPrincipalOrSystem(), memoryScopeColumns),
      createdByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
      updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
    };
    if (timestamps?.createdAt) {
      insertValues.createdAt = timestamps.createdAt;
    }

    const updateData: Record<string, unknown> = {
      path,
      title,
      content,
      metadata,
      processedAt: timestamps?.updatedAt || now,
      updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
    };
    if (timestamps?.createdAt) {
      updateData.createdAt = timestamps.createdAt;
    }

    const query = db
      .insert(memoryEntries)
      .values(insertValues as typeof memoryEntries.$inferInsert)
      .onConflictDoUpdate({
        target: [
          memoryEntries.layer,
          memoryEntries.source,
          memoryEntries.sourceId,
        ],
        set: updateData,
      });

    const trackId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let trackStart: ((id: string, dt: string, di: string) => void) | null =
      null;
    let trackEnd: ((id: string) => void) | null = null;
    try {
      const ww = require("../wedge-watchdog");
      trackStart = ww.trackDocUpsertStart;
      trackEnd = ww.trackDocUpsertEnd;
    } catch {
      /* watchdog not available */
    }
    trackStart?.(trackId, docType, docId);
    try {
      if (noReturn) {
        await query;
        const [entry] = await db
          .select({ id: memoryEntries.id })
          .from(memoryEntries)
          .where(
            combineWithVisibleScope(
              getCurrentPrincipalOrSystem(),
              memoryScopeColumns,
              and(
                eq(memoryEntries.layer, WORKSPACE_LAYER),
                eq(memoryEntries.source, docType),
                eq(memoryEntries.sourceId, docId),
              ),
            ),
          )
          .limit(1);
        if (entry) {
          await memoryStorage.addSourceRef({
            memoryId: entry.id,
            sourceType: docType,
            sourceId: docId,
            relationship: "extracted_from",
            context: "Workspace document memory source from legacy memory_entries.source/source_id",
            strength: 1,
          });
        }
        log.verbose(() => `upsertDocument docType=${docType} docId=${docId} (no-return)`);
        return {
          id: 0,
          docType,
          docId,
          path,
          title,
          content,
          metadata,
          embedding: null,
          createdAt: now,
          updatedAt: now,
        };
      }

      const [result] = await withQueryAttributionAsync(
        "memory-write",
        () => query.returning(),
        "doc-upsert",
      );
      await memoryStorage.addSourceRef({
        memoryId: result.id,
        sourceType: docType,
        sourceId: docId,
        relationship: "extracted_from",
        context: "Workspace document memory source from legacy memory_entries.source/source_id",
        strength: 1,
      });
      log.verbose(() => `upsertDocument docType=${docType} docId=${docId} id=${result.id}`);
      return entryToDoc(result);
    } finally {
      trackEnd?.(trackId);
    }
  }

  async getDocument(
    docType: DocType,
    docId: string,
  ): Promise<WorkspaceDocCompat | null> {
    if (await targetReadsEnabled()) {
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
      log.verbose(() => `getDocument target docType=${docType} docId=${docId} found=${rows.length > 0}`);
      return rows[0] ? targetToDoc(rows[0]) : null;
    }
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(
            eq(memoryEntries.layer, WORKSPACE_LAYER),
            eq(memoryEntries.source, docType),
            eq(memoryEntries.sourceId, docId),
          ),
        ),
      )
      .limit(1);
    log.verbose(() => `getDocument docType=${docType} docId=${docId} found=${rows.length > 0}`);
    return rows[0]
      ? entryToDoc(wrapLightEntry(rows[0] as Omit<MemoryEntry, "embedding">))
      : null;
  }

  async getDocumentsByType(
    docType: DocType,
    filters?: Record<string, unknown>,
  ): Promise<WorkspaceDocCompat[]> {
    if (await targetReadsEnabled()) {
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
      log.verbose(() => `getDocumentsByType target docType=${docType} count=${rows.length}`);
      return rows.map(targetToDoc);
    }
    const conditions = [
      eq(memoryEntries.layer, WORKSPACE_LAYER),
      eq(memoryEntries.source, docType),
    ];

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        assertSafeFieldName(key);
        conditions.push(
          sql`${memoryEntries.metadata}->>${sql.raw(`'${key}'`)} = ${String(value)}`,
        );
      }
    }

    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(...conditions),
        ),
      )
      .orderBy(desc(memoryEntries.processedAt));

    log.verbose(() => `getDocumentsByType docType=${docType} count=${rows.length}`);
    return rows.map((r) =>
      entryToDoc(wrapLightEntry(r as Omit<MemoryEntry, "embedding">)),
    );
  }

  async getDocumentByPath(path: string): Promise<WorkspaceDocCompat | null> {
    if (await targetReadsEnabled()) {
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
      log.verbose(() => `getDocumentByPath target path=${path} found=${rows.length > 0}`);
      return rows[0] ? targetToDoc(rows[0]) : null;
    }
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(
            eq(memoryEntries.layer, WORKSPACE_LAYER),
            eq(memoryEntries.path, path),
          ),
        ),
      )
      .limit(1);
    log.verbose(() => `getDocumentByPath path=${path} found=${rows.length > 0}`);
    return rows[0]
      ? entryToDoc(wrapLightEntry(rows[0] as Omit<MemoryEntry, "embedding">))
      : null;
  }

  async listDirectory(dirPath: string): Promise<WorkspaceDocCompat[]> {
    if (await targetReadsEnabled()) {
      const root = !dirPath || dirPath === "" || dirPath === "/";
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
      log.debug(`listDirectory target path=${dirPath || "/"} count=${rows.length}`);
      return rows.map(targetToDoc);
    }
    if (!dirPath || dirPath === "" || dirPath === "/") {
      const rows = await db
        .select(memoryEntryLightColumns)
        .from(memoryEntries)
        .where(
          combineWithVisibleScope(
            getCurrentPrincipalOrSystem(),
            memoryScopeColumns,
            eq(memoryEntries.layer, WORKSPACE_LAYER),
          ),
        )
        .orderBy(memoryEntries.path);
      log.debug(`listDirectory path=/ count=${rows.length}`);
      return rows.map((r) =>
        entryToDoc(wrapLightEntry(r as Omit<MemoryEntry, "embedding">)),
      );
    }
    const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(
            eq(memoryEntries.layer, WORKSPACE_LAYER),
            like(memoryEntries.path, `${prefix}%`),
          ),
        ),
      )
      .orderBy(memoryEntries.path);
    log.debug(`listDirectory path=${dirPath} count=${rows.length}`);
    return rows.map((r) =>
      entryToDoc(wrapLightEntry(r as Omit<MemoryEntry, "embedding">)),
    );
  }

  async searchText(
    query: string,
    docType?: DocType,
    limit: number = 20,
  ): Promise<WorkspaceDocCompat[]> {
    const tsQuery = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
      .filter(Boolean)
      .join(" & ");

    if (!tsQuery) {
      log.debug(`searchText empty query after sanitization, returning empty`);
      return [];
    }

    if (await targetReadsEnabled()) {
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

    const conditions: SQL[] = [
      eq(memoryEntries.layer, WORKSPACE_LAYER),
      sql`to_tsvector('english', coalesce(${memoryEntries.title}, '') || ' ' || ${memoryEntries.content}) @@ to_tsquery('english', ${tsQuery})`,
    ];

    if (docType) {
      conditions.push(eq(memoryEntries.source, docType));
    }

    const rows = await db
      .select(memoryEntryLightColumns)
      .from(memoryEntries)
      .where(
        combineWithVisibleScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(...conditions),
        ),
      )
      .orderBy(
        sql`ts_rank(to_tsvector('english', coalesce(${memoryEntries.title}, '') || ' ' || ${memoryEntries.content}), to_tsquery('english', ${tsQuery})) DESC`,
      )
      .limit(limit);

    log.debug(
      `searchText query="${query}" docType=${docType || "all"} results=${rows.length}`,
    );
    return rows.map((r) =>
      entryToDoc(wrapLightEntry(r as Omit<MemoryEntry, "embedding">)),
    );
  }

  async searchSemantic(
    queryEmbedding: number[],
    limit: number = 10,
  ): Promise<(WorkspaceDocCompat & { similarity: number })[]> {
    if (await targetReadsEnabled()) {
      throw new Error("Semantic workspace-document search is unavailable after stage document-store read cutover");
    }
    const results = await executeSemanticSearch(
      queryEmbedding,
      limit,
      WORKSPACE_LAYER,
    );
    log.debug(
      `searchSemantic embeddingDim=${queryEmbedding.length} limit=${limit} results=${results.length}`,
    );
    return results.map(({ row, similarity }) => ({
      ...entryToDoc(mapRawRowToEntry(row)),
      similarity,
    }));
  }

  async deleteDocument(docType: DocType, docId: string): Promise<boolean> {
    if (await documentStoreIndependentWritesEnabled()) {
      await targetReadsEnabled();
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
      log.debug(`deleteDocument target docType=${docType} docId=${docId} deleted=${result.length > 0}`);
      return result.length > 0;
    }
    const result = await db
      .delete(memoryEntries)
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(
            eq(memoryEntries.layer, WORKSPACE_LAYER),
            eq(memoryEntries.source, docType),
            eq(memoryEntries.sourceId, docId),
          ),
        ),
      )
      .returning();
    log.debug(
      `deleteDocument docType=${docType} docId=${docId} deleted=${result.length > 0}`,
    );
    return result.length > 0;
  }

  async patchDocumentMetadata(
    docType: DocType,
    docId: string,
    metadataPatch: Record<string, unknown>,
  ): Promise<WorkspaceDocCompat | null> {
    log.debug(
      `patchDocumentMetadata docType=${docType} docId=${docId} keys=${Object.keys(metadataPatch).join(",")}`,
    );
    const metadataJson = JSON.stringify(metadataPatch);
    if (await documentStoreIndependentWritesEnabled()) {
      await targetReadsEnabled();
      const rows = await db
        .update(documentStoreDocuments)
        .set({
          metadata: sql`COALESCE(${documentStoreDocuments.metadata}, '{}'::jsonb) || ${metadataJson}::jsonb`,
          updatedAt: new Date(),
          updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
          sourceContentHash: null,
          sourceMetadataHash: null,
          sourceIdentityHash: null,
        })
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
        .returning();
      log.debug(
        `patchDocumentMetadata target docType=${docType} docId=${docId} updated=${rows.length > 0}`,
      );
      return rows[0] ? targetToDoc(rows[0]) : null;
    }

    const rows = await db
      .update(memoryEntries)
      .set({
        metadata: sql`COALESCE(${memoryEntries.metadata}, '{}'::jsonb) || ${metadataJson}::jsonb`,
        processedAt: new Date(),
      })
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(
            eq(memoryEntries.layer, WORKSPACE_LAYER),
            eq(memoryEntries.source, docType),
            eq(memoryEntries.sourceId, docId),
          ),
        ),
      )
      .returning();
    log.debug(
      `patchDocumentMetadata docType=${docType} docId=${docId} updated=${rows.length > 0}`,
    );
    return rows[0] ? entryToDoc(rows[0]) : null;
  }

  async updateDocument(
    docType: DocType,
    docId: string,
    updates: Partial<
      Pick<WorkspaceDocCompat, "title" | "content" | "metadata" | "path">
    >,
  ): Promise<WorkspaceDocCompat | null> {
    log.debug(
      `updateDocument docType=${docType} docId=${docId} fields=${Object.keys(updates).join(",")}`,
    );
    if (await documentStoreIndependentWritesEnabled()) {
      await targetReadsEnabled();
      const setData: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedByUserId: getCurrentPrincipalOrSystem().userId ?? undefined,
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
            getCurrentPrincipalOrSystem(),
            documentScopeColumns,
            and(
              eq(documentStoreDocuments.documentType, docType),
              eq(documentStoreDocuments.documentId, docId),
            ),
          ),
        )
        .returning();
      log.debug(`updateDocument target docType=${docType} docId=${docId} updated=${rows.length > 0}`);
      return rows[0] ? targetToDoc(rows[0]) : null;
    }
    const setData: Record<string, unknown> = { processedAt: new Date() };
    if (updates.title !== undefined) setData.title = updates.title;
    if (updates.content !== undefined) setData.content = updates.content;
    if (updates.metadata !== undefined) setData.metadata = updates.metadata;
    if (updates.path !== undefined) setData.path = updates.path;

    const rows = await db
      .update(memoryEntries)
      .set(setData)
      .where(
        combineWithWritableScope(
          getCurrentPrincipalOrSystem(),
          memoryScopeColumns,
          and(
            eq(memoryEntries.layer, WORKSPACE_LAYER),
            eq(memoryEntries.source, docType),
            eq(memoryEntries.sourceId, docId),
          ),
        ),
      )
      .returning();
    log.debug(
      `updateDocument docType=${docType} docId=${docId} updated=${rows.length > 0}`,
    );
    return rows[0] ? entryToDoc(rows[0]) : null;
  }

  async getMaxNumericId(docType: DocType): Promise<number> {
    if (await targetReadsEnabled()) {
      const rows = await db.execute(sql`
        SELECT COALESCE(MAX((metadata->>'id')::int), 0)::int AS max_id
        FROM document_store_documents
        WHERE ${combineWithVisibleScope(getCurrentPrincipalOrSystem(), documentScopeColumns, sql`TRUE`)}
          AND document_type = ${docType}
          AND metadata->>'id' IS NOT NULL
      `);
      return Number(((rows.rows ?? rows) as Array<{ max_id: number }>)[0]?.max_id ?? 0);
    }
    const rows = await db.execute(sql`
      SELECT COALESCE(MAX((metadata->>'id')::int), 0)::int AS max_id
      FROM memory_entries
      WHERE ${combineWithVisibleScope(getCurrentPrincipalOrSystem(), memoryScopeColumns, sql`layer = ${WORKSPACE_LAYER}`)}
        AND source = ${docType}
        AND metadata->>'id' IS NOT NULL
    `);
    const result = ((rows.rows ?? rows) as { max_id: number }[])[0];
    const maxId = result?.max_id ?? 0;
    log.debug(`getMaxNumericId docType=${docType} maxId=${maxId}`);
    return maxId;
  }

  async aggregateMetadataByDate(
    docType: DocType,
    dateStr: string,
    sumFields: string[],
    countAlias: string = "count",
  ): Promise<{ count: number; sums: Record<string, number> }> {
    assertSafeFieldName(countAlias);
    sumFields.forEach(assertSafeFieldName);
    if (await targetReadsEnabled()) {
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
    const sumExpressions = sumFields.map(
      (f) =>
        sql`COALESCE(SUM((${memoryEntries.metadata}->>${sql.raw(`'${f}'`)})::numeric), 0) AS ${sql.raw(f)}`,
    );

    const rows = await db.execute(sql`
      SELECT
        COUNT(*)::int AS ${sql.raw(countAlias)},
        ${sql.join(sumExpressions, sql`, `)}
      FROM memory_entries
      WHERE ${combineWithVisibleScope(getCurrentPrincipalOrSystem(), memoryScopeColumns, sql`layer = ${WORKSPACE_LAYER}`)}
        AND source = ${docType}
        AND ${memoryEntries.metadata}->>'timestamp' LIKE ${dateStr + "%"}
    `);

    const row = ((rows.rows ?? rows) as Record<string, unknown>[])[0];
    const result: { count: number; sums: Record<string, number> } = {
      count: Number(row?.[countAlias] ?? 0),
      sums: {},
    };
    for (const f of sumFields) {
      result.sums[f] = Number(row?.[f] ?? 0);
    }
    log.debug(
      `aggregateMetadataByDate docType=${docType} date=${dateStr} count=${result.count}`,
    );
    return result;
  }

  async countByType(
    docType: DocType,
    sinceTimestamp?: string,
  ): Promise<number> {
    if (await targetReadsEnabled()) {
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
    const conditions = [
      sql`layer = ${WORKSPACE_LAYER}`,
      sql`source = ${docType}`,
      combineWithVisibleScope(
        getCurrentPrincipalOrSystem(),
        memoryScopeColumns,
        sql`TRUE`,
      ),
    ];
    if (sinceTimestamp) {
      conditions.push(sql`metadata->>'timestamp' >= ${sinceTimestamp}`);
    }
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS cnt
      FROM memory_entries
      WHERE ${sql.join(conditions, sql` AND `)}
    `);
    const row = ((rows.rows ?? rows) as { cnt: number }[])[0];
    return row?.cnt ?? 0;
  }

  async getDocumentsMetadataOnly(
    docType: DocType,
    sinceTimestamp?: string,
  ): Promise<
    Array<{
      id: number;
      docId: string;
      title: string | null;
      createdAt: string | null;
      metadata: Record<string, unknown>;
      ownerUserId: string | null;
      accountId: string | null;
      vaultId: string | null;
    }>
  > {
    if (await targetReadsEnabled()) {
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
        source_memory_entry_id: number | null; id: number; document_id: string; title: string | null;
        created_at: string | Date | null; metadata: Record<string, unknown>;
        owner_user_id: string | null; account_id: string | null; vault_id: string | null;
      }>).map((row) => ({
        id: row.source_memory_entry_id ?? row.id,
        docId: row.document_id,
        title: row.title,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ? String(row.created_at) : null,
        metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata || {},
        ownerUserId: row.owner_user_id,
        accountId: row.account_id,
        vaultId: row.vault_id,
      }));
    }
    const conditions = [
      sql`layer = ${WORKSPACE_LAYER}`,
      sql`source = ${docType}`,
      combineWithVisibleScope(
        getCurrentPrincipalOrSystem(),
        memoryScopeColumns,
        sql`TRUE`,
      ),
    ];
    if (sinceTimestamp) {
      conditions.push(sql`metadata->>'timestamp' >= ${sinceTimestamp}`);
    }
    const rows = await db.execute(sql`
      SELECT id, source_id, title, created_at, metadata,
             owner_user_id, account_id, vault_id
      FROM memory_entries
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY processed_at DESC
    `);
    return (
      (rows.rows ?? rows) as Array<{
        id: number;
        source_id: string;
        title: string | null;
        created_at: string | Date | null;
        metadata: Record<string, unknown>;
        owner_user_id: string | null;
        account_id: string | null;
        vault_id: string | null;
      }>
    ).map((r) => ({
      id: r.id,
      docId: r.source_id,
      title: r.title ?? null,
      createdAt: r.created_at
        ? r.created_at instanceof Date
          ? r.created_at.toISOString()
          : String(r.created_at)
        : null,
      metadata:
        typeof r.metadata === "string"
          ? JSON.parse(r.metadata)
          : r.metadata || {},
      ownerUserId: r.owner_user_id,
      accountId: r.account_id,
      vaultId: r.vault_id,
    }));
  }

  async aggregateMetadataGroupBy(
    docType: DocType,
    groupByField: string,
    sumFields: string[],
    sinceTimestamp?: string,
  ): Promise<
    Array<{ groupKey: string; count: number; sums: Record<string, number> }>
  > {
    assertSafeFieldName(groupByField);
    sumFields.forEach(assertSafeFieldName);
    if (await targetReadsEnabled()) {
      const conditions = [
        sql`document_type = ${docType}`,
        combineWithVisibleScope(getCurrentPrincipalOrSystem(), documentScopeColumns, sql`TRUE`),
      ];
      if (sinceTimestamp) conditions.push(sql`metadata->>'timestamp' >= ${sinceTimestamp}`);
      const sumExpressions = sumFields.map(
        (field) => sql`COALESCE(SUM((metadata->>${sql.raw(`'${field}'`)})::numeric), 0) AS ${sql.raw(`sum_${field}`)}`,
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
        sums: Object.fromEntries(sumFields.map((field) => [field, Number(row[`sum_${field}`] ?? 0)])),
      }));
    }
    const conditions = [
      sql`layer = ${WORKSPACE_LAYER}`,
      sql`source = ${docType}`,
      combineWithVisibleScope(
        getCurrentPrincipalOrSystem(),
        memoryScopeColumns,
        sql`TRUE`,
      ),
    ];
    if (sinceTimestamp) {
      conditions.push(sql`metadata->>'timestamp' >= ${sinceTimestamp}`);
    }

    const sumExpressions = sumFields.map(
      (f) =>
        sql`COALESCE(SUM((metadata->>${sql.raw(`'${f}'`)})::numeric), 0) AS ${sql.raw(`sum_${f}`)}`,
    );

    const rows = await db.execute(sql`
      SELECT
        metadata->>${sql.raw(`'${groupByField}'`)} AS group_key,
        COUNT(*)::int AS cnt,
        ${sql.join(sumExpressions, sql`, `)}
      FROM memory_entries
      WHERE ${sql.join(conditions, sql` AND `)}
      GROUP BY metadata->>${sql.raw(`'${groupByField}'`)}
    `);

    return ((rows.rows ?? rows) as Record<string, unknown>[]).map((row) => {
      const sums: Record<string, number> = {};
      for (const f of sumFields) {
        sums[f] = Number(row[`sum_${f}`] ?? 0);
      }
      return {
        groupKey: String(row.group_key ?? ""),
        count: Number(row.cnt ?? 0),
        sums,
      };
    });
  }

  async aggregateSummary(
    docType: DocType,
    sumFields: string[],
    sinceTimestamp?: string,
  ): Promise<{ count: number; sums: Record<string, number> }> {
    sumFields.forEach(assertSafeFieldName);
    if (await targetReadsEnabled()) {
      const conditions = [
        sql`document_type = ${docType}`,
        combineWithVisibleScope(getCurrentPrincipalOrSystem(), documentScopeColumns, sql`TRUE`),
      ];
      if (sinceTimestamp) conditions.push(sql`metadata->>'timestamp' >= ${sinceTimestamp}`);
      const sumExpressions = sumFields.map(
        (field) => sql`COALESCE(SUM((metadata->>${sql.raw(`'${field}'`)})::numeric), 0) AS ${sql.raw(`"${field}"`)}`,
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
    const conditions = [
      sql`layer = ${WORKSPACE_LAYER}`,
      sql`source = ${docType}`,
      combineWithVisibleScope(
        getCurrentPrincipalOrSystem(),
        memoryScopeColumns,
        sql`TRUE`,
      ),
    ];
    if (sinceTimestamp) {
      conditions.push(sql`metadata->>'timestamp' >= ${sinceTimestamp}`);
    }

    const sumExpressions = sumFields.map(
      (f) =>
        sql`COALESCE(SUM((metadata->>${sql.raw(`'${f}'`)})::numeric), 0) AS ${sql.raw(`"${f}"`)}`,
    );

    const rows = await db.execute(sql`
      SELECT
        COUNT(*)::int AS cnt,
        ${sql.join(sumExpressions, sql`, `)}
      FROM memory_entries
      WHERE ${sql.join(conditions, sql` AND `)}
    `);

    const row = ((rows.rows ?? rows) as Record<string, unknown>[])[0];
    const sums: Record<string, number> = {};
    for (const f of sumFields) {
      sums[f] = Number(row?.[f] ?? 0);
    }
    return {
      count: Number(row?.cnt ?? 0),
      sums,
    };
  }

  async getStats(): Promise<Record<string, number>> {
    if (await targetReadsEnabled()) {
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
    const rows = await db.execute(sql`
      SELECT source AS doc_type, COUNT(*)::int as count
      FROM memory_entries
      WHERE ${combineWithVisibleScope(getCurrentPrincipalOrSystem(), memoryScopeColumns, sql`layer = ${WORKSPACE_LAYER}`)}
      GROUP BY source
      ORDER BY source
    `);
    const stats: Record<string, number> = {};
    for (const row of (rows.rows ?? rows) as {
      doc_type: string;
      count: number;
    }[]) {
      stats[row.doc_type] = row.count;
    }
    log.debug(
      `getStats types=${Object.keys(stats).length} total=${Object.values(stats).reduce((a, b) => a + b, 0)}`,
    );
    return stats;
  }
}

export const documentStorage = new DocumentStorage();
