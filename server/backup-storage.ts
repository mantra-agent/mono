/**
 * Database Backup Storage
 *
 * Self-service backup/restore system that creates compressed logical snapshots
 * of all PostgreSQL tables, stores them in S3, and enables full restore with
 * FK-safe ordering. Wraps exportBrain() and importDbTables() from brain.ts.
 */
import { db } from "./db";
import { sql } from "drizzle-orm";
import { createLogger } from "./log";
import { storageBackend } from "./object_storage/s3-backend";
import { exportBrain, importDbTables, BRAIN_EXPORT_DIR } from "./routes/brain";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import { createWriteStream, createReadStream } from "fs";
import * as path from "path";
import * as os from "os";

const log = createLogger("Backup");

const S3_PREFIX = "private/backups/";

// ---------------------------------------------------------------------------
// Restore job progress tracking (in-memory, transient)
// ---------------------------------------------------------------------------
export interface RestoreJobStatus {
  id: string;
  status: "uploading" | "extracting" | "counting" | "importing" | "complete" | "failed";
  phase: string;
  tables?: number;
  totalRows?: number;
  result?: RestoreResult;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

const restoreJobs = new Map<string, RestoreJobStatus>();

/** Create a new restore job tracker */
export function createRestoreJob(id: string): RestoreJobStatus {
  const job: RestoreJobStatus = { id, status: "extracting", phase: "Extracting archive...", startedAt: Date.now() };
  restoreJobs.set(id, job);
  // Auto-cleanup after 30 minutes
  setTimeout(() => restoreJobs.delete(id), 30 * 60 * 1000);
  return job;
}

/** Get restore job status */
export function getRestoreJobStatus(id: string): RestoreJobStatus | undefined {
  return restoreJobs.get(id);
}

/** Update restore job */
function updateRestoreJob(id: string, updates: Partial<RestoreJobStatus>): void {
  const job = restoreJobs.get(id);
  if (job) Object.assign(job, updates);
}

// ---------------------------------------------------------------------------
// Table bootstrap (auto-heal pattern)
// ---------------------------------------------------------------------------
let _tableBootstrapped = false;

async function ensureTable(): Promise<void> {
  if (_tableBootstrapped) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS backup_jobs (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      status TEXT NOT NULL DEFAULT 'in_progress',
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      s3_key TEXT,
      compressed_size INTEGER,
      table_count INTEGER,
      total_rows INTEGER,
      duration_ms INTEGER,
      table_manifest JSONB,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
      completed_at TIMESTAMPTZ
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_backup_jobs_created ON backup_jobs(created_at DESC)
  `);
  _tableBootstrapped = true;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface BackupJob {
  id: string;
  status: "in_progress" | "complete" | "failed" | "cancelled";
  trigger_type: "manual" | "scheduled" | "upload";
  s3_key: string | null;
  compressed_size: number | null;
  table_count: number | null;
  total_rows: number | null;
  duration_ms: number | null;
  table_manifest: Record<string, { rows: number; bytes: number }> | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface RestoreResult {
  dryRun: boolean;
  tables: number;
  totalRows: number;
  manifest: Record<string, number>;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spawn tar as a child process (mirrors brain.ts runTar pattern) */
async function runTar(args: string[], timeoutMs = 600_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      reject(new Error(`tar ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`tar ${args[0]} exited ${code}: ${stderrTail.trim() || "(no stderr)"}`));
    });
  });
}

/** Format bytes for human display */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Create a full database backup. Calls exportBrain() then uploads to S3.
 * Returns the backup job immediately (runs async in background).
 */
