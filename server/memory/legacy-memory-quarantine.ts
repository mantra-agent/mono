import { createHash } from "crypto";
import { pool } from "../db";
import { createLogger } from "../log";
import { storageBackend } from "../object_storage/s3-backend";

const log = createLogger("LegacyMemoryQuarantine");

/**
 * Durable, replay-safe quarantine of the retired legacy `memory_entries` graph
 * on stage. This module never mutates, recreates, or reconnects the canonical
 * legacy tables after the applied epoch: it moves the exact allowlisted table
 * closure into a dedicated PostgreSQL schema in one transaction, records the
 * exact reverse SQL, and persists a monotonic epoch that quarantine-aware boot
 * reads to skip every legacy convergence path.
 *
 * PostgreSQL is the sole authority. No environment variable or runtime hook may
 * enable the applied epoch; only the supervised stage operation may request it.
 */

export const LEGACY_MEMORY_QUARANTINE_KEY = "legacy_memory_v1";
export const LEGACY_MEMORY_QUARANTINE_SCHEMA = "legacy_memory_archive";
const RETIRED_LEGACY_MEMORY_QUARANTINE_SCHEMA = "legacy_memory_quarantine";
export const LEGACY_MEMORY_ARCHIVE_PREFIX =
  "private/archives/legacy-memory/stage/env-11/";

/**
 * Exact allowlisted legacy table closure. `memory_entries` is the root; the
 * remaining tables carry a foreign key into it. The prepare phase recomputes
 * the referential closure from `pg_catalog` and fails closed if the live
 * closure is not exactly this allowlist, so a future legacy table cannot be
 * silently stranded or a canonical table silently swept in.
 */
export const LEGACY_MEMORY_QUARANTINE_TABLES = [
  "memory_entries",
  "memory_sources",
  "memory_links",
  "memory_transitions",
  "memory_content_blocks",
  "memory_events",
  "memory_entity_links",
] as const;

export type LegacyMemoryQuarantineTable =
  (typeof LEGACY_MEMORY_QUARANTINE_TABLES)[number];

type PoolClient = Awaited<ReturnType<typeof pool.connect>>;

interface QuarantineStateRow {
  applied: boolean;
  prepared_at: Date | null;
  applied_at: Date | null;
  archive_object_path: string | null;
  archive_sha256: string | null;
  manifest: Record<string, unknown> | null;
  rollback_sql: string | null;
  row_counts: Record<string, number> | null;
}

export interface LegacyMemoryColumnInventory {
  name: string;
  dataType: string;
  udtName: string;
  ordinalPosition: number;
  nullable: boolean;
  defaultValue: string | null;
}

export interface LegacyMemoryForeignKey {
  constraintName: string;
  referencingTable: string;
  referencingColumns: string[];
  referencedTable: string;
  referencedColumns: string[];
  definition: string;
}

export interface LegacyMemoryTableInventory {
  table: string;
  columns: LegacyMemoryColumnInventory[];
  rowCount: number;
  indexes: string[];
  triggers: string[];
}

export interface LegacyMemoryArchiveManifest {
  cutoverKey: string;
  quarantineSchema: string;
  builtAt: string;
  allowlist: string[];
  closure: string[];
  tables: LegacyMemoryTableInventory[];
  outboundForeignKeys: LegacyMemoryForeignKey[];
  inboundForeignKeys: LegacyMemoryForeignKey[];
  totalRows: number;
  postgresVersion: string;
  runtimeIdentity: {
    platformEnvironmentId: number | null;
    environmentName: string;
    gitCommit: string | null;
    dbHost: string | null;
  };
  independentDocumentStore: boolean;
  archiveSha256: string;
  archiveByteLength: number;
}

export interface LegacyMemoryArchive {
  manifest: LegacyMemoryArchiveManifest;
  body: Buffer;
}

let appliedCache: boolean | null = null;
let appliedAtBoot: boolean | null = null;

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

// ---------------------------------------------------------------------------
// Durable state
// ---------------------------------------------------------------------------

