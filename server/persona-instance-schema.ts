import { createLogger } from "./log";

const log = createLogger("PersonaInstanceSchema");
const MIGRATION_LOCK_KEY = "migration.persona-instance-ownership.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>>; rowCount?: number }>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

/**
 * Phase 2 mind seam: stamp personas + affect with pinned Agent Instance.
 *
 * Additive only:
 * - nullable instance_id on personas, persona_revisions, persona_preferences, emotional_states
 * - backfill from agent_instance_memberships (owner_user_id + account_id)
 * - leave instance_id null when no pin so rows stay owner-visible
 *
 * Dual-write/read lives in scoped-storage + PersonaStorage / emotional-state.
 * Do not empty tables. Do not move timers, skills, runtime, or conversations.
 */
export async function ensurePersonaInstanceOwnershipSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);

    const tables = [
      "personas",
      "persona_revisions",
      "persona_preferences",
      "emotional_states",
    ] as const;

    for (const table of tables) {
      const exists = await client.query(
        `SELECT to_regclass('public.${table}') IS NOT NULL AS present`,
      );
      if (!exists.rows?.[0]?.present) continue;

      await client.query(`
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS instance_id VARCHAR
      `);

      await client.query(`
        DO $migration$
        BEGIN
          IF to_regclass('public.agent_instances') IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = '${table}_instance_id_fkey'
          ) THEN
            ALTER TABLE ${table}
              ADD CONSTRAINT ${table}_instance_id_fkey
              FOREIGN KEY (instance_id) REFERENCES agent_instances(id) ON DELETE SET NULL;
          END IF;
        END
        $migration$
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_${table}_instance
          ON ${table}(instance_id)
      `);
    }

    // Backfill from the writer's Account pin. Leave null when no membership.
    const backfillSpecs: Array<{ table: string; ownerColumn: string; accountColumn: string }> = [
      { table: "personas", ownerColumn: "owner_user_id", accountColumn: "account_id" },
      { table: "persona_revisions", ownerColumn: "owner_user_id", accountColumn: "account_id" },
      { table: "persona_preferences", ownerColumn: "owner_user_id", accountColumn: "account_id" },
      { table: "emotional_states", ownerColumn: "owner_user_id", accountColumn: "account_id" },
    ];

    const counts: Record<string, number> = {};
    for (const spec of backfillSpecs) {
      const present = await client.query(
        `SELECT to_regclass('public.${spec.table}') IS NOT NULL AS present`,
      );
      if (!present.rows?.[0]?.present) {
        counts[spec.table] = 0;
        continue;
      }
      const result = await client.query(`
        UPDATE ${spec.table} t
        SET instance_id = m.instance_id
        FROM agent_instance_memberships m
        WHERE t.instance_id IS NULL
          AND t.${spec.ownerColumn} IS NOT NULL
          AND t.${spec.accountColumn} IS NOT NULL
          AND m.user_id = t.${spec.ownerColumn}
          AND m.account_id = t.${spec.accountColumn}
      `);
      counts[spec.table] = result.rowCount ?? 0;
    }

    log.info("persona/affect instance ownership convergence complete", counts);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