export async function createBackup(
  triggerType: "manual" | "scheduled" = "manual",
): Promise<BackupJob> {
  await ensureTable();

  // Prevent concurrent backups
  const existing = await db.execute(
    sql`SELECT id FROM backup_jobs WHERE status = 'in_progress' LIMIT 1`,
  );
  if (existing.rows.length > 0) {
    throw new Error("A backup is already in progress");
  }

  // Insert job row
  const [job] = (
    await db.execute(
      sql`INSERT INTO backup_jobs (status, trigger_type) VALUES ('in_progress', ${triggerType}) RETURNING *`,
    )
  ).rows as BackupJob[];

  log.log(`Backup ${job.id} started (trigger=${triggerType})`);

  // Run backup async — don't await
  runBackupAsync(job.id).catch((err) => {
    log.error(`Backup ${job.id} async runner failed: ${err.message}`);
  });

  return job;
}

async function runBackupAsync(jobId: string): Promise<void> {
  const startMs = Date.now();
  let localArchivePath: string | null = null;

  try {
    // 1. Export all tables to tar.gz
    const result = await exportBrain({
      mode: "data",
      onTableStart: (table, index, total) => {
        log.debug(`[${jobId}] Exporting ${table} (${index + 1}/${total})`);
      },
    });

    localArchivePath = result.archivePath;

    log.debug(`[${jobId}] Export complete: ${result.totalTables} tables, ${result.totalRows} rows, archive=${result.archivePath}`);

    // 2. Read archive and upload to S3
    const archiveBuffer = await fs.readFile(result.archivePath);
    const s3Key = `${S3_PREFIX}${jobId}.tar.gz`;
    log.debug(`[${jobId}] Uploading to S3 (${formatBytes(archiveBuffer.length)})...`);

    await storageBackend.putObject(s3Key, archiveBuffer, {
      contentType: "application/gzip",
    });

    // 3. Build table manifest from export results
    const manifest: Record<string, { rows: number; bytes: number }> = {};
    for (const [domain, summary] of Object.entries(result.domains)) {
      // The domains object has table-level info but we need per-table counts
      // from the actual exported files. Use the domain summary for now.
      if (summary && typeof summary === "object" && "tables" in summary) {
        const tables = (summary as any).tables;
        if (tables && typeof tables === "object") {
          for (const [tableName, info] of Object.entries(tables)) {
            manifest[tableName] = {
              rows: (info as any).rows ?? 0,
              bytes: (info as any).bytes ?? 0,
            };
          }
        }
      }
    }

    // If manifest is empty, try reading the manifest.json from the export
    // The archive has been created already, but we can read the brain export manifest
    if (Object.keys(manifest).length === 0) {
      // Use simpler approach: report totals from the export result
      manifest["_total"] = { rows: result.totalRows, bytes: result.sizeBytes };
    }

    const durationMs = Date.now() - startMs;

    // 4. Update job row
    await db.execute(sql`
      UPDATE backup_jobs SET
        status = 'complete',
        s3_key = ${s3Key},
        compressed_size = ${archiveBuffer.length},
        table_count = ${result.totalTables},
        total_rows = ${result.totalRows},
        duration_ms = ${durationMs},
        table_manifest = ${JSON.stringify(manifest)}::jsonb,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}
        AND status = 'in_progress'
    `);

    log.log(
      `Backup ${jobId} complete: ${result.totalTables} tables, ${result.totalRows} rows, ${formatBytes(archiveBuffer.length)} in ${durationMs}ms`,
    );

    // 5. Prune old backups
    await pruneOldBackups().catch((err) => {
      log.warn(`Retention prune after backup ${jobId} failed: ${err.message}`);
    });
  } catch (err: any) {
    const durationMs = Date.now() - startMs;
    log.error(`Backup ${jobId} failed after ${durationMs}ms: ${err.message}`);
    await db
      .execute(
        sql`
          UPDATE backup_jobs SET
            status = 'failed',
            error = ${err.message},
            duration_ms = ${durationMs},
            completed_at = CURRENT_TIMESTAMP
          WHERE id = ${jobId}
            AND status = 'in_progress'
        `,
      )
      .catch(() => {});
  } finally {
    // Clean up local archive
    if (localArchivePath) {
      await fs.rm(localArchivePath, { force: true }).catch(() => {});
    }
  }
}

