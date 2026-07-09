import { db, withQueryAttributionAsync } from "../db";
import {
  memoryEntries,
  type MemoryEntry,
  type MemoryLayer,
  type MemorySource,
  type DocType,
} from "@shared/schema";
import { eq, and, like, desc, sql, ilike, type SQL } from "drizzle-orm";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import {
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
} from "../scoped-storage";
import { createLogger } from "../log";
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

const WORKSPACE_LAYER = "workspace";
const log = createLogger("DocStorage");

const memoryScopeColumns = {
  scope: memoryEntries.scope,
  ownerUserId: memoryEntries.ownerUserId,
  accountId: memoryEntries.accountId,
  vaultId: memoryEntries.vaultId,
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
    }>
  > {
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
      SELECT id, source_id, title, created_at, metadata
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
