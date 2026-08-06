import { pool } from "../db";
import { createLogger } from "../log";

const log = createLogger("EnsureToolOutputAdmissions");

/**
 * Idempotent bootstrap for principal-scoped tool-output pressure telemetry.
 *
 * Migration 0116 defined the table, but live boot only runs selected TS ensures.
 * Without this, inserts are swallowed and pressure ranking fails with 42P01.
 */
export async function ensureToolOutputAdmissionsTable(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tool_output_admissions (
        id serial PRIMARY KEY NOT NULL,
        owner_account_id varchar NOT NULL,
        owner_user_id varchar NOT NULL,
        session_id varchar,
        run_id varchar,
        tool_call_id varchar,
        tool_name varchar NOT NULL,
        action varchar DEFAULT '' NOT NULL,
        disposition varchar NOT NULL,
        raw_chars integer NOT NULL,
        raw_tokens integer NOT NULL,
        injected_chars integer NOT NULL,
        injected_tokens integer NOT NULL,
        created_at timestamp with time zone DEFAULT now() NOT NULL
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS tool_output_admissions_owner_time_idx
      ON tool_output_admissions USING btree (owner_account_id, owner_user_id, created_at)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS tool_output_admissions_owner_tool_idx
      ON tool_output_admissions USING btree (owner_account_id, owner_user_id, tool_name, action)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS tool_output_admissions_owner_run_idx
      ON tool_output_admissions USING btree (owner_account_id, owner_user_id, run_id)
    `);
    log.log("Ensured tool_output_admissions table exists");
  } catch (err) {
    log.error("Failed to ensure tool_output_admissions table", err);
  }
}
