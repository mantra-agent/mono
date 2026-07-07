import { pool } from "../db";
import { createLogger } from "../log";

const log = createLogger("MigrateEmotionalNarrative");

export async function migrateAddNarrativeToEmotionalStates(): Promise<void> {
  const client = await pool.connect();
  try {
    const colCheck: any = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'emotional_states' AND column_name = 'narrative'
    `);

    if (colCheck.rows.length === 0) {
      await client.query(`ALTER TABLE emotional_states ADD COLUMN narrative text`);
      log.log("Added narrative column to emotional_states");
    } else {
      log.log("narrative column already exists on emotional_states");
    }
  } finally {
    client.release();
  }
}