/**
 * Create a backup_jobs entry from an uploaded .tar.gz file on disk.
 * Uploads the file to R2 at the standard key pattern, extracts metadata
 * (table count, row count, manifest), and returns the completed backup job.
 * Does NOT trigger a restore.
 */
export async function createBackupFromUpload(
  filePath: string,
): Promise<BackupJob> {
  await ensureTable();

  const startMs = Date.now();
  const jobId = (
    await db.execute(
      sql`INSERT INTO backup_jobs (status, trigger_type) VALUES ('in_progress', 'upload') RETURNING id`,
    )
  ).rows[0].id as string;

  try {
    // 1. Read file size
    const fileStat = await fs.stat(filePath);
    log.debug(`[UploadBackup] Job ${jobId}: processing uploaded file (${formatBytes(fileStat.size)})`);

    // 2. Upload to R2 at standard key pattern
    const s3Key = `${S3_PREFIX}${jobId}.tar.gz`;
    const archiveBuffer = await fs.readFile(filePath);
    await storageBackend.putObject(s3Key, archiveBuffer, {
      contentType: "application/gzip",
    });
    log.debug(`[UploadBackup] Job ${jobId}: uploaded to ${s3Key}`);

    // 3. Extract metadata from archive
    let tableCount = 0;
    let totalRows = 0;
    const manifest: Record<string, { rows: number; bytes: number }> = {};
    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-meta-"));

    try {
      await runTar(["-xzf", filePath, "-C", extractDir], 600_000);

      // Find the db/ directory
      const entries = await fs.readdir(extractDir);
      let dbDir: string | null = null;
      for (const entry of entries) {
        const candidate = path.join(extractDir, entry, "db");
        try {
          const stat = await fs.stat(candidate);
          if (stat.isDirectory()) { dbDir = candidate; break; }
        } catch { /* skip */ }
      }

      if (dbDir) {
        const jsonFiles = (await fs.readdir(dbDir)).filter((f) => f.endsWith(".json"));
        tableCount = jsonFiles.length;
        const STREAM_LIMIT = 5 * 1024 * 1024;
        for (const file of jsonFiles) {
          const tableName = file.replace(".json", "");
          const fp = path.join(dbDir, file);
          try {
            const fStat = await fs.stat(fp);
            if (fStat.size > STREAM_LIMIT) {
              let count = 0;
              for await (const _ of streamCountJsonArray(fp)) { count++; }
              manifest[tableName] = { rows: count, bytes: fStat.size };
              totalRows += count;
            } else {
              const content = await fs.readFile(fp, "utf-8");
              const rows = JSON.parse(content);
              const count = Array.isArray(rows) ? rows.length : 0;
              const bytes = Buffer.byteLength(content, "utf-8");
              manifest[tableName] = { rows: count, bytes };
              totalRows += count;
            }
          } catch {
            manifest[tableName] = { rows: 0, bytes: 0 };
          }
        }
        log.debug(`[UploadBackup] Job ${jobId}: extracted metadata — ${tableCount} tables, ${totalRows} rows`);
      } else {
        log.warn(`[UploadBackup] Job ${jobId}: no db/ directory found in archive — storing with size only`);
      }
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }

    // 4. Update job row to complete
    const durationMs = Date.now() - startMs;
    const result = await db.execute(sql`
      UPDATE backup_jobs SET
        status = 'complete',
        s3_key = ${s3Key},
        compressed_size = ${fileStat.size},
        table_count = ${tableCount},
        total_rows = ${totalRows},
        duration_ms = ${durationMs},
        table_manifest = ${JSON.stringify(manifest)}::jsonb,
        completed_at = CURRENT_TIMESTAMP
      WHERE id = ${jobId}
      RETURNING *
    `);

    log.debug(`[UploadBackup] Job ${jobId}: complete — ${tableCount} tables, ${totalRows} rows, ${formatBytes(fileStat.size)} in ${durationMs}ms`);
    return result.rows[0] as BackupJob;
  } catch (err: any) {
    const durationMs = Date.now() - startMs;
    log.error(`[UploadBackup] Job ${jobId} failed after ${durationMs}ms: ${err.message}`);
    await db.execute(
      sql`UPDATE backup_jobs SET status = 'failed', error = ${err.message}, duration_ms = ${durationMs}, completed_at = CURRENT_TIMESTAMP WHERE id = ${jobId}`,
    ).catch(() => {});
    throw err;
  }
}