export async function ensureLegacyMemoryQuarantineStateTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS legacy_memory_quarantine_state (
      cutover_key TEXT PRIMARY KEY,
      applied BOOLEAN NOT NULL DEFAULT FALSE,
      prepared_at TIMESTAMPTZ(6),
      applied_at TIMESTAMPTZ(6),
      archive_object_path TEXT,
      archive_sha256 TEXT,
      manifest JSONB,
      rollback_sql TEXT,
      row_counts JSONB,
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(
    `INSERT INTO legacy_memory_quarantine_state (cutover_key)
     VALUES ($1) ON CONFLICT (cutover_key) DO NOTHING`,
    [LEGACY_MEMORY_QUARANTINE_KEY],
  );
  await pool.query(`
    CREATE OR REPLACE FUNCTION enforce_legacy_memory_quarantine_monotonic()
    RETURNS TRIGGER AS $$
    BEGIN
      IF OLD.applied AND NOT NEW.applied THEN
        RAISE EXCEPTION 'legacy memory quarantine cannot be reverted through ordinary updates';
      END IF;
      IF OLD.applied_at IS NOT NULL
         AND NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
        RAISE EXCEPTION 'legacy memory quarantine applied timestamp is immutable';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await pool.query(
    `DROP TRIGGER IF EXISTS trg_legacy_memory_quarantine_monotonic ON legacy_memory_quarantine_state`,
  );
  await pool.query(`
    CREATE TRIGGER trg_legacy_memory_quarantine_monotonic
    BEFORE UPDATE ON legacy_memory_quarantine_state
    FOR EACH ROW EXECUTE FUNCTION enforce_legacy_memory_quarantine_monotonic()
  `);
}

async function readState(
  client: { query: typeof pool.query },
): Promise<QuarantineStateRow | null> {
  const result = await client.query<QuarantineStateRow>(
    `SELECT applied, prepared_at, applied_at, archive_object_path,
            archive_sha256, manifest, rollback_sql, row_counts
     FROM legacy_memory_quarantine_state
     WHERE cutover_key = $1`,
    [LEGACY_MEMORY_QUARANTINE_KEY],
  );
  return result.rows[0] ?? null;
}

/**
 * Cached applied predicate. `false` is never cached so a fresh boot re-reads
 * the epoch; once the epoch is applied it is immutable and safe to cache.
 */
export async function legacyMemoryQuarantineApplied(): Promise<boolean> {
  if (appliedCache) return true;
  try {
    const state = await readState(pool);
    appliedCache = state?.applied === true;
  } catch {
    // Missing state table before bootstrap means not-yet-quarantined.
    appliedCache = false;
  }
  if (appliedAtBoot === null) appliedAtBoot = appliedCache;
  return appliedCache;
}

export function legacyMemoryQuarantineWasAppliedAtBoot(): boolean {
  return appliedAtBoot === true;
}

export interface LegacyMemoryCatalogState {
  publicTables: string[];
  archiveTables: string[];
  retiredQuarantineTables: string[];
  missingTables: string[];
  splitTables: string[];
  unexpectedArchiveTables: string[];
}

export async function inspectLegacyMemoryCatalogState(
  client: { query: typeof pool.query } = pool,
): Promise<LegacyMemoryCatalogState> {
  const result = await client.query<{ schema_name: string; table_name: string }>(
    `SELECT n.nspname AS schema_name, c.relname AS table_name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname = ANY($1::text[])
       AND c.relname = ANY($2::text[])
     ORDER BY n.nspname, c.relname`,
    [
      [
        "public",
        LEGACY_MEMORY_QUARANTINE_SCHEMA,
        RETIRED_LEGACY_MEMORY_QUARANTINE_SCHEMA,
      ],
      [...LEGACY_MEMORY_QUARANTINE_TABLES],
    ],
  );
  const bySchema = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const schemaTables = bySchema.get(row.schema_name) ?? new Set<string>();
    schemaTables.add(row.table_name);
    bySchema.set(row.schema_name, schemaTables);
  }
  const publicSet = bySchema.get("public") ?? new Set<string>();
  const archiveSet = bySchema.get(LEGACY_MEMORY_QUARANTINE_SCHEMA) ?? new Set<string>();
  const retiredSet =
    bySchema.get(RETIRED_LEGACY_MEMORY_QUARANTINE_SCHEMA) ?? new Set<string>();
  const allLocations = new Set<string>([
    ...publicSet,
    ...archiveSet,
    ...retiredSet,
  ]);
  return {
    publicTables: [...publicSet].sort(),
    archiveTables: [...archiveSet].sort(),
    retiredQuarantineTables: [...retiredSet].sort(),
    missingTables: LEGACY_MEMORY_QUARANTINE_TABLES.filter(
      (table) => !allLocations.has(table),
    ),
    splitTables: LEGACY_MEMORY_QUARANTINE_TABLES.filter(
      (table) =>
        Number(publicSet.has(table)) +
          Number(archiveSet.has(table)) +
          Number(retiredSet.has(table)) >
        1,
    ),
    unexpectedArchiveTables: [...archiveSet]
      .filter(
        (table) =>
          !(LEGACY_MEMORY_QUARANTINE_TABLES as readonly string[]).includes(table),
      )
      .sort(),
  };
}

export async function getLegacyMemoryQuarantineStatus(): Promise<{
  applied: boolean;
  preparedAt: string | null;
  appliedAt: string | null;
  archiveObjectPath: string | null;
  archiveSha256: string | null;
  rowCounts: Record<string, number> | null;
  hasRollbackSql: boolean;
  catalog: LegacyMemoryCatalogState;
}> {
  const [state, catalog] = await Promise.all([
    readState(pool),
    inspectLegacyMemoryCatalogState(),
  ]);
  return {
    applied: state?.applied === true,
    preparedAt: state?.prepared_at ? new Date(state.prepared_at).toISOString() : null,
    appliedAt: state?.applied_at ? new Date(state.applied_at).toISOString() : null,
    archiveObjectPath: state?.archive_object_path ?? null,
    archiveSha256: state?.archive_sha256 ?? null,
    rowCounts: state?.row_counts ?? null,
    hasRollbackSql: Boolean(state?.rollback_sql),
    catalog,
  };
}

// ---------------------------------------------------------------------------
// Catalog closure
// ---------------------------------------------------------------------------

async function loadForeignKeys(
  client: PoolClient,
): Promise<LegacyMemoryForeignKey[]> {
  const result = await client.query<{
    constraint_name: string;
    referencing_table: string;
    referencing_columns: string[];
    referenced_table: string;
    referenced_columns: string[];
    definition: string;
  }>(`
    SELECT
      con.conname AS constraint_name,
      rel.relname AS referencing_table,
      (SELECT array_agg(att.attname ORDER BY u.ord)
         FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum
      ) AS referencing_columns,
      fref.relname AS referenced_table,
      (SELECT array_agg(att.attname ORDER BY u.ord)
         FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord)
         JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = u.attnum
      ) AS referenced_columns,
      pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace rns ON rns.oid = rel.relnamespace
    JOIN pg_class fref ON fref.oid = con.confrelid
    JOIN pg_namespace fns ON fns.oid = fref.relnamespace
    WHERE con.contype = 'f'
      AND rns.nspname = 'public'
      AND fns.nspname = 'public'
  `);
  return result.rows.map((row) => ({
    constraintName: row.constraint_name,
    referencingTable: row.referencing_table,
    referencingColumns: row.referencing_columns ?? [],
    referencedTable: row.referenced_table,
    referencedColumns: row.referenced_columns ?? [],
    definition: row.definition,
  }));
}

/**
 * Recompute the referential closure of `memory_entries` from the live catalog
 * and assert it equals the allowlist. Returns the outbound FKs (inside the
 * closure) and inbound FKs (from active public tables into the closure).
 */
export async function computeLegacyMemoryClosure(client: PoolClient): Promise<{
  closure: string[];
  outboundForeignKeys: LegacyMemoryForeignKey[];
  inboundForeignKeys: LegacyMemoryForeignKey[];
}> {
  const allowlist = new Set<string>(LEGACY_MEMORY_QUARANTINE_TABLES);
  const tables = await client.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name LIKE 'memory\\_%' ESCAPE '\\'
     ORDER BY table_name`,
  );
  const unclassified = tables.rows
    .map((row) => row.table_name)
    .filter(
      (table) =>
        table !== "memory_observations" &&
        !table.startsWith("memory_vnext_") &&
        !allowlist.has(table),
    );
  if (unclassified.length > 0) {
    throw new Error(
      `Unclassified public memory tables block quarantine: ${unclassified.join(",")}`,
    );
  }
  const physicalTables = new Set(tables.rows.map((row) => row.table_name));
  const allowlistList = [...allowlist].sort();
  const missing = allowlistList.filter((table) => !physicalTables.has(table));
  if (missing.length > 0) {
    throw new Error(
      `Legacy memory physical closure mismatch in public: missing=[${missing.join(",")}] unexpected=[]`,
    );
  }

  const foreignKeys = await loadForeignKeys(client);
  const outboundForeignKeys = foreignKeys.filter(
    (fk) =>
      allowlist.has(fk.referencingTable) && allowlist.has(fk.referencedTable),
  );
  const inboundForeignKeys = foreignKeys.filter(
    (fk) =>
      allowlist.has(fk.referencedTable) && !allowlist.has(fk.referencingTable),
  );

  return {
    closure: allowlistList,
    outboundForeignKeys,
    inboundForeignKeys,
  };
}

