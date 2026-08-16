import { createLogger } from "./log";

const log = createLogger("TimerSkillInstanceSchema");
const MIGRATION_LOCK_KEY = "migration.timer-skill-instance-ownership.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>>; rowCount?: number }>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

/**
 * Phase 2 mind seam: stamp live Timers and Skills with the pinned Agent Instance.
 *
 * Additive only:
 * - nullable instance_id on timers, responsibility_runs, skills, skill_revisions, skill_runs
 * - backfill from agent_instance_memberships (owner_user_id + account_id)
 * - leave instance_id null when no pin so rows stay owner-visible
 *
 * Mods still own seeds/defaults/lifecycle. Users still own authorship, overlays,
 * credentials, and delivery. Uniqueness stays owner-scoped during the dual-write
 * window. Do not empty tables. Do not move runtime or conversations.
 */
export async function ensureTimerSkillInstanceOwnershipSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);

    const tables = [
      "timers",
      "responsibility_runs",
      "skills",
      "skill_revisions",
      "skill_runs",
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

    const backfillSpecs: Array<{ table: string; ownerColumn: string; accountColumn: string }> = [
      { table: "timers", ownerColumn: "owner_user_id", accountColumn: "account_id" },
      { table: "responsibility_runs", ownerColumn: "owner_user_id", accountColumn: "account_id" },
      { table: "skills", ownerColumn: "owner_user_id", accountColumn: "account_id" },
      { table: "skill_revisions", ownerColumn: "owner_user_id", accountColumn: "account_id" },
      { table: "skill_runs", ownerColumn: "owner_user_id", accountColumn: "account_id" },
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

    log.info("timer/skill instance ownership convergence complete", counts);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