/**
 * Create a backup_jobs entry from an R2 object key.
 * Moves the object to the standard key pattern, extracts metadata, and returns the job.
 */
export async function createBackupFromR2Key(
  objectKey: string,
): Promise<BackupJob> {
  await ensureTable();

  // Download from R2 to a temp file, then use createBackupFromUpload
  await fs.mkdir(path.join(os.tmpdir(), "backup-upload-stream"), { recursive: true });
  const tempFilePath = path.join(os.tmpdir(), "backup-upload-stream", `r2-${Date.now()}.tar.gz`);

  try {
    const stream = await storageBackend.getObjectStream(objectKey);
    await new Promise<void>((resolve, reject) => {
      const writeStream = createWriteStream(tempFilePath);
      stream.pipe(writeStream);
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      stream.on("error", reject);
    });

    const job = await createBackupFromUpload(tempFilePath);

    // Clean up the original R2 upload object (now at the standard key)
    await storageBackend.deleteObject(objectKey).catch((e) => {
      log.warn(`[UploadBackup] Failed to clean up original R2 object ${objectKey}: ${e.message}`);
    });

    return job;
  } finally {
    await fs.rm(tempFilePath, { force: true }).catch(() => {});
  }
}

/**
 * Mark interrupted in-progress backups as cancelled. Any in-progress row present
 * at process startup is stale because the in-memory async runner did not survive
 * the prior process.
 */
export async function recoverInterruptedBackups(): Promise<{ cancelled: number; ids: string[] }> {
  await ensureTable();
  const result = await db.execute(sql`
    UPDATE backup_jobs SET
      status = 'cancelled',
      error = COALESCE(error, 'Cancelled during startup recovery because the backup runner was interrupted.'),
      completed_at = CURRENT_TIMESTAMP,
      duration_ms = COALESCE(duration_ms, GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at))::integer * 1000))
    WHERE status = 'in_progress'
    RETURNING id
  `);
  const ids = result.rows.map((row: any) => String(row.id));
  if (ids.length > 0) {
    log.warn(`Startup recovery cancelled ${ids.length} interrupted backup(s): ${ids.join(', ')}`);
  }
  return { cancelled: ids.length, ids };
}

/**
 * Manually cancel an in-progress backup row. This clears stale UI/backend state.
 * The async runner guards completion updates with status='in_progress', so a late
 * background completion cannot resurrect a cancelled job.
 */
export async function cancelBackup(id: string, reason = 'Cancelled manually from Dev Database page'): Promise<BackupJob> {
  await ensureTable();
  const result = await db.execute(sql`
    UPDATE backup_jobs SET
      status = 'cancelled',
      error = ${reason},
      completed_at = CURRENT_TIMESTAMP,
      duration_ms = COALESCE(duration_ms, GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at))::integer * 1000))
    WHERE id = ${id}
      AND status = 'in_progress'
    RETURNING *
  `);
  const job = result.rows[0] as BackupJob | undefined;
  if (!job) {
    const existing = await getBackup(id);
    if (!existing) throw new Error(`Backup ${id} not found`);
    throw new Error(`Backup ${id} is not in progress (status=${existing.status})`);
  }
  log.warn(`Backup ${id} cancelled: ${reason}`);
  return job;
}

/**
 * List recent backups.
 */
