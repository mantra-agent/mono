import { createHash, randomUUID } from "crypto";
import type { Pool, PoolClient } from "pg";
import { createLogger } from "../log";

const log = createLogger("DocumentStoreWorkspaceMigration");

const MIGRATION_KEY = "memory_workspace_to_document_store_v1";
const SOURCE_TABLE = "memory_entries";
const DEFAULT_BATCH_SIZE = 250;
const MAX_BATCH_SIZE = 1000;

type JsonRecord = Record<string, unknown>;

type SourceWorkspaceRow = {
  id: number;
  source: string;
  source_id: string | null;
  scope: string;
  owner_user_id: string | null;
  account_id: string | null;
  vault_id: string | null;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  path: string | null;
  title: string | null;
  summary: string | null;
  one_liner: string | null;
  content: string;
  metadata: JsonRecord | null;
  tags: string[] | null;
  created_at: Date;
  processed_at: Date | null;
};

type TargetDocumentRow = {
  id: number;
  document_type: string;
  document_id: string;
  source_table: string | null;
  source_row_id: string | null;
  source_memory_entry_id: number | null;
  source_id: string | null;
  scope: string;
  owner_user_id: string | null;
  account_id: string | null;
  vault_id: string | null;
  path: string | null;
  title: string | null;
  summary: string | null;
  one_liner: string | null;
  content: string;
  metadata: JsonRecord | null;
  tags: unknown;
  source_content_hash: string | null;
  source_metadata_hash: string | null;
  source_identity_hash: string | null;
  source_created_at: Date | null;
  source_processed_at: Date | null;
};

type PreparedDocument = {
  source: SourceWorkspaceRow;
  documentType: string;
  documentId: string;
  sourceRowId: string;
  sourceId: string | null;
  metadata: JsonRecord;
  tags: string[];
  contentHash: string;
  metadataHash: string;
  identityHash: string;
  identity: JsonRecord;
};

type MigrationCounters = {
  processed: number;
  inserted: number;
  matched: number;
  conflicts: number;
};

export type DocumentStoreWorkspaceMigrationResult = MigrationCounters & {
  runId: string;
  migrationKey: string;
  status: "completed" | "conflict" | "failed";
  highWaterStart: number;
  highWaterEnd: number;
  sourceMaxId: number;
  reconciliation: ReconciliationReport;
  error?: string;
};

export type ReconciliationMismatchSample = {
  sourceMemoryEntryId: number;
  fields: string[];
};

export type ReconciliationReport = {
  sourceCount: number;
  targetCount: number;
  exactMatchCount: number;
  missingTargetCount: number;
  hashMismatchCount: number;
  identityMismatchCount: number;
  timestampMismatchCount: number;
  nullabilityMismatchCount: number;
  duplicateSourceIds: JsonRecord[];
  duplicateDocumentIdentities: JsonRecord[];
  conflictCount: number;
  unexplainedMismatchCount: number;
  mismatchSamples: ReconciliationMismatchSample[];
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  const input = typeof value === "string" ? value : stableJson(value);
  return createHash("sha256").update(input).digest("hex");
}

function normalizeDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function deriveDocumentId(row: SourceWorkspaceRow): string {
  const raw = row.source_id?.trim();
  if (raw) return raw;
  return `memory-entry:${row.id}`;
}

function prepareDocument(row: SourceWorkspaceRow): PreparedDocument {
  const documentType = row.source;
  const documentId = deriveDocumentId(row);
  const sourceRowId = String(row.id);
  const metadata = row.metadata ?? {};
  const tags = Array.isArray(row.tags) ? row.tags : [];
  const identity = {
    sourceTable: SOURCE_TABLE,
    sourceMemoryEntryId: row.id,
    sourceRowId,
    documentType,
    documentId,
    sourceId: row.source_id ?? null,
    scope: row.scope,
    ownerUserId: row.owner_user_id ?? null,
    accountId: row.account_id ?? null,
    vaultId: row.vault_id ?? null,
  };
  return {
    source: row,
    documentType,
    documentId,
    sourceRowId,
    sourceId: row.source_id ?? null,
    metadata,
    tags,
    contentHash: sha256(row.content),
    metadataHash: sha256({ metadata, title: row.title, summary: row.summary, oneLiner: row.one_liner, tags }),
    identityHash: sha256(identity),
    identity,
  };
}

