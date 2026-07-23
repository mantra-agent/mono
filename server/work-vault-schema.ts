import { createLogger } from "./log";

const log = createLogger("WorkVaultSchema");
const MIGRATION_LOCK_KEY = "migration.work-vault-schema.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>>; rowCount?: number | null }>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

async function convergeParentWorkVaults(client: QueryableClient): Promise<void> {
  await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS vault_id TEXT`);
  await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS vault_id TEXT`);

  await client.query(`
    UPDATE projects AS work
    SET vault_id = (
      SELECT vault.id
      FROM vaults AS vault
      WHERE vault.account_id = work.account_id
      ORDER BY vault.is_default DESC, vault.position ASC, vault.created_at ASC, vault.id ASC
      LIMIT 1
    )
    WHERE work.vault_id IS NULL
  `);
  await client.query(`
    UPDATE tasks AS work
    SET vault_id = (
      SELECT vault.id
      FROM vaults AS vault
      WHERE vault.account_id = work.account_id
      ORDER BY vault.is_default DESC, vault.position ASC, vault.created_at ASC, vault.id ASC
      LIMIT 1
    )
    WHERE work.vault_id IS NULL
  `);
  await client.query(`
    UPDATE tasks AS task
    SET vault_id = project.vault_id
    FROM projects AS project
    WHERE task.project_id = project.id
      AND task.vault_id IS DISTINCT FROM project.vault_id
  `);

  const unresolved = await client.query(`
    SELECT
      (SELECT count(*)::int FROM projects WHERE vault_id IS NULL) AS projects,
      (SELECT count(*)::int FROM tasks WHERE vault_id IS NULL) AS tasks
  `);
  const counts = unresolved.rows?.[0] ?? {};
  const unresolvedCount = Number(counts.projects ?? 0) + Number(counts.tasks ?? 0);
  if (unresolvedCount > 0) {
    throw new Error(`Parent work vault convergence found unresolved rows: ${JSON.stringify(counts)}`);
  }

  await client.query(`
    ALTER TABLE projects ALTER COLUMN vault_id SET NOT NULL;
    ALTER TABLE tasks ALTER COLUMN vault_id SET NOT NULL
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_projects_vault ON projects(vault_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_tasks_vault ON tasks(vault_id)`);
  await client.query(`
    DO $migration$
    DECLARE
      constraint_record RECORD;
    BEGIN
      FOR constraint_record IN
        SELECT constraint_row.conname, constraint_row.conrelid::regclass AS relation_name
        FROM pg_constraint AS constraint_row
        WHERE constraint_row.contype = 'f'
          AND constraint_row.confrelid = 'vaults'::regclass
          AND constraint_row.conrelid IN ('projects'::regclass, 'tasks'::regclass)
          AND constraint_row.confdeltype <> 'r'
          AND EXISTS (
            SELECT 1
            FROM unnest(constraint_row.conkey) AS key(attnum)
            JOIN pg_attribute AS attribute
              ON attribute.attrelid = constraint_row.conrelid
             AND attribute.attnum = key.attnum
            WHERE attribute.attname = 'vault_id'
          )
      LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_record.relation_name, constraint_record.conname);
      END LOOP;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname IN ('projects_vault_id_vaults_id_fk', 'projects_vault_id_fkey')
          AND conrelid = 'projects'::regclass
      ) THEN
        ALTER TABLE projects ADD CONSTRAINT projects_vault_id_vaults_id_fk
        FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname IN ('tasks_vault_id_vaults_id_fk', 'tasks_vault_id_fkey')
          AND conrelid = 'tasks'::regclass
      ) THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_vault_id_vaults_id_fk
        FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE RESTRICT;
      END IF;
    END $migration$
  `);

  await client.query(`COMMENT ON COLUMN projects.vault_id IS 'Container and inheritance anchor only. Never grants project visibility.'`);
  await client.query(`COMMENT ON COLUMN tasks.vault_id IS 'Container and inheritance anchor only. Never grants task visibility.'`);
}

export async function ensureWorkVaultParentSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);
    await convergeParentWorkVaults(client);
    await client.query("COMMIT");
    log.info("parent work vault schema convergence complete");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureWorkVaultSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);
    await convergeParentWorkVaults(client);

    await client.query(`
      UPDATE milestones AS milestone
      SET vault_id = project.vault_id
      FROM projects AS project
      WHERE project.id = milestone.project_id
        AND milestone.vault_id IS DISTINCT FROM project.vault_id
    `);

    const unresolved = await client.query(`
      SELECT count(*)::int AS milestones
      FROM milestones
      WHERE vault_id IS NULL
    `);
    const counts = unresolved.rows?.[0] ?? {};
    if (Number(counts.milestones ?? 0) > 0) {
      throw new Error(`Milestone vault convergence found unresolved rows: ${JSON.stringify(counts)}`);
    }

    await client.query(`ALTER TABLE milestones ALTER COLUMN vault_id SET NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_milestones_vault ON milestones(vault_id)`);
    await client.query(`
      DO $migration$
      DECLARE
        constraint_record RECORD;
      BEGIN
        FOR constraint_record IN
          SELECT constraint_row.conname, constraint_row.conrelid::regclass AS relation_name
          FROM pg_constraint AS constraint_row
          WHERE constraint_row.contype = 'f'
            AND constraint_row.confrelid = 'vaults'::regclass
            AND constraint_row.conrelid = 'milestones'::regclass
            AND constraint_row.confdeltype <> 'r'
            AND EXISTS (
              SELECT 1
              FROM unnest(constraint_row.conkey) AS key(attnum)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = constraint_row.conrelid
               AND attribute.attnum = key.attnum
              WHERE attribute.attname = 'vault_id'
            )
        LOOP
          EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_record.relation_name, constraint_record.conname);
        END LOOP;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname IN ('milestones_vault_id_vaults_id_fk', 'milestones_vault_id_fkey')
            AND conrelid = 'milestones'::regclass
        ) THEN
          ALTER TABLE milestones ADD CONSTRAINT milestones_vault_id_vaults_id_fk
          FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE RESTRICT;
        END IF;
      END $migration$
    `);

    await client.query(`COMMENT ON COLUMN milestones.vault_id IS 'Container and inheritance anchor only. Never grants milestone visibility.'`);

    await client.query("COMMIT");
    log.info("work vault schema convergence complete");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
