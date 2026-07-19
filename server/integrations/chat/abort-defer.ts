import { abortTrace } from "../../abort-trace";
import { pool as dbPool } from "../../db";
import { documentStoreIndependentWritesEnabled } from "../../memory/document-store-cutover";
import { chatStorage } from "./storage";
import { createLogger } from "../../log";
import { getCurrentPrincipalOrSystem } from "../../principal-context";

const log = createLogger("chat-abort-defer");

const STATUS_UPDATE_TIMEOUT_MS = 2000;

const LEGACY_STATUS_UPDATE_SQL = `UPDATE memory_entries
   SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{status}', to_jsonb($1::text), true),
       processed_at = NOW()
 WHERE layer = 'workspace'
   AND source = 'chat'
   AND source_id = $2
   AND (($3::text IS NOT NULL AND owner_user_id = $3) OR ($4::text IS NOT NULL AND account_id = $4))`;

const TARGET_STATUS_UPDATE_SQL = `UPDATE document_store_documents
   SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), '{status}', to_jsonb($1::text), true),
       updated_at = NOW(),
       migrated_at = NOW(),
       migration_key = 'document_store_independent_v1'
 WHERE document_type = 'chat'
   AND document_id = $2
   AND (($3::text IS NOT NULL AND owner_user_id = $3) OR ($4::text IS NOT NULL AND account_id = $4))`;

export function deferStatusSaved(sessionId: string, routeStartAt: number): void {
  const dbStartAt = Date.now();

  Promise.race([
    chatStorage.updateSessionStatus(sessionId, "saved").then(() => "ok" as const),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), STATUS_UPDATE_TIMEOUT_MS),
    ),
  ]).then(
    (outcome) => {
      const ms = Date.now() - dbStartAt;
      if (outcome === "timeout") {
        abortTrace("db_status_update_failed", { sessionId, ms, error: "race_timeout", routeStartAt });
        log.warn(`abort: status update to saved timed out sessionId=${sessionId} after ${ms}ms`);
      } else {
        abortTrace("db_status_updated", { sessionId, ms, routeStartAt });
      }
    },
    (err: unknown) => {
      const ms = Date.now() - dbStartAt;
      const msg = err instanceof Error ? err.message : String(err);
      abortTrace("db_status_update_failed", { sessionId, ms, error: msg, routeStartAt });
      log.warn(`abort: status update to saved failed sessionId=${sessionId} ms=${ms}: ${msg}`);
    },
  );

  const principal = getCurrentPrincipalOrSystem();
  void runSqlBackstop(
    sessionId,
    routeStartAt,
    principal.userId ?? null,
    principal.accountId ?? null,
  );
}

async function runSqlBackstop(
  sessionId: string,
  routeStartAt: number,
  ownerUserId: string | null,
  accountId: string | null,
): Promise<void> {
  const sqlStartAt = Date.now();
  let client: import("pg").PoolClient | null = null;
  try {
    client = await dbPool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '2000ms'");
    const sql = await documentStoreIndependentWritesEnabled()
      ? TARGET_STATUS_UPDATE_SQL
      : LEGACY_STATUS_UPDATE_SQL;
    const res = await client.query(sql, ["saved", sessionId, ownerUserId, accountId]);
    await client.query("COMMIT");
    abortTrace("db_status_sql_updated", {
      sessionId,
      ms: Date.now() - sqlStartAt,
      rowCount: res.rowCount ?? 0,
      routeStartAt,
    });
  } catch (err: unknown) {
    const ms = Date.now() - sqlStartAt;
    const msg = err instanceof Error ? err.message : String(err);
    if (client) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    }
    abortTrace("db_status_sql_failed", { sessionId, ms, error: msg, routeStartAt });
    log.warn(`abort: direct SQL status update failed sessionId=${sessionId} ms=${ms}: ${msg}`);
  } finally {
    if (client) {
      try { client.release(); } catch { /* ignore */ }
    }
  }
}