// ---------------------------------------------------------------------------
// Deterministic archive
// ---------------------------------------------------------------------------

async function loadTableInventory(
  client: PoolClient,
  table: string,
): Promise<LegacyMemoryTableInventory> {
  const columns = await client.query<{
    column_name: string;
    data_type: string;
    udt_name: string;
    ordinal_position: number;
    is_nullable: "YES" | "NO";
    column_default: string | null;
  }>(
    `SELECT column_name, data_type, udt_name, ordinal_position,
            is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  const indexes = await client.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = $1
     ORDER BY indexname`,
    [table],
  );
  const triggers = await client.query<{ def: string }>(
    `SELECT pg_get_triggerdef(t.oid) AS def
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1 AND NOT t.tgisinternal
     ORDER BY t.tgname`,
    [table],
  );
  const countRes = await client.query<{ cnt: string }>(
    `SELECT COUNT(*)::bigint AS cnt FROM public.${quoteIdent(table)}`,
  );
  return {
    table,
    columns: columns.rows.map((c) => ({
      name: c.column_name,
      dataType: c.data_type,
      udtName: c.udt_name,
      ordinalPosition: c.ordinal_position,
      nullable: c.is_nullable === "YES",
      defaultValue: c.column_default,
    })),
    rowCount: Number(countRes.rows[0]?.cnt ?? 0),
    indexes: indexes.rows.map((r) => r.indexdef),
    triggers: triggers.rows.map((r) => r.def),
  };
}