function targetIdentity(target: TargetDocumentRow): JsonRecord {
  return {
    sourceTable: target.source_table,
    sourceMemoryEntryId: target.source_memory_entry_id,
    sourceRowId: target.source_row_id,
    documentType: target.document_type,
    documentId: target.document_id,
    sourceId: target.source_id,
    scope: target.scope,
    ownerUserId: target.owner_user_id,
    accountId: target.account_id,
    vaultId: target.vault_id,
  };
}

function hashesForTarget(target: TargetDocumentRow): JsonRecord {
  const tags = Array.isArray(target.tags) ? target.tags : [];
  return {
    contentHash: sha256(target.content),
    metadataHash: sha256({
      metadata: target.metadata ?? {},
      title: target.title,
      summary: target.summary,
      oneLiner: target.one_liner,
      tags,
    }),
    identityHash: sha256(targetIdentity(target)),
  };
}

function comparePreparedToTarget(prepared: PreparedDocument, target: TargetDocumentRow): string[] {
  const mismatches: string[] = [];
  if (target.source_table !== SOURCE_TABLE) mismatches.push("source_table");
  if (target.source_row_id !== prepared.sourceRowId) mismatches.push("source_row_id");
  if (target.source_memory_entry_id !== prepared.source.id) mismatches.push("source_memory_entry_id");
  if (target.document_type !== prepared.documentType) mismatches.push("document_type");
  if (target.document_id !== prepared.documentId) mismatches.push("document_id");
  if (target.source_id !== prepared.sourceId) mismatches.push("source_id");
  if (target.scope !== prepared.source.scope) mismatches.push("scope");
  if (target.owner_user_id !== prepared.source.owner_user_id) mismatches.push("owner_user_id");
  if (target.account_id !== prepared.source.account_id) mismatches.push("account_id");
  if (target.vault_id !== prepared.source.vault_id) mismatches.push("vault_id");
  if (target.path !== prepared.source.path) mismatches.push("path");
  if (target.title !== prepared.source.title) mismatches.push("title");
  if (target.summary !== prepared.source.summary) mismatches.push("summary");
  if (target.one_liner !== prepared.source.one_liner) mismatches.push("one_liner");
  const targetHashes = hashesForTarget(target);
  if (targetHashes.contentHash !== prepared.contentHash) mismatches.push("content_hash");
  if (targetHashes.metadataHash !== prepared.metadataHash) mismatches.push("metadata_hash");
  if (targetHashes.identityHash !== prepared.identityHash) mismatches.push("identity_hash");
  if (normalizeDate(target.source_created_at) !== normalizeDate(prepared.source.created_at)) mismatches.push("source_created_at");
  if (normalizeDate(target.source_processed_at) !== normalizeDate(prepared.source.processed_at)) mismatches.push("source_processed_at");
  return mismatches;
}

async function insertConflict(
  client: PoolClient,
  runId: string,
  prepared: PreparedDocument,
  target: TargetDocumentRow | null,
  conflictType: string,
  details: JsonRecord,
): Promise<void> {
  await client.query(
    `INSERT INTO document_store_migration_conflicts (
      run_id, migration_key, source_memory_entry_id, target_document_store_id, conflict_type,
      source_identity, target_identity, source_hashes, target_hashes, details
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb)`,
    [
      runId,
      MIGRATION_KEY,
      prepared.source.id,
      target?.id ?? null,
      conflictType,
      JSON.stringify(prepared.identity),
      JSON.stringify(target ? targetIdentity(target) : {}),
      JSON.stringify({ contentHash: prepared.contentHash, metadataHash: prepared.metadataHash, identityHash: prepared.identityHash }),
      JSON.stringify(target ? hashesForTarget(target) : {}),
      JSON.stringify(details),
    ],
  );
}

