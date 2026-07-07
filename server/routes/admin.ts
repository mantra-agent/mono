/**
 * Admin API Routes
 *
 * POST /api/admin/cleanse — search-and-replace across all text/jsonb columns in the public schema
 *
 * When `stream: true` is passed, responds with NDJSON (newline-delimited JSON):
 *   { type: "backup", status: "creating" | "waiting" | "complete" | "failed" }
 *   { type: "progress", current: number, total: number, table: string, column: string }
 *   { type: "complete", ...CleanseResult }
 *   { type: "error", error: string }
 * Otherwise returns a single JSON CleanseResult.
 */
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db, pool } from "../db";
import { createLogger } from "../log";
import { requireAuth, requireAdmin } from "../auth";
import { createBackup } from "../backup-storage";
import { requireAdminPrivilegedMode } from "../sensitive-scope";

const log = createLogger("AdminRoutes");

interface CleanseDetail {
  table: string;
  column: string;
  type: string;
  rowsAffected: number;
}

interface CleanseResult {
  totalTablesScanned: number;
  totalColumnsScanned: number;
  totalRowsAffected: number;
  details: CleanseDetail[];
  backupId?: string;
  dryRun: boolean;
}

/** Write a JSON line to the response. Flushes immediately for real-time progress. */
function sendEvent(res: Response, data: Record<string, unknown>): void {
  res.write(JSON.stringify(data) + "\n");
  // Express doesn't expose flush() directly; if the underlying socket has it, call it
  if (typeof (res as any).flush === "function") (res as any).flush();
}

/** Batch size for execute-mode UPDATE operations to avoid MVCC bloat. */
const BATCH_SIZE = 5000;

