import { createHash } from "crypto";
import type { PoolClient } from "pg";
import { pool } from "../db";
import { createLogger } from "../log";
import type { RuntimeIdentity } from "../runtime-identity";
import { PRIVATE_PREFIX, storageBackend } from "../object_storage/s3-backend";
import { documentStoreIndependentWritesEnabled } from "./document-store-cutover";

const log = createLogger("LegacyMemoryQuarantine");
const STAGE_ENVIRONMENT_ID = 11;
const QUARANTINE_KEY = "legacy_memory_v1";
const QUARANTINE_SCHEMA = "legacy_memory_quarantine_20260727";
const ARCHIVE_ROOT = `${PRIVATE_PREFIX}archives/legacy-memory/stage/env-11`;
const BATCH_SIZE = 500;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

export const LEGACY_MEMORY_TABLES = [
  "memory_sources",
  "memory_links",
  "memory_transitions",
  "memory_content_blocks",
  "memory_events",
  "memory_entity_links",
  "memory_entries",
] as const;

type LegacyMemoryTable = (typeof LEGACY_MEMORY_TABLES)[number];
type QuarantineState = "prepared" | "uploaded" | "verified" | "applied" | "rolled_back";

type ArchiveFile = {
  objectKey: string;
  rowCount: number;
  bytes: number;
  sha256: string;
};

type ArchiveManifest = {
  version: 1;
  quarantineKey: string;
  archiveId: string;
  createdAt: string;
  environmentId: number;
  environmentName: string;
  commit: string | null;
  serverVersion: string;
  independentDocumentStore: true;
  catalogSha256: string;
  tables: Record<LegacyMemoryTable, ArchiveFile>;
  catalog: ArchiveFile;
  filesSha256: ArchiveFile;
};

type RunRow = {
  state: QuarantineState;
  archive_id: string;
  archive_object_prefix: string | null;
  archive_manifest: ArchiveManifest | Record<string, never>;
};

type CatalogSnapshot = {
  serverVersion: string;
  tables: Array<{
    table: string;
    columns: unknown[];
    constraints: unknown[];
    indexes: unknown[];
    triggers: unknown[];
    sequences: unknown[];
    foreignKeys: unknown[];
  }>;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function ensureLedger(client: Pick<PoolClient, "query"> = pool): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS legacy_memory_quarantine_runs (
      environment_id INTEGER NOT NULL,
      quarantine_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'prepared',
      archive_id TEXT NOT NULL,
      archive_object_prefix TEXT,
      archive_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
      prepared_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      uploaded_at TIMESTAMPTZ(6),
      verified_at TIMESTAMPTZ(6),
      applied_at TIMESTAMPTZ(6),
      rolled_back_at TIMESTAMPTZ(6),
      quarantine_schema TEXT,
      updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (environment_id, quarantine_key),
      CONSTRAINT legacy_memory_quarantine_state_valid
        CHECK (state IN ('prepared', 'uploaded', 'verified', 'applied', 'rolled_back'))
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS legacy_memory_quarantine_run_events (
      id BIGSERIAL PRIMARY KEY,
      environment_id INTEGER NOT NULL,
      quarantine_key TEXT NOT NULL,
      state TEXT NOT NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT legacy_memory_quarantine_event_state_valid
        CHECK (state IN ('prepared', 'uploaded', 'verified', 'applied', 'rolled_back'))
    )
  `);
}

async function readRun(client: Pick<PoolClient, "query"> = pool): Promise<RunRow | null> {
  const result = await client.query<RunRow>(
    `SELECT state, archive_id, archive_object_prefix, archive_manifest
       FROM legacy_memory_quarantine_runs
      WHERE environment_id = $1 AND quarantine_key = $2`,
    [STAGE_ENVIRONMENT_ID, QUARANTINE_KEY],
  );
  return result.rows[0] ?? null;
}

async function transitionRun(
  client: Pick<PoolClient, "query">,
  state: QuarantineState,
  details: Record<string, unknown>,
  patchSql: string,
  params: unknown[],
): Promise<void> {
  await client.query(
    `UPDATE legacy_memory_quarantine_runs
        SET state = $3, updated_at = CURRENT_TIMESTAMP, ${patchSql}
      WHERE environment_id = $1 AND quarantine_key = $2`,
    [STAGE_ENVIRONMENT_ID, QUARANTINE_KEY, state, ...params],
  );
  await client.query(
    `INSERT INTO legacy_memory_quarantine_run_events
      (environment_id, quarantine_key, state, details)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [STAGE_ENVIRONMENT_ID, QUARANTINE_KEY, state, JSON.stringify(details)],
  );
}

