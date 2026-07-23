ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_subject_type TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_subject_id TEXT;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_assignee_subject_pair_check') THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_assignee_subject_pair_check CHECK (
      (assignee_subject_type IS NULL AND assignee_subject_id IS NULL)
      OR (assignee_subject_type IN ('user', 'invited_subject') AND NULLIF(BTRIM(assignee_subject_id), '') IS NOT NULL)
    );
  END IF;
END $migration$;

CREATE INDEX IF NOT EXISTS idx_tasks_assignee
  ON tasks(assignee_subject_type, assignee_subject_id);

COMMENT ON COLUMN tasks.assignee_subject_type IS 'Human obligation subject type; independent of owner execution routing.';
COMMENT ON COLUMN tasks.assignee_subject_id IS 'Human obligation subject id; assignment synchronizes a task-only write grant.';
