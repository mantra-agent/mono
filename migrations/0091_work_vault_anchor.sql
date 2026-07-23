-- P1: vault-anchor work objects without changing their visibility semantics.
-- vault_id is a container and inheritance anchor only. Owner/account scope and
-- explicit object grants remain the sole access authority for work.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS vault_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS vault_id TEXT;

UPDATE projects AS work
SET vault_id = (
  SELECT vault.id
  FROM vaults AS vault
  WHERE vault.account_id = work.account_id
  ORDER BY vault.is_default DESC, vault.position ASC, vault.created_at ASC, vault.id ASC
  LIMIT 1
)
WHERE work.vault_id IS NULL;

UPDATE tasks AS work
SET vault_id = (
  SELECT vault.id
  FROM vaults AS vault
  WHERE vault.account_id = work.account_id
  ORDER BY vault.is_default DESC, vault.position ASC, vault.created_at ASC, vault.id ASC
  LIMIT 1
)
WHERE work.vault_id IS NULL;

UPDATE milestones AS milestone
SET vault_id = project.vault_id
FROM projects AS project
WHERE project.id = milestone.project_id
  AND milestone.vault_id IS NULL;

DO $migration$
DECLARE
  unresolved_projects INTEGER;
  unresolved_tasks INTEGER;
  unresolved_milestones INTEGER;
BEGIN
  SELECT count(*) INTO unresolved_projects FROM projects WHERE vault_id IS NULL;
  SELECT count(*) INTO unresolved_tasks FROM tasks WHERE vault_id IS NULL;
  SELECT count(*) INTO unresolved_milestones FROM milestones WHERE vault_id IS NULL;
  IF unresolved_projects + unresolved_tasks + unresolved_milestones > 0 THEN
    RAISE EXCEPTION 'Work vault convergence unresolved projects=%, tasks=%, milestones=%',
      unresolved_projects, unresolved_tasks, unresolved_milestones;
  END IF;
END $migration$;

ALTER TABLE projects ALTER COLUMN vault_id SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN vault_id SET NOT NULL;
ALTER TABLE milestones ALTER COLUMN vault_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_vault ON projects(vault_id);
CREATE INDEX IF NOT EXISTS idx_tasks_vault ON tasks(vault_id);
CREATE INDEX IF NOT EXISTS idx_milestones_vault ON milestones(vault_id);

DO $migration$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT constraint_row.conname, constraint_row.conrelid::regclass AS relation_name
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'vaults'::regclass
      AND constraint_row.conrelid IN ('projects'::regclass, 'tasks'::regclass, 'milestones'::regclass)
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
END $migration$;

COMMENT ON COLUMN projects.vault_id IS 'Container and inheritance anchor only. Never grants project visibility.';
COMMENT ON COLUMN tasks.vault_id IS 'Container and inheritance anchor only. Never grants task visibility.';
COMMENT ON COLUMN milestones.vault_id IS 'Container and inheritance anchor only. Never grants milestone visibility.';
