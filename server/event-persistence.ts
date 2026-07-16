import { pool } from "./db";
import { createLogger } from "./log";

const log = createLogger("LegacyEventCleanup");

/**
 * Removes historical rows created before EventBus became process-local.
 * No runtime path inserts or queries system_events anymore.
 */
export async function cleanupOldEvents(retentionDays = 7): Promise<number> {
  try {
    let totalDeleted = 0;
    while (true) {
      const result = await pool.query(
        `DELETE FROM system_events
         WHERE id IN (
           SELECT id FROM system_events
           WHERE created_at < NOW() - INTERVAL '1 day' * $1
           LIMIT 10000
         )`,
        [retentionDays],
      );
      const deleted = result.rowCount || 0;
      if (deleted === 0) break;
      totalDeleted += deleted;
    }
    if (totalDeleted > 0) {
      log.info(`deleted ${totalDeleted} legacy events older than ${retentionDays} days`);
    }
    return totalDeleted;
  } catch (error) {
    log.warn("legacy event cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}