/**
 * Serialize one table's rows deterministically as JSONL. Rows are ordered by
 * primary key ordinal (id) and columns are emitted in ordinal order. pgvector
 * columns are rendered with their exact `::text` literal so no embedding byte
 * is lost through JSON float coercion.
 */
async function appendTableRowsJsonl(
  client: PoolClient,
  inventory: LegacyMemoryTableInventory,
  parts: string[],
): Promise<void> {
  const selectExprs = inventory.columns
    .map((col) => {
      if (col.dataType === "USER-DEFINED" || col.dataType === "ARRAY") {
        // pgvector and arrays are preserved as PostgreSQL text literals.
        return `${quoteIdent(col.name)}::text AS ${quoteIdent(col.name)}`;
      }
      return quoteIdent(col.name);
    })
    .join(", ");
  const orderColumn = inventory.columns.some((c) => c.name === "id")
    ? "id"
    : inventory.columns[0]?.name;
  const orderClause = orderColumn ? `ORDER BY ${quoteIdent(orderColumn)}` : "";

  const cursorName = `legacy_archive_${inventory.table}`;
  await client.query(
    `DECLARE ${quoteIdent(cursorName)} NO SCROLL CURSOR FOR SELECT ${selectExprs} FROM public.${quoteIdent(inventory.table)} ${orderClause}`,
  );
  try {
    while (true) {
      const res = await client.query(
        `FETCH FORWARD 250 FROM ${quoteIdent(cursorName)}`,
      );
      if (res.rows.length === 0) break;
      for (const row of res.rows) {
        const ordered: Record<string, unknown> = {};
        for (const col of inventory.columns) {
          ordered[col.name] = (row as Record<string, unknown>)[col.name] ?? null;
        }
        parts.push(
          JSON.stringify({ __table: inventory.table, row: ordered }),
        );
      }
    }
  } finally {
    await client.query(`CLOSE ${quoteIdent(cursorName)}`);
  }
}

/**
 * Build the deterministic full-byte JSONL archive plus its manifest inside the
 * caller's transaction. The archive body is a header line (manifest without the
 * archive hash), one inventory line per table, then one JSONL line per row.
 */