/** PostgreSQL is authoritative. False is deliberately never cached. */
let applied = false;
export async function isLegacyMemoryQuarantined(): Promise<boolean> {
  if (applied) return true;
  const ledger = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('public.legacy_memory_quarantine_runs') IS NOT NULL AS present`,
  );
  if (!ledger.rows[0]?.present) return false;
  const run = await readRun();
  applied = run?.state === "applied";
  return applied;
}

async function prepareRun(identity: RuntimeIdentity): Promise<RunRow> {
  await ensureLedger();
  const archiveId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${(identity.gitCommit || "unknown").slice(0, 8)}`;
  const inserted = await pool.query(
    `INSERT INTO legacy_memory_quarantine_runs
      (environment_id, quarantine_key, state, archive_id)
     VALUES ($1, $2, 'prepared', $3)
     ON CONFLICT (environment_id, quarantine_key) DO NOTHING`,
    [STAGE_ENVIRONMENT_ID, QUARANTINE_KEY, archiveId],
  );
  if (inserted.rowCount === 1) {
    await pool.query(
      `INSERT INTO legacy_memory_quarantine_run_events
        (environment_id, quarantine_key, state, details)
       VALUES ($1, $2, 'prepared', $3::jsonb)`,
      [STAGE_ENVIRONMENT_ID, QUARANTINE_KEY, JSON.stringify({ archiveId, commit: identity.gitCommit })],
    );
  }
  const run = await readRun();
  if (!run) throw new Error("Legacy memory quarantine ledger could not be prepared");
  return run;
}

async function assertCatalogClosure(client: Pick<PoolClient, "query">): Promise<void> {
  const result = await client.query<{ table_name: string }>(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND table_name LIKE 'memory\\_%' ESCAPE '\\'
     ORDER BY table_name
  `);
  const unclassified = result.rows.map((row) => row.table_name).filter((name) =>
    !LEGACY_MEMORY_TABLES.includes(name as LegacyMemoryTable) &&
    name !== "memory_observations" &&
    !name.startsWith("memory_vnext_")
  );
  if (unclassified.length > 0) {
    throw new Error(`Unclassified public memory tables block quarantine: ${unclassified.join(",")}`);
  }
  for (const table of LEGACY_MEMORY_TABLES) {
    const exists = await client.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [`public.${table}`],
    );
    if (!exists.rows[0]?.present) throw new Error(`Required legacy table missing before archive: public.${table}`);
  }
}

async function readCatalog(client: Pick<PoolClient, "query">): Promise<CatalogSnapshot> {
  const version = await client.query<{ server_version: string }>("SHOW server_version");
  const tables: CatalogSnapshot["tables"] = [];
  for (const table of LEGACY_MEMORY_TABLES) {
    const [columns, constraints, indexes, triggers, sequences, foreignKeys] = await Promise.all([
      client.query(
        `SELECT ordinal_position, column_name, data_type, udt_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      ),
      client.query(
        `SELECT conname, contype, pg_get_constraintdef(oid, true) AS definition
           FROM pg_constraint WHERE conrelid = to_regclass($1) ORDER BY conname`,
        [`public.${table}`],
      ),
      client.query(
        `SELECT indexname, indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = $1 ORDER BY indexname`,
        [table],
      ),
      client.query(
        `SELECT tgname, pg_get_triggerdef(oid, true) AS definition
           FROM pg_trigger WHERE tgrelid = to_regclass($1) AND NOT tgisinternal ORDER BY tgname`,
        [`public.${table}`],
      ),
      client.query(
        `SELECT a.attname AS column_name, pg_get_serial_sequence($1, a.attname) AS sequence_name
           FROM pg_attribute a
          WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped
            AND pg_get_serial_sequence($1, a.attname) IS NOT NULL
          ORDER BY a.attnum`,
        [`public.${table}`],
      ),
      client.query(
        `SELECT conname, conrelid::regclass::text AS source_table,
                confrelid::regclass::text AS target_table,
                pg_get_constraintdef(oid, true) AS definition
           FROM pg_constraint
          WHERE contype = 'f' AND (conrelid = to_regclass($1) OR confrelid = to_regclass($1))
          ORDER BY conname`,
        [`public.${table}`],
      ),
    ]);
    tables.push({
      table,
      columns: columns.rows,
      constraints: constraints.rows,
      indexes: indexes.rows,
      triggers: triggers.rows,
      sequences: sequences.rows,
      foreignKeys: foreignKeys.rows,
    });
  }
  return { serverVersion: version.rows[0]?.server_version || "unknown", tables };
}