async function findTarget(client: PoolClient, prepared: PreparedDocument): Promise<TargetDocumentRow | null> {
  const result = await client.query<TargetDocumentRow>(
    `SELECT * FROM document_store_documents
     WHERE source_memory_entry_id = $1
        OR (source_table = $2 AND source_row_id = $3)
        OR (scope = $4 AND owner_user_id IS NOT DISTINCT FROM $5 AND account_id IS NOT DISTINCT FROM $6 AND document_type = $7 AND document_id = $8)
     ORDER BY CASE WHEN source_memory_entry_id = $1 THEN 0 WHEN source_table = $2 AND source_row_id = $3 THEN 1 ELSE 2 END, id
     LIMIT 1`,
    [
      prepared.source.id,
      SOURCE_TABLE,
      prepared.sourceRowId,
      prepared.source.scope,
      prepared.source.owner_user_id,
      prepared.source.account_id,
      prepared.documentType,
      prepared.documentId,
    ],
  );
  return result.rows[0] ?? null;
}

async function insertTarget(client: PoolClient, prepared: PreparedDocument): Promise<void> {
  const row = prepared.source;
  await client.query(
    `INSERT INTO document_store_documents (
      document_type, document_id, source_table, source_row_id, source_memory_entry_id, source_id,
      path, title, summary, one_liner, content, metadata, tags,
      scope, owner_user_id, account_id, vault_id, created_by_user_id, updated_by_user_id,
      created_at, updated_at, source_created_at, source_processed_at,
      source_content_hash, source_metadata_hash, source_identity_hash, migration_key, migrated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,CURRENT_TIMESTAMP
    )`,
    [
      prepared.documentType,
      prepared.documentId,
      SOURCE_TABLE,
      prepared.sourceRowId,
      row.id,
      prepared.sourceId,
      row.path,
      row.title,
      row.summary,
      row.one_liner,
      row.content,
      JSON.stringify(prepared.metadata),
      JSON.stringify(prepared.tags),
      row.scope,
      row.owner_user_id,
      row.account_id,
      row.vault_id,
      row.created_by_user_id,
      row.updated_by_user_id,
      row.created_at,
      row.processed_at ?? row.created_at,
      row.created_at,
      row.processed_at,
      prepared.contentHash,
      prepared.metadataHash,
      prepared.identityHash,
      MIGRATION_KEY,
    ],
  );
}

async function loadBatch(client: PoolClient, afterId: number, sourceMaxId: number, batchSize: number): Promise<SourceWorkspaceRow[]> {
  const result = await client.query<SourceWorkspaceRow>(
    `SELECT id, source, source_id, scope, owner_user_id, account_id, vault_id, created_by_user_id, updated_by_user_id,
            path, title, summary, one_liner, content, metadata, tags, created_at, processed_at
     FROM memory_entries
     WHERE layer = 'workspace' AND id > $1 AND id <= $2
     ORDER BY id ASC
     LIMIT $3`,
    [afterId, sourceMaxId, batchSize],
  );
  return result.rows;
}