export async function listBackups(limit = 20): Promise<BackupJob[]> {
  await ensureTable();
  const result = await db.execute(
    sql`SELECT * FROM backup_jobs ORDER BY created_at DESC LIMIT ${limit}`,
  );
  return result.rows as BackupJob[];
}

/**
 * Get a single backup by ID.
 */
export async function getBackup(id: string): Promise<BackupJob | null> {
  await ensureTable();
  const result = await db.execute(
    sql`SELECT * FROM backup_jobs WHERE id = ${id}`,
  );
  return (result.rows[0] as BackupJob) ?? null;
}

/**
 * Delete a backup (S3 archive + metadata row).
 */
export async function deleteBackup(id: string): Promise<void> {
  await ensureTable();
  const backup = await getBackup(id);
  if (!backup) throw new Error(`Backup ${id} not found`);

  if (backup.s3_key) {
    await storageBackend.deleteObject(backup.s3_key).catch((err) => {
      log.warn(`Failed to delete S3 object ${backup.s3_key}: ${err.message}`);
    });
  }

  await db.execute(sql`DELETE FROM backup_jobs WHERE id = ${id}`);
  log.debug(`Backup ${id} deleted`);
}

/**
 * Lightweight streaming row counter for JSON array files too large for
 * fs.readFile (Node string length limit ~512 MB). Tracks brace depth
 * to count top-level objects without parsing them.
 */
async function* streamCountJsonArray(filePath: string): AsyncGenerator<true> {
  const stream = createReadStream(filePath, { encoding: "utf-8", highWaterMark: 64 * 1024 });
  let depth = 0;
  let inString = false;
  let escape = false;

  for await (const chunk of stream) {
    const text = chunk as string;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (inString) {
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') { inString = false; }
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") { depth++; }
      else if (ch === "}") {
        depth--;
        if (depth === 0) { yield true; }
      }
    }
  }
}

/**
 * Restore the database from a backup.
 * If dryRun=true, downloads and validates without writing.
 */