async function readTableArchiveFromSchema(
  client: PoolClient,
  schema: string,
  table: LegacyMemoryTable,
): Promise<{ body: Buffer; rowCount: number }> {
  const chunks: string[] = [];
  let rowCount = 0;
  let bytes = 0;
  let lastId = 0;
  while (true) {
    const result = await client.query<{ id: number; row_data: unknown }>(
      `SELECT id, to_jsonb(source_row) AS row_data
         FROM (SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} WHERE id > $1 ORDER BY id LIMIT $2) source_row
        ORDER BY id`,
      [lastId, BATCH_SIZE],
    );
    if (result.rows.length === 0) break;
    for (const row of result.rows) {
      const line = `${stableJson(row.row_data)}\n`;
      bytes += Buffer.byteLength(line);
      if (bytes > MAX_ARCHIVE_BYTES) throw new Error(`Legacy archive exceeds ${MAX_ARCHIVE_BYTES} bytes at ${table}`);
      chunks.push(line);
      rowCount++;
      lastId = row.id;
    }
  }
  return { body: Buffer.from(chunks.join(""), "utf8"), rowCount };
}

async function readTableArchive(client: PoolClient, table: LegacyMemoryTable): Promise<{ body: Buffer; rowCount: number }> {
  return readTableArchiveFromSchema(client, "public", table);
}

async function writeAndVerify(key: string, body: Buffer, contentType: string): Promise<ArchiveFile> {
  await storageBackend.putObject(key, body, { contentType, cacheControl: "private, no-store" });
  const [readback, metadata] = await Promise.all([
    storageBackend.getObjectBuffer(key),
    storageBackend.headObject(key),
  ]);
  const expectedHash = sha256(body);
  if (!metadata || metadata.contentLength !== body.length || readback.length !== body.length || sha256(readback) !== expectedHash) {
    throw new Error(`Archive readback verification failed for ${key}`);
  }
  return { objectKey: key, rowCount: 0, bytes: body.length, sha256: expectedHash };
}

export async function archiveLegacyMemoryTables(identity: RuntimeIdentity): Promise<ArchiveManifest> {
  if (identity.platformEnvironmentId !== STAGE_ENVIRONMENT_ID) throw new Error("Legacy memory archive is restricted to Platform Environment #11");
  const run = await prepareRun(identity);
  if (run.state === "verified" || run.state === "applied") return run.archive_manifest as ArchiveManifest;

  const prefix = `${ARCHIVE_ROOT}/${run.archive_id}`;
  const client = await pool.connect();
  const tableBodies = new Map<LegacyMemoryTable, { body: Buffer; rowCount: number }>();
  let catalog: CatalogSnapshot;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await assertCatalogClosure(client);
    await client.query(`LOCK TABLE ${LEGACY_MEMORY_TABLES.map((table) => `public.${quoteIdent(table)}`).join(", ")} IN ACCESS SHARE MODE`);
    catalog = await readCatalog(client);
    for (const table of LEGACY_MEMORY_TABLES) tableBodies.set(table, await readTableArchive(client, table));
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve archive error */ }
    throw error;
  } finally {
    client.release();
  }

  const tables = {} as Record<LegacyMemoryTable, ArchiveFile>;
  for (const table of LEGACY_MEMORY_TABLES) {
    const archive = tableBodies.get(table)!;
    const file = await writeAndVerify(`${prefix}/${table}.jsonl`, archive.body, "application/x-ndjson");
    tables[table] = { ...file, rowCount: archive.rowCount };
  }
  const catalogBody = Buffer.from(`${stableJson(catalog)}\n`, "utf8");
  const catalogFile = await writeAndVerify(`${prefix}/catalog.json`, catalogBody, "application/json");
  const filesBody = Buffer.from([
    ...LEGACY_MEMORY_TABLES.map((table) => `${tables[table].sha256}  ${table}.jsonl`),
    `${catalogFile.sha256}  catalog.json`,
  ].join("\n") + "\n", "utf8");
  const filesFile = await writeAndVerify(`${prefix}/files.sha256`, filesBody, "text/plain");

  const manifest: ArchiveManifest = {
    version: 1,
    quarantineKey: QUARANTINE_KEY,
    archiveId: run.archive_id,
    createdAt: new Date().toISOString(),
    environmentId: STAGE_ENVIRONMENT_ID,
    environmentName: identity.platformEnvironmentName || identity.environmentName,
    commit: identity.gitCommit,
    serverVersion: catalog.serverVersion,
    independentDocumentStore: true,
    catalogSha256: catalogFile.sha256,
    tables,
    catalog: catalogFile,
    filesSha256: filesFile,
  };
  const manifestBody = Buffer.from(`${stableJson(manifest)}\n`, "utf8");
  const manifestFile = await writeAndVerify(`${prefix}/manifest.json`, manifestBody, "application/json");
  const manifestShaBody = Buffer.from(`${manifestFile.sha256}  manifest.json\n`, "utf8");
  await writeAndVerify(`${prefix}/manifest.sha256`, manifestShaBody, "text/plain");

  await transitionRun(pool, "uploaded", { prefix }, "archive_object_prefix = $4, archive_manifest = $5::jsonb, uploaded_at = CURRENT_TIMESTAMP", [prefix, JSON.stringify(manifest)]);

  for (const file of [...Object.values(tables), catalogFile, filesFile, manifestFile]) {
    const [readback, metadata] = await Promise.all([storageBackend.getObjectBuffer(file.objectKey), storageBackend.headObject(file.objectKey)]);
    if (!metadata || metadata.contentLength !== file.bytes || readback.length !== file.bytes || sha256(readback) !== file.sha256) {
      throw new Error(`Final archive verification failed for ${file.objectKey}`);
    }
  }
  await transitionRun(pool, "verified", { manifestSha256: manifestFile.sha256 }, "verified_at = CURRENT_TIMESTAMP", []);
  log.info("legacy memory archive readback verified", {
    prefix,
    tables: Object.fromEntries(LEGACY_MEMORY_TABLES.map((table) => [table, { rowCount: tables[table].rowCount, sha256: tables[table].sha256 }])),
  });
  return manifest;
}