export function registerAdminRoutes(app: Express): void {
  app.post(
    "/api/admin/cleanse",
    requireAuth,
    requireAdmin,
    requireAdminPrivilegedMode("admin:cleanse"),
    async (req: Request, res: Response) => {
      const { find, replace, dryRun = false, caseInsensitive = false, stream = false } = req.body || {};

      if (!find || typeof find !== "string" || find.trim().length === 0) {
        return res.status(400).json({ error: "'find' is required and must be a non-empty string" });
      }
      if (typeof replace !== "string") {
        return res.status(400).json({ error: "'replace' must be a string" });
      }

      const findStr = find as string;
      const replaceStr = replace as string;
      const isDryRun = !!dryRun;
      const isCaseInsensitive = !!caseInsensitive;
      const isStreaming = !!stream;

      log.log(`POST /api/admin/cleanse: find=${JSON.stringify(findStr)} replace=${JSON.stringify(replaceStr)} dryRun=${isDryRun} caseInsensitive=${isCaseInsensitive} stream=${isStreaming}`);

      // Set up streaming response if requested
      if (isStreaming) {
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("X-Accel-Buffering", "no"); // Disable nginx/proxy buffering
      }

      try {
        // Step 1: Auto-create backup before a real cleanse
        let backupId: string | undefined;
        if (!isDryRun) {
          try {
            if (isStreaming) sendEvent(res, { type: "backup", status: "creating" });
            const job = await createBackup("manual");
            backupId = job.id;
            log.log(`Pre-cleanse backup created: ${backupId}`);
            if (isStreaming) sendEvent(res, { type: "backup", status: "waiting" });
            // Wait for backup to complete (poll for up to 120s)
            const start = Date.now();
            while (Date.now() - start < 120_000) {
              const { getBackup } = await import("../backup-storage");
              const status = await getBackup(backupId);
              if (!status || status.status === "failed") {
                log.warn(`Pre-cleanse backup failed, proceeding anyway`);
                if (isStreaming) sendEvent(res, { type: "backup", status: "failed" });
                break;
              }
              if (status.status === "complete") {
                log.log(`Pre-cleanse backup completed`);
                if (isStreaming) sendEvent(res, { type: "backup", status: "complete" });
                break;
              }
              await new Promise((r) => setTimeout(r, 2000));
            }
          } catch (backupErr: any) {
            log.warn(`Pre-cleanse backup failed (non-fatal): ${backupErr.message}`);
            if (isStreaming) sendEvent(res, { type: "backup", status: "failed" });
          }
        }

        // Step 2: Discover all text-like columns in the public schema
        // TEXT[] columns report as data_type='ARRAY' with udt_name='_text'
        const colResult = await db.execute(sql`
          SELECT table_name, column_name, data_type, udt_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND (
              data_type IN ('text', 'character varying', 'jsonb')
              OR (data_type = 'ARRAY' AND udt_name = '_text')
            )
          ORDER BY table_name, ordinal_position
        `);

        const columns = colResult.rows as Array<{
          table_name: string;
          column_name: string;
          data_type: string;
          udt_name: string;
        }>;

        const tablesScanned = new Set<string>();
        const details: CleanseDetail[] = [];
        let totalRowsAffected = 0;

        // Shared query helpers
        const escapedFind = findStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const likeOp = isCaseInsensitive ? "ILIKE" : "LIKE";
        const regexFlags = isCaseInsensitive ? "gi" : "g";

        if (isDryRun) {
          // ── Dry-run: count matches per column in a single read-only transaction ──
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL statement_timeout = '300s'");

            for (let i = 0; i < columns.length; i++) {
              const { table_name, column_name, data_type } = columns[i];
              tablesScanned.add(table_name);

              if (isStreaming) {
                sendEvent(res, {
                  type: "progress",
                  current: i + 1,
                  total: columns.length,
                  table: table_name,
                  column: column_name,
                });
              }

              const isArray = data_type === "ARRAY";
              const colExpr = isArray
                ? `array_to_string("${column_name}", '|||')`
                : data_type === "jsonb" ? `"${column_name}"::text` : `"${column_name}"`;
              const result = await client.query(
                `SELECT COUNT(*) as cnt FROM "${table_name}" WHERE ${colExpr} ${likeOp} '%' || $1 || '%'`,
                [findStr],
              );
              const count = parseInt((result as any).rows?.[0]?.cnt ?? "0", 10);
              if (count > 0) {
                details.push({ table: table_name, column: column_name, type: isArray ? "text[]" : data_type, rowsAffected: count });
                totalRowsAffected += count;
              }
            }

            await client.query("ROLLBACK");
          } catch (txErr) {
            try { await client.query("ROLLBACK"); } catch {}
            throw txErr;
          } finally {
            client.release();
          }
        } else {
          // ── Execute: batched commits to avoid MVCC bloat on large datasets ──
          //
          // Phase 1 — fast count pass to learn total matching rows for progress.
          const matchCounts: Array<{
            table_name: string;
            column_name: string;
            data_type: string;
            count: number;
          }> = [];
          let totalMatches = 0;

          const countClient = await pool.connect();
          try {
            await countClient.query("BEGIN");
            await countClient.query("SET LOCAL statement_timeout = '300s'");

            for (let i = 0; i < columns.length; i++) {
              const { table_name, column_name, data_type } = columns[i];
              tablesScanned.add(table_name);
              const isArray = data_type === "ARRAY";
              const colExpr = isArray
                ? `array_to_string("${column_name}", '|||')`
                : data_type === "jsonb" ? `"${column_name}"::text` : `"${column_name}"`;
              const result = await countClient.query(
                `SELECT COUNT(*) as cnt FROM "${table_name}" WHERE ${colExpr} ${likeOp} '%' || $1 || '%'`,
                [findStr],
              );
              const count = parseInt((result as any).rows?.[0]?.cnt ?? "0", 10);
              if (count > 0) {
                matchCounts.push({ table_name, column_name, data_type, count });
                totalMatches += count;
              }
            }

            await countClient.query("ROLLBACK");
          } catch (countErr) {
            try { await countClient.query("ROLLBACK"); } catch {}
            throw countErr;
          } finally {
            countClient.release();
          }

          // Phase 2 — batch UPDATE per column, committing every BATCH_SIZE rows.
          // Each batch gets its own BEGIN/COMMIT so autovacuum can reclaim dead
          // tuples between batches instead of accumulating all MVCC bloat at once.
          // Partial completion on failure is acceptable — that's what the backup is for.
          let rowsProcessed = 0;
          const client = await pool.connect();
          try {
            for (const { table_name, column_name, data_type } of matchCounts) {
              const isArray = data_type === "ARRAY";
              const colExpr = isArray
                ? `array_to_string("${column_name}", '|||')`
                : data_type === "jsonb" ? `"${column_name}"::text` : `"${column_name}"`;

              let replaceExpr: string;
              let castSuffix: string;
              let params: string[];

              if (isArray) {
                // Rebuild array after replacing, filtering out empty-string elements
                const innerReplace = isCaseInsensitive
                  ? `regexp_replace(array_to_string("${column_name}", '|||'), $3, $2, '${regexFlags}')`
                  : `REPLACE(array_to_string("${column_name}", '|||'), $1, $2)`;
                replaceExpr = `array_remove(string_to_array(${innerReplace}, '|||'), '')`;
                castSuffix = "";
                params = isCaseInsensitive
                  ? [findStr, replaceStr, escapedFind]
                  : [findStr, replaceStr];
              } else {
                replaceExpr = isCaseInsensitive
                  ? `regexp_replace(${colExpr}, $3, $2, '${regexFlags}')`
                  : `REPLACE(${colExpr}, $1, $2)`;
                castSuffix = data_type === "jsonb" ? "::jsonb" : "";
                params = isCaseInsensitive
                  ? [findStr, replaceStr, escapedFind]
                  : [findStr, replaceStr];
              }

              let columnAffected = 0;

              // eslint-disable-next-line no-constant-condition
              while (true) {
                await client.query("BEGIN");
                await client.query("SET LOCAL statement_timeout = '300s'");

                const result = await client.query(
                  `UPDATE "${table_name}" SET "${column_name}" = (${replaceExpr})${castSuffix} ` +
                  `WHERE ctid IN (SELECT ctid FROM "${table_name}" WHERE ${colExpr} ${likeOp} '%' || $1 || '%' LIMIT ${BATCH_SIZE})`,
                  params,
                );

                const affected = result.rowCount ?? 0;
                await client.query("COMMIT");

                if (affected === 0) break;

                columnAffected += affected;
                rowsProcessed += affected;

                if (isStreaming) {
                  sendEvent(res, {
                    type: "progress",
                    current: rowsProcessed,
                    total: totalMatches,
                    table: table_name,
                    column: column_name,
                  });
                }
              }

              if (columnAffected > 0) {
                details.push({ table: table_name, column: column_name, type: isArray ? "text[]" : data_type, rowsAffected: columnAffected });
                totalRowsAffected += columnAffected;
              }
            }
          } catch (batchErr) {
            try { await client.query("ROLLBACK"); } catch {}
            log.warn(`Cleanse batch failed after ${rowsProcessed}/${totalMatches} rows. Partial changes committed.`);
            throw batchErr;
          } finally {
            client.release();
          }
        }

        const result: CleanseResult = {
          totalTablesScanned: tablesScanned.size,
          totalColumnsScanned: columns.length,
          totalRowsAffected,
          details,
          backupId,
          dryRun: isDryRun,
        };

        log.log(`Cleanse ${isDryRun ? "(dry run)" : "EXECUTED"}: ${totalRowsAffected} rows across ${tablesScanned.size} tables`);

        if (isStreaming) {
          sendEvent(res, { type: "complete", ...result });
          res.end();
        } else {
          res.json(result);
        }
      } catch (err: any) {
        log.error(`POST /api/admin/cleanse failed: ${err.message}`);
        if (isStreaming) {
          sendEvent(res, { type: "error", error: err.message });
          res.end();
        } else {
          res.status(500).json({ error: err.message });
        }
      }
    },
  );

  // ── Purge Events — manual trigger for system_events cleanup ──
  app.post(
    "/api/admin/purge-events",
    requireAuth,
    requireAdmin,
    async (_req: Request, res: Response) => {
      log.log("POST /api/admin/purge-events: starting manual event purge");
      try {
        const { cleanupOldEvents } = await import("../event-persistence");
        const deleted = await cleanupOldEvents(7);
        log.log(`POST /api/admin/purge-events: deleted ${deleted} events`);
        res.json({ deleted });
      } catch (err: any) {
        log.error(`POST /api/admin/purge-events failed: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    },
  );

  log.log("Admin routes registered");
}