export async function buildLegacyMemoryArchive(
  client: PoolClient,
): Promise<LegacyMemoryArchive> {
  const { closure, outboundForeignKeys, inboundForeignKeys } =
    await computeLegacyMemoryClosure(client);

  const inventories: LegacyMemoryTableInventory[] = [];
  for (const table of LEGACY_MEMORY_QUARANTINE_TABLES) {
    inventories.push(await loadTableInventory(client, table));
  }
  const totalRows = inventories.reduce((sum, inv) => sum + inv.rowCount, 0);
  const postgresVersionResult = await client.query<{ version: string }>(
    "SHOW server_version",
  );
  const { getRuntimeIdentity } = await import("../runtime-identity");
  const runtimeIdentity = await getRuntimeIdentity();
  const { documentStoreIndependentWritesEnabled } = await import(
    "./document-store-cutover"
  );
  const independentDocumentStore =
    await documentStoreIndependentWritesEnabled();
  const runtimeEvidence = {
    platformEnvironmentId: runtimeIdentity.platformEnvironmentId,
    environmentName: runtimeIdentity.environmentName,
    gitCommit: runtimeIdentity.gitCommit,
    dbHost: runtimeIdentity.dbHost,
  };
  const postgresVersion = postgresVersionResult.rows[0]?.version ?? "unknown";

  const parts: string[] = [];
  // Ordinal 0: catalog inventory line.
  parts.push(
    JSON.stringify({
      __section: "inventory",
      cutoverKey: LEGACY_MEMORY_QUARANTINE_KEY,
      quarantineSchema: LEGACY_MEMORY_QUARANTINE_SCHEMA,
      allowlist: [...LEGACY_MEMORY_QUARANTINE_TABLES],
      closure,
      tables: inventories,
      outboundForeignKeys,
      inboundForeignKeys,
      totalRows,
      postgresVersion,
      runtimeIdentity: runtimeEvidence,
      independentDocumentStore,
    }),
  );
  // Rows, table by table in allowlist order.
  for (const inventory of inventories) {
    await appendTableRowsJsonl(client, inventory, parts);
  }

  const body = Buffer.from(parts.join("\n") + "\n", "utf8");
  const archiveSha256 = createHash("sha256").update(body).digest("hex");

  const manifest: LegacyMemoryArchiveManifest = {
    cutoverKey: LEGACY_MEMORY_QUARANTINE_KEY,
    quarantineSchema: LEGACY_MEMORY_QUARANTINE_SCHEMA,
    builtAt: new Date().toISOString(),
    allowlist: [...LEGACY_MEMORY_QUARANTINE_TABLES],
    closure,
    tables: inventories,
    outboundForeignKeys,
    inboundForeignKeys,
    totalRows,
    postgresVersion,
    runtimeIdentity: runtimeEvidence,
    independentDocumentStore,
    archiveSha256,
    archiveByteLength: body.byteLength,
  };

  return { manifest, body };
}

// ---------------------------------------------------------------------------
// Rollback SQL
// ---------------------------------------------------------------------------

