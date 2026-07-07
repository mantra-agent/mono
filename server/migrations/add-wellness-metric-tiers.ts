import { pool } from "../db";
import { createLogger } from "../log";

const log = createLogger("Migration:WellnessMetricTiers");

export async function runWellnessMetricTiersMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE wellness_activities ADD COLUMN IF NOT EXISTS linked_metric_type text;
      ALTER TABLE wellness_activities ADD COLUMN IF NOT EXISTS great_threshold real;
      ALTER TABLE wellness_activities ADD COLUMN IF NOT EXISTS good_threshold real;
    `);

    await client.query(`
      ALTER TABLE wellness_logs ADD COLUMN IF NOT EXISTS tier text;
      ALTER TABLE wellness_logs ADD COLUMN IF NOT EXISTS metric_value real;
    `);

    await client.query("COMMIT");
    log.log("Wellness metric tiers migration complete (columns added)");
  } catch (err: any) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.message?.includes("already exists")) {
      log.log("Migration already applied (columns already exist)");
    } else {
      throw err;
    }
  } finally {
    client.release();
  }

  scheduleBackgroundCleanup();
}

function scheduleBackgroundCleanup(): void {
  setTimeout(async () => {
    let client;
    try {
      client = await pool.connect();

      const { rows: oldIdx } = await client.query(`
        SELECT 1 FROM pg_indexes 
        WHERE indexname = 'health_metrics_type_date_value_source_unique'
      `);
      if (oldIdx.length > 0) {
        log.log("Background cleanup: dropping old per-value unique index...");
        await client.query(`DROP INDEX health_metrics_type_date_value_source_unique`);
        log.log("Background cleanup: old index dropped");
      }

      const { rows: newIdx } = await client.query(`
        SELECT 1 FROM pg_indexes 
        WHERE indexname = 'health_metrics_type_date_source_unique'
      `);

      if (newIdx.length > 0) {
        log.log("Background cleanup: daily unique index already exists, skipping");
        return;
      }

      log.log("Background cleanup: aggregating health_metrics to daily totals...");

      await client.query(`
        CREATE TEMP TABLE health_metrics_daily AS
        SELECT 
          MIN(id) AS id,
          metric_type,
          ROUND(CAST(SUM(value) AS numeric), 3) AS value,
          MIN(unit) AS unit,
          source,
          date,
          MIN(recorded_at) AS recorded_at
        FROM health_metrics
        GROUP BY metric_type, date, source
      `);

      const { rows: countRows } = await client.query(`SELECT COUNT(*) AS cnt FROM health_metrics`);
      const { rows: aggRows } = await client.query(`SELECT COUNT(*) AS cnt FROM health_metrics_daily`);
      const before = parseInt(countRows[0]?.cnt ?? "0");
      const after = parseInt(aggRows[0]?.cnt ?? "0");
      log.log(`Background cleanup: ${before} rows → ${after} daily aggregates (removing ${before - after} duplicates)`);

      await client.query(`TRUNCATE health_metrics`);
      await client.query(`
        INSERT INTO health_metrics (id, metric_type, value, unit, source, date, recorded_at)
        SELECT id, metric_type, value, unit, source, date, recorded_at
        FROM health_metrics_daily
      `);
      await client.query(`DROP TABLE health_metrics_daily`);

      log.log("Background cleanup: creating daily unique index...");
      await client.query(`
        CREATE UNIQUE INDEX health_metrics_type_date_source_unique 
        ON health_metrics (metric_type, date, source)
      `);
      log.log("Background cleanup: daily unique index created, migration complete");
    } catch (err: any) {
      if (err.message?.includes("already exists")) {
        log.log("Background cleanup: index already exists, skipping");
      } else {
        log.warn(`Background cleanup failed (non-fatal): ${err.message}`);
      }
    } finally {
      client?.release();
    }
  }, 30_000);
}
