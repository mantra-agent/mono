import { createLogger } from "./log";

const log = createLogger("TaskAssignmentSchema");
const MIGRATION_LOCK_KEY = "migration.task-assignment-schema.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

export async function ensureTaskAssignmentSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_subject_type TEXT`);
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_subject_id TEXT`);
    const placeholderAssignments = await client.query(`
      WITH cleared_tasks AS (
        UPDATE tasks
        SET assignee_subject_type = NULL,
            assignee_subject_id = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE assignee_subject_id = '__omit__'
        RETURNING id::text AS object_id
      )
      UPDATE object_grants AS object_grant
      SET revoked_at = CURRENT_TIMESTAMP
      FROM cleared_tasks
      WHERE object_grant.object_type = 'task'
        AND object_grant.object_id = cleared_tasks.object_id
        AND object_grant.subject_id = '__omit__'
        AND object_grant.revoked_at IS NULL
    `) as { rowCount?: number | null };
    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_assignee_subject_pair_check') THEN
          ALTER TABLE tasks ADD CONSTRAINT tasks_assignee_subject_pair_check CHECK (
            (assignee_subject_type IS NULL AND assignee_subject_id IS NULL)
            OR (assignee_subject_type IN ('user', 'invited_subject') AND NULLIF(BTRIM(assignee_subject_id), '') IS NOT NULL)
          );
        END IF;
      END $migration$
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_subject_type, assignee_subject_id)`);
    await client.query(`COMMENT ON COLUMN tasks.assignee_subject_type IS 'Human obligation subject type; independent of owner execution routing.'`);
    await client.query(`COMMENT ON COLUMN tasks.assignee_subject_id IS 'Human obligation subject id; assignment synchronizes a task-only write grant.'`);
    await client.query("COMMIT");
    log.info(`task assignment schema convergence complete placeholderGrantsRevoked=${placeholderAssignments.rowCount ?? 0}`);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