export async function repairDocumentStoreWorkspaceProjection(
  pool: Pool,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<{ repairedCount: number; batches: number }> {
  const boundedBatchSize = Math.min(Math.max(batchSize, 1), MAX_BATCH_SIZE);
  const client = await pool.connect();
  let repairedCount = 0;
  let batches = 0;
  try {
    while (true) {
      const candidates = await client.query<{ id: number }>(
        `SELECT m.id
         FROM memory_entries m
         JOIN document_store_documents d ON d.source_memory_entry_id = m.id
         WHERE m.layer = 'workspace'
           AND d.migration_key = $1
           AND (
             d.document_type IS DISTINCT FROM m.source OR
             d.document_id IS DISTINCT FROM COALESCE(NULLIF(BTRIM(m.source_id), ''), 'memory-entry:' || m.id::text) OR
             d.source_table IS DISTINCT FROM $2 OR
             d.source_row_id IS DISTINCT FROM m.id::text OR
             d.source_id IS DISTINCT FROM m.source_id OR
             d.path IS DISTINCT FROM m.path OR
             d.title IS DISTINCT FROM m.title OR
             d.summary IS DISTINCT FROM m.summary OR
             d.one_liner IS DISTINCT FROM m.one_liner OR
             d.content IS DISTINCT FROM m.content OR
             d.metadata IS DISTINCT FROM COALESCE(m.metadata, '{}'::jsonb) OR
             d.tags IS DISTINCT FROM COALESCE(to_jsonb(m.tags), '[]'::jsonb) OR
             d.scope IS DISTINCT FROM m.scope OR
             d.owner_user_id IS DISTINCT FROM m.owner_user_id OR
             d.account_id IS DISTINCT FROM m.account_id OR
             d.vault_id IS DISTINCT FROM m.vault_id OR
             d.created_by_user_id IS DISTINCT FROM m.created_by_user_id OR
             d.updated_by_user_id IS DISTINCT FROM m.updated_by_user_id OR
             d.created_at IS DISTINCT FROM m.created_at OR
             d.updated_at IS DISTINCT FROM COALESCE(m.processed_at, m.created_at) OR
             d.source_created_at IS DISTINCT FROM m.created_at OR
             d.source_processed_at IS DISTINCT FROM m.processed_at
           )
         ORDER BY m.id
         LIMIT $3`,
        [MIGRATION_KEY, SOURCE_TABLE, boundedBatchSize],
      );
      const ids = candidates.rows.map((row) => row.id);
      if (ids.length === 0) break;

      await client.query("BEGIN");
      try {
        const result = await client.query(
          `UPDATE document_store_documents d
           SET document_type = m.source,
               document_id = COALESCE(NULLIF(BTRIM(m.source_id), ''), 'memory-entry:' || m.id::text),
               source_table = $2,
               source_row_id = m.id::text,
               source_id = m.source_id,
               path = m.path,
               title = m.title,
               summary = m.summary,
               one_liner = m.one_liner,
               content = m.content,
               metadata = COALESCE(m.metadata, '{}'::jsonb),
               tags = COALESCE(to_jsonb(m.tags), '[]'::jsonb),
               scope = m.scope,
               owner_user_id = m.owner_user_id,
               account_id = m.account_id,
               vault_id = m.vault_id,
               created_by_user_id = m.created_by_user_id,
               updated_by_user_id = m.updated_by_user_id,
               created_at = m.created_at,
               updated_at = COALESCE(m.processed_at, m.created_at),
               source_created_at = m.created_at,
               source_processed_at = m.processed_at,
               source_content_hash = NULL,
               source_metadata_hash = NULL,
               source_identity_hash = NULL,
               migrated_at = CURRENT_TIMESTAMP
           FROM memory_entries m
           WHERE d.source_memory_entry_id = m.id
             AND d.migration_key = $1
             AND m.layer = 'workspace'
             AND m.id = ANY($3::int[])`,
          [MIGRATION_KEY, SOURCE_TABLE, ids],
        );
        await client.query("COMMIT");
        repairedCount += result.rowCount ?? 0;
        batches += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return { repairedCount, batches };
  } finally {
    client.release();
  }
}

async function getDuplicateSets(client: PoolClient): Promise<Pick<ReconciliationReport, "duplicateSourceIds" | "duplicateDocumentIdentities">> {
  const sourceIds = await client.query<JsonRecord>(
    `SELECT source, source_id, scope, owner_user_id, account_id, COUNT(*)::int AS count, array_agg(id ORDER BY id) AS memory_entry_ids
     FROM memory_entries
     WHERE layer = 'workspace' AND source_id IS NOT NULL
     GROUP BY source, source_id, scope, owner_user_id, account_id
     HAVING COUNT(*) > 1
     ORDER BY count DESC, source, source_id
     LIMIT 100`,
  );
  const identities = await client.query<JsonRecord>(
    `SELECT document_type, document_id, scope, owner_user_id, account_id, COUNT(*)::int AS count, array_agg(source_memory_entry_id ORDER BY source_memory_entry_id) AS source_memory_entry_ids
     FROM document_store_documents
     WHERE migration_key = $1
     GROUP BY document_type, document_id, scope, owner_user_id, account_id
     HAVING COUNT(*) > 1
     ORDER BY count DESC, document_type, document_id
     LIMIT 100`,
    [MIGRATION_KEY],
  );
  return { duplicateSourceIds: sourceIds.rows, duplicateDocumentIdentities: identities.rows };
}

export async function reconcileDocumentStoreWorkspaceMigration(pool: Pool): Promise<ReconciliationReport> {
  const client = await pool.connect();
  try {
    const duplicateSets = await getDuplicateSets(client);
    let sourceCount = 0;
    let targetCount = 0;
    let exactMatchCount = 0;
    let missingTargetCount = 0;
    let hashMismatchCount = 0;
    let identityMismatchCount = 0;
    let timestampMismatchCount = 0;
    let nullabilityMismatchCount = 0;
    const mismatchSamples: ReconciliationMismatchSample[] = [];

    const targetCountResult = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM document_store_documents WHERE migration_key = $1`,
      [MIGRATION_KEY],
    );
    targetCount = Number(targetCountResult.rows[0]?.count ?? 0);

    let afterId = 0;
    while (true) {
      const sources = await client.query<SourceWorkspaceRow>(
        `SELECT id, source, source_id, scope, owner_user_id, account_id, vault_id, created_by_user_id, updated_by_user_id,
                path, title, summary, one_liner, content, metadata, tags, created_at, processed_at
         FROM memory_entries
         WHERE layer = 'workspace' AND id > $1
         ORDER BY id ASC
         LIMIT $2`,
        [afterId, DEFAULT_BATCH_SIZE],
      );
      if (sources.rows.length === 0) break;
      const sourceIds = sources.rows.map((source) => source.id);
      const targets = await client.query<TargetDocumentRow>(
        `SELECT *
         FROM document_store_documents
         WHERE migration_key = $1 AND source_memory_entry_id = ANY($2::int[])`,
        [MIGRATION_KEY, sourceIds],
      );
      const targetsBySourceId = new Map(
        targets.rows
          .filter((target): target is TargetDocumentRow & { source_memory_entry_id: number } =>
            target.source_memory_entry_id !== null,
          )
          .map((target) => [target.source_memory_entry_id, target]),
      );
      for (const source of sources.rows) {
        sourceCount += 1;
        afterId = source.id;
        const prepared = prepareDocument(source);
        const target = targetsBySourceId.get(source.id);
        if (!target) {
          missingTargetCount += 1;
          if (mismatchSamples.length < 20) {
            mismatchSamples.push({ sourceMemoryEntryId: source.id, fields: ["missing_target"] });
          }
          continue;
        }
        const mismatches = comparePreparedToTarget(prepared, target);
        if (mismatches.length === 0) {
          exactMatchCount += 1;
          continue;
        }
        if (mismatchSamples.length < 20) {
          mismatchSamples.push({ sourceMemoryEntryId: source.id, fields: mismatches });
        }
        if (mismatches.some((field) => ["content_hash", "metadata_hash", "identity_hash"].includes(field))) {
          hashMismatchCount += 1;
        }
        if (mismatches.some((field) => ["source_table", "source_row_id", "source_memory_entry_id", "document_type", "document_id", "source_id", "scope", "owner_user_id", "account_id", "vault_id"].includes(field))) {
          identityMismatchCount += 1;
        }
        if (mismatches.some((field) => ["source_created_at", "source_processed_at"].includes(field))) {
          timestampMismatchCount += 1;
        }
        if (
          (source.source_id === null) !== (target.source_id === null) ||
          (source.owner_user_id === null) !== (target.owner_user_id === null) ||
          (source.account_id === null) !== (target.account_id === null) ||
          (source.vault_id === null) !== (target.vault_id === null)
        ) {
          nullabilityMismatchCount += 1;
        }
      }
    }

    const conflictCountResult = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM document_store_migration_conflicts WHERE migration_key = $1`,
      [MIGRATION_KEY],
    );
    const conflictCount = Number(conflictCountResult.rows[0]?.count ?? 0);
    const unexplainedMismatchCount =
      missingTargetCount +
      hashMismatchCount +
      identityMismatchCount +
      timestampMismatchCount +
      nullabilityMismatchCount;

    return {
      sourceCount,
      targetCount,
      exactMatchCount,
      missingTargetCount,
      hashMismatchCount,
      identityMismatchCount,
      timestampMismatchCount,
      nullabilityMismatchCount,
      ...duplicateSets,
      conflictCount,
      unexplainedMismatchCount,
      mismatchSamples,
    };
  } finally {
    client.release();
  }
}

export async function runDocumentStoreWorkspaceMigration(
  pool: Pool,
  options: { batchSize?: number; runId?: string } = {},
): Promise<DocumentStoreWorkspaceMigrationResult> {
  const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
  const runId = options.runId ?? `${MIGRATION_KEY}:${Date.now()}:${randomUUID()}`;
  const client = await pool.connect();
  const counters: MigrationCounters = { processed: 0, inserted: 0, matched: 0, conflicts: 0 };
  let highWaterStart = 0;
  let highWaterEnd = 0;
  let sourceMaxId = 0;
  try {
    await client.query("BEGIN");
    const watermark = await client.query<{ high_water_end: number | null }>(
      `SELECT COALESCE(MAX(high_water_end), 0)::int AS high_water_end
       FROM document_store_migration_runs
       WHERE migration_key = $1 AND status IN ('completed', 'conflict')`,
      [MIGRATION_KEY],
    );
    highWaterStart = watermark.rows[0]?.high_water_end ?? 0;
    const maxResult = await client.query<{ max_id: number | null }>(`SELECT COALESCE(MAX(id), 0)::int AS max_id FROM memory_entries WHERE layer = 'workspace'`);
    sourceMaxId = maxResult.rows[0]?.max_id ?? 0;
    await client.query(
      `INSERT INTO document_store_migration_runs (id, migration_key, status, batch_size, high_water_start, high_water_end, source_max_id)
       VALUES ($1,$2,'running',$3,$4,$4,$5)`,
      [runId, MIGRATION_KEY, batchSize, highWaterStart, sourceMaxId],
    );
    await client.query("COMMIT");

    let afterId = highWaterStart;
    while (afterId < sourceMaxId) {
      await client.query("BEGIN");
      const batch = await loadBatch(client, afterId, sourceMaxId, batchSize);
      if (batch.length === 0) {
        await client.query("COMMIT");
        break;
      }
      for (const source of batch) {
        const prepared = prepareDocument(source);
        const target = await findTarget(client, prepared);
        counters.processed += 1;
        if (!target) {
          await insertTarget(client, prepared);
          counters.inserted += 1;
          continue;
        }
        const mismatches = comparePreparedToTarget(prepared, target);
        if (mismatches.length === 0) {
          counters.matched += 1;
          continue;
        }
        counters.conflicts += 1;
        await insertConflict(client, runId, prepared, target, "target_mismatch", { mismatches });
      }
      afterId = batch[batch.length - 1].id;
      highWaterEnd = afterId;
      await client.query(
        `UPDATE document_store_migration_runs
         SET high_water_end = $2, processed_count = $3, inserted_count = $4, matched_count = $5, conflict_count = $6
         WHERE id = $1`,
        [runId, highWaterEnd, counters.processed, counters.inserted, counters.matched, counters.conflicts],
      );
      await client.query("COMMIT");
      if (counters.conflicts > 0) break;
    }

    const reconciliation = await reconcileDocumentStoreWorkspaceMigration(pool);
    const status = counters.conflicts > 0 || reconciliation.unexplainedMismatchCount > 0 || reconciliation.conflictCount > 0 ? "conflict" : "completed";
    await client.query(
      `UPDATE document_store_migration_runs
       SET status = $2, high_water_end = $3, processed_count = $4, inserted_count = $5, matched_count = $6,
           conflict_count = $7, reconciliation = $8::jsonb, completed_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [runId, status, highWaterEnd || highWaterStart, counters.processed, counters.inserted, counters.matched, counters.conflicts, JSON.stringify(reconciliation)],
    );
    log.info("document store workspace migration finished", { runId, status, counters, reconciliation });
    return { runId, migrationKey: MIGRATION_KEY, status, highWaterStart, highWaterEnd: highWaterEnd || highWaterStart, sourceMaxId, ...counters, reconciliation };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    const message = error instanceof Error ? error.message : String(error);
    await client.query(
      `INSERT INTO document_store_migration_runs (id, migration_key, status, batch_size, high_water_start, high_water_end, source_max_id, processed_count, inserted_count, matched_count, conflict_count, error, completed_at)
       VALUES ($1,$2,'failed',$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET status = 'failed', error = EXCLUDED.error, completed_at = CURRENT_TIMESTAMP`,
      [runId, MIGRATION_KEY, batchSize, highWaterStart, highWaterEnd || highWaterStart, sourceMaxId, counters.processed, counters.inserted, counters.matched, counters.conflicts, message],
    );
    log.error("document store workspace migration failed", { runId, error: message });
    const reconciliation = await reconcileDocumentStoreWorkspaceMigration(pool);
    return { runId, migrationKey: MIGRATION_KEY, status: "failed", highWaterStart, highWaterEnd: highWaterEnd || highWaterStart, sourceMaxId, ...counters, reconciliation, error: message };
  } finally {
    client.release();
  }
}
