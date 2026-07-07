import { pool } from "../db";
import { createLogger } from "../log";

const log = createLogger("Migration:WellnessTimestamptz");

const TARGETS: { table: string; column: string }[] = [
  { table: "wellness_logs", column: "completed_at" },
  { table: "gratitude_entries", column: "created_at" },
  { table: "gratitude_entries", column: "updated_at" },
  { table: "wellness_activities", column: "created_at" },
  { table: "wellness_activities", column: "updated_at" },
  { table: "wellness_activities", column: "archived_at" },
  { table: "health_metrics", column: "recorded_at" },
];

export async function runWellnessTimestamptzMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows: existing } = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (table_name, column_name) IN (${TARGETS.map(
           (_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`,
         ).join(",")})`,
      TARGETS.flatMap((t) => [t.table, t.column]),
    );

    const toConvert = existing.filter(
      (r) => r.data_type === "timestamp without time zone",
    );

    if (toConvert.length === 0) {
      log.log("All wellness timestamp columns already timestamptz; nothing to do");
      return;
    }

    await client.query("BEGIN");
    for (const r of toConvert) {
      // Existing naked-wall-clock values were written by `new Date()` whose
      // serialized form is the UTC instant. Tag them as UTC so the real-world
      // moment they represent is preserved across the type change.
      await client.query(
        `ALTER TABLE ${r.table_name} ALTER COLUMN ${r.column_name} TYPE timestamptz USING ${r.column_name} AT TIME ZONE 'UTC'`,
      );
      log.log(`Converted ${r.table_name}.${r.column_name} -> timestamptz`);
    }
    await client.query("COMMIT");
    log.log(`Wellness timestamptz migration complete (${toConvert.length} columns)`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