export async function applyLegacyMemoryQuarantine(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["legacy_memory_quarantine_v1"]);
    await ensureLedger(client);
    const run = await client.query<RunRow>(
      `SELECT state, archive_id, archive_object_prefix, archive_manifest
         FROM legacy_memory_quarantine_runs
        WHERE environment_id = $1 AND quarantine_key = $2 FOR UPDATE`,
      [STAGE_ENVIRONMENT_ID, QUARANTINE_KEY],
    );
    const current = run.rows[0];
    if (!current) throw new Error("Legacy memory quarantine run is missing");
    if (current.state === "applied") {
      applied = true;
      await client.query("COMMIT");
      return;
    }
    if (current.state !== "verified") throw new Error(`Legacy memory quarantine requires verified archive, found ${current.state}`);
    const manifest = current.archive_manifest as ArchiveManifest;
    if (!manifest.independentDocumentStore || manifest.environmentId !== STAGE_ENVIRONMENT_ID) throw new Error("Legacy memory manifest prerequisite mismatch");
    if (!(await documentStoreIndependentWritesEnabled())) throw new Error("Independent document store is not authoritative");

    await assertCatalogClosure(client);
    await client.query(`LOCK TABLE ${LEGACY_MEMORY_TABLES.map((table) => `public.${quoteIdent(table)}`).join(", ")} IN ACCESS EXCLUSIVE MODE`);
    const currentCatalog = await readCatalog(client);
    if (sha256(Buffer.from(`${stableJson(currentCatalog)}\n`, "utf8")) !== manifest.catalogSha256) throw new Error("Legacy memory catalog changed after archive verification");
    for (const table of LEGACY_MEMORY_TABLES) {
      const currentArchive = await readTableArchive(client, table);
      if (
        currentArchive.rowCount !== manifest.tables[table].rowCount ||
        currentArchive.body.length !== manifest.tables[table].bytes ||
        sha256(currentArchive.body) !== manifest.tables[table].sha256
      ) {
        throw new Error(`Legacy memory content changed after archive verification: ${table}`);
      }
    }

    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(QUARANTINE_SCHEMA)}`);
    for (const table of LEGACY_MEMORY_TABLES) {
      await client.query(`ALTER TABLE public.${quoteIdent(table)} SET SCHEMA ${quoteIdent(QUARANTINE_SCHEMA)}`);
    }
    for (const table of LEGACY_MEMORY_TABLES) {
      const proof = await client.query<{ public_present: boolean; quarantine_present: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS public_present, to_regclass($2) IS NOT NULL AS quarantine_present`,
        [`public.${table}`, `${QUARANTINE_SCHEMA}.${table}`],
      );
      if (proof.rows[0]?.public_present || !proof.rows[0]?.quarantine_present) throw new Error(`Legacy memory catalog closure failed for ${table}`);
      const count = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${quoteIdent(QUARANTINE_SCHEMA)}.${quoteIdent(table)}`);
      if (count.rows[0]?.count !== manifest.tables[table].rowCount) throw new Error(`Quarantined row count mismatch: ${table}`);
    }
    await transitionRun(client, "applied", { schema: QUARANTINE_SCHEMA }, "applied_at = CURRENT_TIMESTAMP, quarantine_schema = $4", [QUARANTINE_SCHEMA]);
    await client.query("COMMIT");
    applied = true;
    log.info("legacy memory quarantine applied", { schema: QUARANTINE_SCHEMA, archivePrefix: current.archive_object_prefix });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve apply error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function rollbackLegacyMemoryQuarantine(identity: RuntimeIdentity): Promise<void> {
  if (identity.platformEnvironmentId !== STAGE_ENVIRONMENT_ID) {
    throw new Error("Legacy memory rollback is restricted to Platform Environment #11");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["legacy_memory_quarantine_v1"]);
    const run = await client.query<RunRow>(
      `SELECT state, archive_id, archive_object_prefix, archive_manifest
         FROM legacy_memory_quarantine_runs
        WHERE environment_id = $1 AND quarantine_key = $2 FOR UPDATE`,
      [STAGE_ENVIRONMENT_ID, QUARANTINE_KEY],
    );
    const current = run.rows[0];
    if (!current) throw new Error("Legacy memory quarantine run is missing");
    if (current.state === "rolled_back") {
      await client.query("COMMIT");
      applied = false;
      return;
    }
    if (current.state !== "applied") throw new Error(`Legacy memory rollback requires applied state, found ${current.state}`);
    const manifest = current.archive_manifest as ArchiveManifest;

    for (const table of LEGACY_MEMORY_TABLES) {
      const proof = await client.query<{ public_present: boolean; quarantine_present: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS public_present, to_regclass($2) IS NOT NULL AS quarantine_present`,
        [`public.${table}`, `${QUARANTINE_SCHEMA}.${table}`],
      );
      if (proof.rows[0]?.public_present) throw new Error(`Rollback blocked by public table conflict: ${table}`);
      if (!proof.rows[0]?.quarantine_present) throw new Error(`Rollback source table missing: ${table}`);
    }
    await client.query(`LOCK TABLE ${LEGACY_MEMORY_TABLES.map((table) => `${quoteIdent(QUARANTINE_SCHEMA)}.${quoteIdent(table)}`).join(", ")} IN ACCESS EXCLUSIVE MODE`);
    for (const table of LEGACY_MEMORY_TABLES) {
      const archive = await readTableArchiveFromSchema(client, QUARANTINE_SCHEMA, table);
      const expected = manifest.tables[table];
      if (archive.rowCount !== expected.rowCount || archive.body.length !== expected.bytes || sha256(archive.body) !== expected.sha256) {
        throw new Error(`Rollback blocked by quarantined content drift: ${table}`);
      }
    }
    for (const table of [...LEGACY_MEMORY_TABLES].reverse()) {
      await client.query(`ALTER TABLE ${quoteIdent(QUARANTINE_SCHEMA)}.${quoteIdent(table)} SET SCHEMA public`);
    }
    await transitionRun(client, "rolled_back", { schema: QUARANTINE_SCHEMA }, "rolled_back_at = CURRENT_TIMESTAMP", []);
    await client.query("COMMIT");
    applied = false;
    log.warn("legacy memory quarantine rolled back", { schema: QUARANTINE_SCHEMA });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve rollback error */ }
    throw error;
  } finally {
    client.release();
  }
}

export type StageQuarantineOutcome = "not_stage" | "not_ready" | "already_quarantined" | "restart_requested";

export async function requestStageLegacyMemoryQuarantineAfterReadiness(identity: RuntimeIdentity): Promise<StageQuarantineOutcome> {
  if (identity.platformEnvironmentId !== STAGE_ENVIRONMENT_ID) return "not_stage";
  if (!(await documentStoreIndependentWritesEnabled())) {
    log.warn("stage legacy memory quarantine waiting for independent document store");
    return "not_ready";
  }
  if (await isLegacyMemoryQuarantined()) {
    log.info("stage legacy memory quarantine rollout already converged");
    return "already_quarantined";
  }
  await archiveLegacyMemoryTables(identity);
  await applyLegacyMemoryQuarantine();
  if (typeof process.send !== "function") throw new Error("Stage legacy memory quarantine requires the supervised process wrapper");
  await new Promise<void>((resolve, reject) => {
    process.send!({ type: "planned_restart", reason: "stage_legacy_memory_quarantine" }, (error) => error ? reject(error) : resolve());
  });
  log.info("stage legacy memory quarantine persisted; planned restart requested");
  return "restart_requested";
}