export function buildRollbackSql(
  inboundForeignKeys: LegacyMemoryForeignKey[],
): string {
  const statements: string[] = [
    "BEGIN;",
    "SET LOCAL lock_timeout = '5s';",
    `ALTER TABLE legacy_memory_quarantine_state DISABLE TRIGGER trg_legacy_memory_quarantine_monotonic;`,
  ];
  for (const table of LEGACY_MEMORY_QUARANTINE_TABLES) {
    statements.push(
      `ALTER TABLE ${quoteIdent(LEGACY_MEMORY_QUARANTINE_SCHEMA)}.${quoteIdent(table)} SET SCHEMA public;`,
    );
  }
  for (const fk of inboundForeignKeys) {
    statements.push(
      `ALTER TABLE public.${quoteIdent(fk.referencingTable)} ADD CONSTRAINT ${quoteIdent(fk.constraintName)} ${fk.definition};`,
    );
  }
  statements.push(
    `UPDATE legacy_memory_quarantine_state SET applied = FALSE, applied_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE cutover_key = '${LEGACY_MEMORY_QUARANTINE_KEY}';`,
  );
  statements.push(
    `ALTER TABLE legacy_memory_quarantine_state ENABLE TRIGGER trg_legacy_memory_quarantine_monotonic;`,
  );
  statements.push(
    `DROP SCHEMA IF EXISTS ${quoteIdent(LEGACY_MEMORY_QUARANTINE_SCHEMA)};`,
  );
  statements.push("COMMIT;");
  return statements.join("\n");
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

export type PreparePrecondition = () => Promise<void>;

/**
 * Snapshot the legacy closure into a deterministic archive, upload it to
 * private object storage under the stage/env-11 prefix (outside backup_jobs and
 * its pruning), read it back, and verify the byte hash. Persists prepared
 * state. Does not move any table.
 */
export async function prepareLegacyMemoryQuarantine(): Promise<{
  archiveObjectPath: string;
  archiveSha256: string;
  totalRows: number;
  rowCounts: Record<string, number>;
}> {
  await ensureLegacyMemoryQuarantineStateTable();
  const state = await readState(pool);
  if (state?.applied) {
    throw new Error("Legacy memory quarantine already applied; prepare is unavailable");
  }

  const client = await pool.connect();
  let archive: LegacyMemoryArchive;
  try {
    // Repeatable-read snapshot so inventory counts and row bytes are consistent.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    archive = await buildLegacyMemoryArchive(client);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  } finally {
    client.release();
  }

  const archivePrefix = `${LEGACY_MEMORY_ARCHIVE_PREFIX}${archive.manifest.archiveSha256}/`;
  const objectKey = `${archivePrefix}archive.jsonl`;
  const manifestKey = `${archivePrefix}manifest.json`;
  const checksumKey = `${archivePrefix}files.sha256`;
  const manifestBody = Buffer.from(
    `${JSON.stringify(archive.manifest, null, 2)}\n`,
    "utf8",
  );
  const checksumBody = Buffer.from(
    `${archive.manifest.archiveSha256}  archive.jsonl\n`,
    "utf8",
  );
  await storageBackend.putObject(objectKey, archive.body, {
    contentType: "application/x-ndjson; charset=utf-8",
  });
  await storageBackend.putObject(manifestKey, manifestBody, {
    contentType: "application/json; charset=utf-8",
  });
  await storageBackend.putObject(checksumKey, checksumBody, {
    contentType: "text/plain; charset=utf-8",
  });

  // Read-back verification: exact archive, manifest, and checksum bytes must
  // match what this process produced before prepared state can be persisted.
  const [readBack, manifestReadBack, checksumReadBack] = await Promise.all([
    storageBackend.getObjectBuffer(objectKey),
    storageBackend.getObjectBuffer(manifestKey),
    storageBackend.getObjectBuffer(checksumKey),
  ]);
  const readBackSha256 = createHash("sha256").update(readBack).digest("hex");
  if (
    readBack.byteLength !== archive.body.byteLength ||
    readBackSha256 !== archive.manifest.archiveSha256 ||
    !manifestReadBack.equals(manifestBody) ||
    !checksumReadBack.equals(checksumBody)
  ) {
    throw new Error(
      `Legacy memory archive read-back verification failed: expected ${archive.manifest.archiveSha256} (${archive.body.byteLength} bytes), got ${readBackSha256} (${readBack.byteLength} bytes)`,
    );
  }

  const rowCounts: Record<string, number> = {};
  for (const inv of archive.manifest.tables) rowCounts[inv.table] = inv.rowCount;

  await pool.query(
    `UPDATE legacy_memory_quarantine_state
     SET prepared_at = CURRENT_TIMESTAMP,
         archive_object_path = $2,
         archive_sha256 = $3,
         manifest = $4::jsonb,
         row_counts = $5::jsonb,
         updated_at = CURRENT_TIMESTAMP
     WHERE cutover_key = $1`,
    [
      LEGACY_MEMORY_QUARANTINE_KEY,
      objectKey,
      archive.manifest.archiveSha256,
      JSON.stringify(archive.manifest),
      JSON.stringify(rowCounts),
    ],
  );

  log.info("legacy memory quarantine prepared", {
    objectKey,
    sha256: archive.manifest.archiveSha256,
    totalRows: archive.manifest.totalRows,
  });

  return {
    archiveObjectPath: objectKey,
    archiveSha256: archive.manifest.archiveSha256,
    totalRows: archive.manifest.totalRows,
    rowCounts,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

async function verifyPersistedLegacyMemoryArchive(
  state: QuarantineStateRow,
): Promise<void> {
  if (!state.archive_object_path || !state.archive_sha256 || !state.manifest) {
    throw new Error(
      "Legacy memory quarantine requires complete archive ledger evidence before apply",
    );
  }
  const manifest = state.manifest as unknown as LegacyMemoryArchiveManifest;
  if (
    manifest.archiveSha256 !== state.archive_sha256 ||
    manifest.quarantineSchema !== LEGACY_MEMORY_QUARANTINE_SCHEMA ||
    manifest.runtimeIdentity.platformEnvironmentId !== 11 ||
    manifest.independentDocumentStore !== true
  ) {
    throw new Error(
      "Legacy memory archive manifest does not match the canonical Stage quarantine contract",
    );
  }
  const archivePrefix = state.archive_object_path.slice(
    0,
    state.archive_object_path.lastIndexOf("/") + 1,
  );
  const manifestKey = `${archivePrefix}manifest.json`;
  const checksumKey = `${archivePrefix}files.sha256`;
  const expectedManifestBody = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const expectedChecksumBody = Buffer.from(
    `${state.archive_sha256}  archive.jsonl\n`,
    "utf8",
  );
  const [archiveBody, manifestBody, checksumBody, archiveHead] =
    await Promise.all([
      storageBackend.getObjectBuffer(state.archive_object_path),
      storageBackend.getObjectBuffer(manifestKey),
      storageBackend.getObjectBuffer(checksumKey),
      storageBackend.headObject(state.archive_object_path),
    ]);
  const readbackSha256 = createHash("sha256")
    .update(archiveBody)
    .digest("hex");
  if (
    readbackSha256 !== state.archive_sha256 ||
    archiveBody.byteLength !== manifest.archiveByteLength ||
    archiveHead?.contentLength !== manifest.archiveByteLength ||
    !manifestBody.equals(expectedManifestBody) ||
    !checksumBody.equals(expectedChecksumBody)
  ) {
    throw new Error(
      `Legacy memory persisted archive verification failed: expected ${state.archive_sha256} (${manifest.archiveByteLength} bytes), got ${readbackSha256} (${archiveBody.byteLength} bytes)`,
    );
  }
  log.info("legacy memory persisted archive readback verified", {
    archiveObjectPath: state.archive_object_path,
    sha256: state.archive_sha256,
    byteLength: archiveBody.byteLength,
  });
}

/**
 * Move the exact allowlisted legacy closure into the quarantine schema in one
 * transaction, dropping only inbound FKs from active public tables, and persist
 * the applied epoch plus the exact reverse SQL. Requires a verified prepared
 * archive. Does not drop any table.
 */
export async function applyLegacyMemoryQuarantine(): Promise<{
  applied: true;
  movedTables: string[];
  droppedInboundForeignKeys: string[];
  rollbackSql: string;
}> {
  await ensureLegacyMemoryQuarantineStateTable();
  const existing = await readState(pool);
  if (existing?.applied) {
    throw new Error("Legacy memory quarantine already applied");
  }
  if (!existing?.prepared_at || !existing.archive_sha256) {
    throw new Error("Legacy memory quarantine requires a verified prepared archive before apply");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      LEGACY_MEMORY_QUARANTINE_KEY,
    ]);

    const transactionState = await readState(client);
    if (transactionState?.applied) {
      await client.query("COMMIT");
      appliedCache = true;
      return {
        applied: true,
        movedTables: [],
        droppedInboundForeignKeys: [],
        rollbackSql: transactionState.rollback_sql ?? "",
      };
    }
    if (!transactionState?.archive_sha256 || !transactionState.manifest) {
      throw new Error(
        "Legacy memory quarantine requires a verified prepared archive before apply",
      );
    }
    await verifyPersistedLegacyMemoryArchive(transactionState);

    const catalogBeforeApply = await inspectLegacyMemoryCatalogState(client);
    if (
      catalogBeforeApply.archiveTables.length > 0 ||
      catalogBeforeApply.retiredQuarantineTables.length > 0 ||
      catalogBeforeApply.missingTables.length > 0 ||
      catalogBeforeApply.splitTables.length > 0 ||
      catalogBeforeApply.publicTables.length !==
        LEGACY_MEMORY_QUARANTINE_TABLES.length
    ) {
      throw new Error(
        `Legacy memory catalog is not in the exact pre-apply state: ${JSON.stringify(catalogBeforeApply)}`,
      );
    }

    const lockList = LEGACY_MEMORY_QUARANTINE_TABLES.map(
      (table) => `public.${quoteIdent(table)}`,
    ).join(", ");
    await client.query(`LOCK TABLE ${lockList} IN ACCESS EXCLUSIVE MODE`);
    const currentTransactionId = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const activeLegacyWriters = await client.query<{ count: string }>(
      `SELECT COUNT(DISTINCT l.pid)::bigint AS count
       FROM pg_locks l
       JOIN pg_class c ON c.oid = l.relation
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY($1::text[])
         AND l.pid <> $2
         AND l.granted
         AND l.mode IN ('RowExclusiveLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')`,
      [
        [...LEGACY_MEMORY_QUARANTINE_TABLES],
        currentTransactionId.rows[0]?.pid ?? -1,
      ],
    );
    if (Number(activeLegacyWriters.rows[0]?.count ?? 0) > 0) {
      throw new Error(
        "Legacy memory quarantine blocked because another process still holds a legacy write lock",
      );
    }

    const archive = await buildLegacyMemoryArchive(client);
    if (archive.manifest.archiveSha256 !== transactionState.archive_sha256) {
      throw new Error(
        "Legacy memory archive became stale before apply; prepare a fresh verified snapshot",
      );
    }

    const { closure, inboundForeignKeys } =
      await computeLegacyMemoryClosure(client);
    if (closure.length !== LEGACY_MEMORY_QUARANTINE_TABLES.length) {
      throw new Error(`Unexpected closure size at apply: ${closure.join(",")}`);
    }

    await client.query(
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(LEGACY_MEMORY_QUARANTINE_SCHEMA)}`,
    );

    // Drop inbound FKs from active public tables so quarantine leaves no
    // reconnecting edge back into the canonical legacy closure.
    for (const fk of inboundForeignKeys) {
      await client.query(
        `ALTER TABLE public.${quoteIdent(fk.referencingTable)} DROP CONSTRAINT IF EXISTS ${quoteIdent(fk.constraintName)}`,
      );
    }

    // Move each allowlisted table. Intra-closure FKs follow by OID and remain
    // valid inside the quarantine schema.
    for (const table of LEGACY_MEMORY_QUARANTINE_TABLES) {
      await client.query(
        `ALTER TABLE public.${quoteIdent(table)} SET SCHEMA ${quoteIdent(LEGACY_MEMORY_QUARANTINE_SCHEMA)}`,
      );
    }

    // Assert no allowlisted table remains in public.
    const remaining = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [[...LEGACY_MEMORY_QUARANTINE_TABLES]],
    );
    if (remaining.rows.length > 0) {
      throw new Error(
        `SET SCHEMA incomplete; still public: ${remaining.rows.map((r) => r.relname).join(",")}`,
      );
    }

    const catalogAfterMove = await inspectLegacyMemoryCatalogState(client);
    if (
      catalogAfterMove.publicTables.length > 0 ||
      catalogAfterMove.archiveTables.length !==
        LEGACY_MEMORY_QUARANTINE_TABLES.length ||
      catalogAfterMove.retiredQuarantineTables.length > 0 ||
      catalogAfterMove.missingTables.length > 0 ||
      catalogAfterMove.splitTables.length > 0 ||
      catalogAfterMove.unexpectedArchiveTables.length > 0
    ) {
      throw new Error(
        `Legacy memory catalog failed exact post-move validation: ${JSON.stringify(catalogAfterMove)}`,
      );
    }
    const archivedCounts: Record<string, number> = {};
    for (const table of LEGACY_MEMORY_QUARANTINE_TABLES) {
      const countResult = await client.query<{ count: string }>(
        `SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(LEGACY_MEMORY_QUARANTINE_SCHEMA)}.${quoteIdent(table)}`,
      );
      archivedCounts[table] = Number(countResult.rows[0]?.count ?? 0);
    }
    const expectedRowCounts = transactionState.row_counts ?? {};
    const countMismatches = LEGACY_MEMORY_QUARANTINE_TABLES.filter(
      (table) => archivedCounts[table] !== expectedRowCounts[table],
    );
    if (countMismatches.length > 0) {
      throw new Error(
        `Legacy memory archived row-count mismatch: tables=[${countMismatches.join(",")}]`,
      );
    }

    const rollbackSql = buildRollbackSql(inboundForeignKeys);

    await client.query(
      `UPDATE legacy_memory_quarantine_state
       SET applied = TRUE,
           applied_at = COALESCE(applied_at, CURRENT_TIMESTAMP),
           rollback_sql = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE cutover_key = $1
         AND applied = FALSE`,
      [LEGACY_MEMORY_QUARANTINE_KEY, rollbackSql],
    );

    await client.query("COMMIT");
    appliedCache = true;
    log.info("legacy memory quarantine applied; restart required", {
      movedTables: [...LEGACY_MEMORY_QUARANTINE_TABLES],
      droppedInboundForeignKeys: inboundForeignKeys.map((f) => f.constraintName),
    });
    return {
      applied: true,
      movedTables: [...LEGACY_MEMORY_QUARANTINE_TABLES],
      droppedInboundForeignKeys: inboundForeignKeys.map((f) => f.constraintName),
      rollbackSql,
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  } finally {
    client.release();
  }
}