export async function restoreFromBackup(
  id: string,
  dryRun = false,
): Promise<RestoreResult> {
  await ensureTable();
  const backup = await getBackup(id);
  if (!backup) throw new Error(`Backup ${id} not found`);
  if (backup.status !== "complete") {
    throw new Error(`Backup ${id} is not complete (status=${backup.status})`);
  }
  if (!backup.s3_key) {
    throw new Error(`Backup ${id} has no S3 key`);
  }

  const startMs = Date.now();
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-restore-"));

  try {
    // 1. Download archive from S3
    log.debug(`[Restore] Downloading ${backup.s3_key} (compressed_size=${backup.compressed_size ? formatBytes(backup.compressed_size) : "unknown"})...`);
    const archiveBuffer = await storageBackend.getObjectBuffer(backup.s3_key);
    const archivePath = path.join(extractDir, "backup.tar.gz");
    await fs.writeFile(archivePath, archiveBuffer);
    log.debug(`[Restore] Download complete (${formatBytes(archiveBuffer.length)})`);

    // 2. Extract tar.gz
    log.debug(`[Restore] Extracting archive...`);
    await runTar(["-xzf", archivePath, "-C", extractDir], 600_000);
    log.debug(`[Restore] Extraction complete`);

    // 3. Find the db/ directory inside the extracted archive
    //    exportBrain creates: brain-{timestamp}/db/{key}.json
    const entries = await fs.readdir(extractDir);
    let dbDir: string | null = null;

    for (const entry of entries) {
      const candidate = path.join(extractDir, entry, "db");
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          dbDir = candidate;
          break;
        }
      } catch {
        // not a directory, skip
      }
    }

    if (!dbDir) {
      throw new Error("Could not find db/ directory in backup archive");
    }

    // 4. Count tables and rows from JSON files
    const jsonFiles = (await fs.readdir(dbDir)).filter((f) => f.endsWith(".json"));
    const manifest: Record<string, number> = {};
    let totalRows = 0;
    const STREAM_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MB

    for (const file of jsonFiles) {
      const tableName = file.replace(".json", "");
      const filePath = path.join(dbDir, file);
      const fileStat = await fs.stat(filePath);

      if (fileStat.size > STREAM_THRESHOLD_BYTES) {
        // Stream-count rows for large files to avoid Node string length limits
        let count = 0;
        for await (const _ of streamCountJsonArray(filePath)) {
          count++;
        }
        manifest[tableName] = count;
        totalRows += count;
      } else {
        const content = await fs.readFile(filePath, "utf-8");
        try {
          const rows = JSON.parse(content);
          const count = Array.isArray(rows) ? rows.length : 0;
          manifest[tableName] = count;
          totalRows += count;
        } catch {
          manifest[tableName] = 0;
        }
      }
    }

    log.debug(`[Restore] Found ${jsonFiles.length} tables, ${totalRows} rows`);

    if (dryRun) {
      const durationMs = Date.now() - startMs;
      log.debug(`[Restore] Dry run complete in ${durationMs}ms`);
      return {
        dryRun: true,
        tables: jsonFiles.length,
        totalRows,
        manifest,
        durationMs,
      };
    }

    // 5. Full restore via importDbTables
    log.debug(`[Restore] Starting import into database...`);
    const importResult = await importDbTables(dbDir);

    const durationMs = Date.now() - startMs;
    const importedRows = Object.values(importResult.imported).reduce((a, b) => a + b, 0);

    log.debug(
      `[Restore] Complete: ${Object.keys(importResult.imported).length} tables, ${importedRows} rows in ${durationMs}ms (${importResult.failed.length} failures)`,
    );

    if (importResult.failed.length > 0) {
      log.warn(`[Restore] Failed tables: ${importResult.failed.join(", ")}`);
    }

    return {
      dryRun: false,
      tables: Object.keys(importResult.imported).length,
      totalRows: importedRows,
      manifest: importResult.imported,
      durationMs,
    };
  } finally {
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Restore the database from an uploaded .tar.gz file on disk.
 * Accepts a file path (streamed to disk by the route handler) to avoid
 * buffering large archives in Node memory.
 * If jobId is provided, updates the in-memory restore job tracker with progress.
 */
export async function restoreFromUpload(
  uploadedFilePath: string,
  dryRun = false,
  jobId?: string,
): Promise<RestoreResult> {
  const startMs = Date.now();
  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-upload-"));

  try {
    // 1. Get file size for logging
    const fileStat = await fs.stat(uploadedFilePath);
    log.debug(`[UploadRestore] Starting restore from uploaded file (${formatBytes(fileStat.size)}, dryRun=${dryRun})`);

    // 2. Extract tar.gz directly from the uploaded file path
    if (jobId) updateRestoreJob(jobId, { status: "extracting", phase: "Extracting archive..." });
    log.debug(`[UploadRestore] Extracting archive...`);
    await runTar(["-xzf", uploadedFilePath, "-C", extractDir], 600_000);
    log.debug(`[UploadRestore] Extraction complete`);

    // 3. Find the db/ directory inside the extracted archive
    const entries = await fs.readdir(extractDir);
    let dbDir: string | null = null;

    for (const entry of entries) {
      const candidate = path.join(extractDir, entry, "db");
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          dbDir = candidate;
          break;
        }
      } catch {
        // not a directory, skip
      }
    }

    if (!dbDir) {
      throw new Error("Could not find db/ directory in uploaded archive");
    }

    // 4. Count tables and rows
    if (jobId) updateRestoreJob(jobId, { status: "counting", phase: "Counting tables and rows..." });
    const jsonFiles = (await fs.readdir(dbDir)).filter((f) => f.endsWith(".json"));
    const manifest: Record<string, number> = {};
    let totalRows = 0;
    const STREAM_THRESHOLD = 5 * 1024 * 1024;

    for (const file of jsonFiles) {
      const tableName = file.replace(".json", "");
      const filePath = path.join(dbDir, file);
      const fileStat = await fs.stat(filePath);

      if (fileStat.size > STREAM_THRESHOLD) {
        let count = 0;
        for await (const _ of streamCountJsonArray(filePath)) {
          count++;
        }
        manifest[tableName] = count;
        totalRows += count;
      } else {
        const content = await fs.readFile(filePath, "utf-8");
        try {
          const rows = JSON.parse(content);
          const count = Array.isArray(rows) ? rows.length : 0;
          manifest[tableName] = count;
          totalRows += count;
        } catch {
          manifest[tableName] = 0;
        }
      }
    }

    log.debug(`[UploadRestore] Found ${jsonFiles.length} tables, ${totalRows} rows`);
    if (jobId) updateRestoreJob(jobId, { tables: jsonFiles.length, totalRows });

    if (dryRun) {
      const durationMs = Date.now() - startMs;
      log.debug(`[UploadRestore] Dry run complete in ${durationMs}ms`);
      const result: RestoreResult = { dryRun: true, tables: jsonFiles.length, totalRows, manifest, durationMs };
      if (jobId) updateRestoreJob(jobId, { status: "complete", phase: "Dry run complete", result, completedAt: Date.now() });
      return result;
    }

    // 5. Full restore
    if (jobId) updateRestoreJob(jobId, { status: "importing", phase: `Importing ${jsonFiles.length} tables (${totalRows.toLocaleString()} rows)...` });
    log.debug(`[UploadRestore] Starting import into database...`);
    const importResult = await importDbTables(dbDir);
    const durationMs = Date.now() - startMs;
    const importedRows = Object.values(importResult.imported).reduce((a, b) => a + b, 0);

    log.debug(
      `[UploadRestore] Complete: ${Object.keys(importResult.imported).length} tables, ${importedRows} rows in ${durationMs}ms`,
    );

    if (importResult.failed.length > 0) {
      log.warn(`[UploadRestore] Failed tables: ${importResult.failed.join(", ")}`);
    }

    const result: RestoreResult = {
      dryRun: false,
      tables: Object.keys(importResult.imported).length,
      totalRows: importedRows,
      manifest: importResult.imported,
      durationMs,
    };

    if (jobId) updateRestoreJob(jobId, { status: "complete", phase: "Restore complete", result, completedAt: Date.now() });
    return result;
  } catch (err: any) {
    if (jobId) updateRestoreJob(jobId, { status: "failed", phase: "Failed", error: err.message, completedAt: Date.now() });
    throw err;
  } finally {
    // Clean up extraction directory (uploaded file cleaned up by caller)
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Prune backups older than retentionDays.
 * Reads retention from system.backup.retentionDays setting, default 30.
 */
export async function pruneOldBackups(retentionDays?: number): Promise<number> {
  await ensureTable();

  // Default retention: 30 days
  let days = retentionDays ?? 30;
  if (!retentionDays) {
    try {
      const { getSetting } = await import("./system-settings");
      const stored = await getSetting("system.backup.retentionDays");
      if (stored != null) days = Number(stored);
    } catch {
      // system-settings not available, use default
    }
  }

  const expired = await db.execute(sql`
    SELECT id, s3_key FROM backup_jobs
    WHERE status != 'in_progress'
      AND created_at < CURRENT_TIMESTAMP - (${days} || ' days')::interval
  `);

  if (expired.rows.length === 0) return 0;

  for (const row of expired.rows as any[]) {
    if (row.s3_key) {
      await storageBackend.deleteObject(row.s3_key).catch((err) => {
        log.warn(`Failed to delete expired backup S3 object ${row.s3_key}: ${err.message}`);
      });
    }
    await db.execute(sql`DELETE FROM backup_jobs WHERE id = ${row.id}`);
  }

  log.debug(`Pruned ${expired.rows.length} expired backups (retention=${days} days)`);
  return expired.rows.length;
}
