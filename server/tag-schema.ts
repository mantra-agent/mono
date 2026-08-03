import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "./db";
import { createLogger } from "./log";

const log = createLogger("TagSchema");
const MIGRATION_LOCK_KEY = "migration.canonical-tags.v1";

/** Additive, replay-safe convergence for the canonical relational Tag store. */
export async function ensureCanonicalTagSchema(): Promise<void> {
  const startedAt = Date.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);
    const migrationPath = fileURLToPath(new URL("../migrations/0120_canonical_tags.sql", import.meta.url));
    const sql = await readFile(migrationPath, "utf8");
    await client.query(sql);
    await client.query("COMMIT");
    log.info("canonical Tag schema converged", { durationMs: Date.now() - startedAt });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    log.error("canonical Tag schema convergence failed", { error, durationMs: Date.now() - startedAt });
    throw error;
  } finally {
    client.release();
  }
}
