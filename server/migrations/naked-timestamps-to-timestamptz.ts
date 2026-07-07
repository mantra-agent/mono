import { pool } from "../db";
import { createLogger } from "../log";
import { MANAGED_TABLES } from "./managed-tables";

export { MANAGED_TABLES };

const log = createLogger("Migration:NakedTimestamptz");

/**
 * Audit & boot-heal migration: convert every `timestamp without time zone`
 * column on our managed tables to `timestamptz`.
 *
 * Why: Drizzle's `timestamp(...)` (without `withTimezone: true`) maps to
 * Postgres `timestamp WITHOUT time zone`. When the server writes
 * `new Date()` (a real UTC instant) into such a column, pg-node serializes
 * it as a naked wall-clock string. On read, that wall-clock is reinterpreted
 * under `process.env.TZ`, shifting the value by the user's UTC offset.
 *
 * Once shifted, comparisons against `userDayBounds` / `userDateStr`
 * (in `server/utils/user-time.ts`) and frontend "Today / Yesterday"
 * relative-date renders land on the wrong day.
 *
 * Task #858 fixed the four wellness tables. Task #862 generalizes the fix
 * across every other naked-timestamp column we own. The conversion is
 * lossless because the existing wall-clock values are exactly the UTC
 * instants the writer intended (`new Date().toISOString()`); tagging them
 * `AT TIME ZONE 'UTC'` recovers the original instant.
 *
 * The list of tables is the union of every `pgTable(...)` in
 * `shared/schema.ts` and `shared/models/*.ts` (audit performed manually,
 * 2026-04-23). Tables that don't exist yet at migration time are skipped.
 */
export async function runNakedTimestamptzMigration(): Promise<void> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type = 'timestamp without time zone'
         AND table_name = ANY($1::text[])`,
      [MANAGED_TABLES],
    );

    if (rows.length === 0) {
      log.log("No naked timestamp columns found on managed tables; nothing to do");
      return;
    }

    await client.query("BEGIN");
    for (const r of rows) {
      // Existing naked-wall-clock values were written by `new Date()` whose
      // serialized form is the UTC instant. Tag them as UTC so the real-world
      // moment they represent is preserved across the type change.
      await client.query(
        `ALTER TABLE ${r.table_name} ALTER COLUMN ${r.column_name} TYPE timestamptz USING ${r.column_name} AT TIME ZONE 'UTC'`,
      );
      log.log(`Converted ${r.table_name}.${r.column_name} -> timestamptz`);
    }
    await client.query("COMMIT");
    log.log(`Naked timestamptz migration complete (${rows.length} columns)`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
