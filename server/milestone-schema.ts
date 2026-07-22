import { createLogger } from "./log";

const log = createLogger("MilestoneSchema");
const MIGRATION_LOCK_KEY = "migration.milestones-schema.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;

export async function ensureMilestonesSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS milestones (
        id INTEGER NOT NULL,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        vault_id TEXT REFERENCES vaults(id) ON DELETE SET NULL,
        owner_user_id TEXT,
        account_id TEXT,
        scope TEXT NOT NULL DEFAULT 'user',
        created_by_user_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        start_date TEXT,
        due_date TEXT,
        display_order INTEGER NOT NULL DEFAULT 0,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_id, id)
      )
    `);

    const columns = [
      ["id", "INTEGER"],
      ["project_id", "INTEGER"],
      ["vault_id", "TEXT"],
      ["owner_user_id", "TEXT"],
      ["account_id", "TEXT"],
      ["scope", "TEXT DEFAULT 'user'"],
      ["created_by_user_id", "TEXT"],
      ["name", "TEXT"],
      ["status", "TEXT DEFAULT 'planned'"],
      ["start_date", "TEXT"],
      ["due_date", "TEXT"],
      ["display_order", "INTEGER DEFAULT 0"],
      ["completed_at", "TIMESTAMPTZ"],
      ["created_at", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"],
      ["updated_at", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"],
    ] as const;
    for (const [name, type] of columns) {
      await client.query(`ALTER TABLE milestones ADD COLUMN IF NOT EXISTS ${quoteIdentifier(name)} ${type}`);
    }

    await client.query(`
      UPDATE milestones AS milestone
      SET
        vault_id = CASE WHEN milestone.vault_id IS NULL OR EXISTS (
          SELECT 1 FROM vaults WHERE vaults.id = milestone.vault_id
        ) THEN milestone.vault_id ELSE NULL END,
        owner_user_id = COALESCE(milestone.owner_user_id, project.owner_user_id),
        account_id = COALESCE(milestone.account_id, project.account_id),
        scope = COALESCE(NULLIF(milestone.scope, ''), project.scope, 'user'),
        created_by_user_id = COALESCE(milestone.created_by_user_id, project.owner_user_id),
        name = COALESCE(NULLIF(milestone.name, ''), 'Unnamed'),
        status = CASE milestone.status WHEN 'active' THEN 'active' WHEN 'completed' THEN 'completed' ELSE 'planned' END,
        display_order = COALESCE(milestone.display_order, 0),
        created_at = COALESCE(milestone.created_at, project.created_at, CURRENT_TIMESTAMP),
        updated_at = COALESCE(milestone.updated_at, project.updated_at, CURRENT_TIMESTAMP)
      FROM projects AS project
      WHERE project.id = milestone.project_id
    `);

    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uk_milestones_project_id ON milestones(project_id, id)`);

    await client.query(`
      INSERT INTO milestones (
        id, project_id, owner_user_id, account_id, scope, created_by_user_id,
        name, status, start_date, due_date, display_order, completed_at, created_at, updated_at
      )
      SELECT
        (entry.value->>'id')::INTEGER,
        project.id,
        project.owner_user_id,
        project.account_id,
        project.scope,
        project.owner_user_id,
        COALESCE(NULLIF(entry.value->>'name', ''), 'Unnamed'),
        CASE entry.value->>'status' WHEN 'active' THEN 'active' WHEN 'completed' THEN 'completed' ELSE 'planned' END,
        NULLIF(entry.value->>'startDate', ''),
        NULLIF(entry.value->>'dueDate', ''),
        CASE WHEN (entry.value->>'order') ~ '^-?[0-9]+$' THEN (entry.value->>'order')::INTEGER ELSE entry.ordinality::INTEGER - 1 END,
        CASE WHEN (entry.value->>'completedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (entry.value->>'completedAt')::TIMESTAMPTZ ELSE NULL END,
        project.created_at,
        project.updated_at
      FROM projects AS project
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(project.milestones) = 'array' THEN project.milestones ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS entry(value, ordinality)
      WHERE jsonb_typeof(entry.value) = 'object'
        AND entry.value ? 'id'
        AND (entry.value->>'id') ~ '^[0-9]+$'
      ON CONFLICT (project_id, id) DO NOTHING
    `);

    await client.query(`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM milestones AS milestone
          LEFT JOIN projects AS project ON project.id = milestone.project_id
          WHERE milestone.id IS NULL OR milestone.project_id IS NULL OR project.id IS NULL
        ) THEN
          RAISE EXCEPTION 'milestones schema convergence found invalid rows';
        END IF;
      END $migration$
    `);
    await client.query(`
      ALTER TABLE milestones
        ALTER COLUMN id SET NOT NULL,
        ALTER COLUMN project_id SET NOT NULL,
        ALTER COLUMN scope SET DEFAULT 'user', ALTER COLUMN scope SET NOT NULL,
        ALTER COLUMN name SET NOT NULL,
        ALTER COLUMN status SET DEFAULT 'planned', ALTER COLUMN status SET NOT NULL,
        ALTER COLUMN display_order SET DEFAULT 0, ALTER COLUMN display_order SET NOT NULL,
        ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP, ALTER COLUMN created_at SET NOT NULL,
        ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP, ALTER COLUMN updated_at SET NOT NULL
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uk_milestones_project_id ON milestones(project_id, id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_milestones_project_order ON milestones(project_id, display_order, id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_milestones_scope_owner ON milestones(scope, owner_user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_milestones_account ON milestones(account_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_milestones_vault ON milestones(vault_id)`);
    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname IN ('milestones_project_id_projects_id_fk', 'milestones_project_id_fkey')
            AND conrelid = 'milestones'::regclass
        ) THEN
          ALTER TABLE milestones ADD CONSTRAINT milestones_project_id_projects_id_fk
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname IN ('milestones_vault_id_vaults_id_fk', 'milestones_vault_id_fkey')
            AND conrelid = 'milestones'::regclass
        ) THEN
          ALTER TABLE milestones ADD CONSTRAINT milestones_vault_id_vaults_id_fk
          FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'milestones_status_check'
            AND conrelid = 'milestones'::regclass
        ) THEN
          ALTER TABLE milestones ADD CONSTRAINT milestones_status_check
          CHECK (status IN ('planned', 'active', 'completed'));
        END IF;
      END $migration$
    `);

    await client.query(`
      UPDATE tasks AS task
      SET milestone_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE task.milestone_id IS NOT NULL AND (
        task.project_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM milestones AS milestone
          WHERE milestone.project_id = task.project_id AND milestone.id = task.milestone_id
        )
      )
    `);
    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'tasks_project_milestone_fkey'
            AND conrelid = 'tasks'::regclass
        ) THEN
          ALTER TABLE tasks ADD CONSTRAINT tasks_project_milestone_fkey
          FOREIGN KEY (project_id, milestone_id)
          REFERENCES milestones(project_id, id)
          ON DELETE SET NULL (milestone_id);
        END IF;
      END $migration$
    `);
    await client.query(`COMMENT ON COLUMN projects.milestones IS 'DEPRECATED: canonical milestones live in milestones table; remove after one release, target 2026-08-05'`);
    await client.query(`COMMENT ON TABLE milestones IS 'Canonical project milestones. Numeric id is project-local and unique with project_id.'`);
    await client.query("COMMIT");
    log.log("milestones schema convergence complete");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}
