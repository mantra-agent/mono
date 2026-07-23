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
  CONSTRAINT milestones_pkey PRIMARY KEY (project_id, id),
  CONSTRAINT milestones_status_check CHECK (status IN ('planned', 'active', 'completed'))
);

-- The composite primary key supplies uniqueness and the task FK lookup index.
CREATE INDEX IF NOT EXISTS idx_milestones_project_order
  ON milestones(project_id, display_order, id);
CREATE INDEX IF NOT EXISTS idx_milestones_scope_owner
  ON milestones(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_milestones_account
  ON milestones(account_id);
CREATE INDEX IF NOT EXISTS idx_milestones_vault
  ON milestones(vault_id);

-- Additive backfill from deprecated projects.milestones JSON during initial migration.
-- Runtime convergence records adoption and never replays this rollback-only source afterward.
-- IDs remain project-local because tasks identify a milestone together with project_id.
INSERT INTO milestones (
  id,
  project_id,
  vault_id,
  owner_user_id,
  account_id,
  scope,
  created_by_user_id,
  name,
  status,
  start_date,
  due_date,
  display_order,
  completed_at,
  created_at,
  updated_at
)
SELECT
  (entry.value->>'id')::INTEGER,
  project.id,
  NULL,
  project.owner_user_id,
  project.account_id,
  project.scope,
  project.owner_user_id,
  COALESCE(NULLIF(entry.value->>'name', ''), 'Unnamed'),
  CASE entry.value->>'status'
    WHEN 'active' THEN 'active'
    WHEN 'completed' THEN 'completed'
    ELSE 'planned'
  END,
  NULLIF(entry.value->>'startDate', ''),
  NULLIF(entry.value->>'dueDate', ''),
  CASE
    WHEN (entry.value->>'order') ~ '^-?[0-9]+$' THEN (entry.value->>'order')::INTEGER
    ELSE entry.ordinality::INTEGER - 1
  END,
  CASE
    WHEN (entry.value->>'completedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (entry.value->>'completedAt')::TIMESTAMPTZ
    ELSE NULL
  END,
  project.created_at,
  project.updated_at
FROM projects project
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(project.milestones) = 'array' THEN project.milestones ELSE '[]'::jsonb END
) WITH ORDINALITY AS entry(value, ordinality)
WHERE jsonb_typeof(entry.value) = 'object'
  AND entry.value ? 'id'
  AND (entry.value->>'id') ~ '^[0-9]+$'
ON CONFLICT (project_id, id) DO NOTHING;

-- Clear malformed legacy references before adding structural integrity.
UPDATE tasks task
SET milestone_id = NULL,
    updated_at = CURRENT_TIMESTAMP
WHERE task.milestone_id IS NOT NULL
  AND (
    task.project_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM milestones milestone
      WHERE milestone.project_id = task.project_id
        AND milestone.id = task.milestone_id
    )
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_project_milestone_fkey'
      AND conrelid = 'tasks'::regclass
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_project_milestone_fkey
      FOREIGN KEY (project_id, milestone_id)
      REFERENCES milestones(project_id, id)
      ON DELETE SET NULL (milestone_id);
  END IF;
END $migration$;

-- projects.milestones is intentionally retained, read-inactive, for one release.
-- Removal target: 2026-08-05 after rollback compatibility has elapsed.
COMMENT ON COLUMN projects.milestones IS
  'DEPRECATED: rollback-only snapshot; canonical milestones live in milestones table; never replay after adoption; remove after one release, target 2026-08-05';
COMMENT ON TABLE milestones IS
  'Canonical project milestones. Numeric id is project-local and unique with project_id.';
