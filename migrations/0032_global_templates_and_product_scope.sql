-- Step 6: global template/default layer + user-owned product surfaces.

-- Skills are global read-only defaults unless explicitly user-owned/customized.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'global';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS account_id TEXT;
UPDATE skills SET scope = 'global' WHERE scope IS NULL OR scope = 'user';
CREATE INDEX IF NOT EXISTS idx_skills_scope_owner ON skills(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_skills_account ON skills(account_id);

ALTER TABLE skill_scores ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE skill_scores ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_skill_scores_owner_scored ON skill_scores(owner_user_id, scored_at);
CREATE INDEX IF NOT EXISTS idx_skill_scores_account_scored ON skill_scores(account_id, scored_at);

ALTER TABLE skill_runs ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE skill_runs ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_skill_runs_owner_started ON skill_runs(owner_user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_skill_runs_account_started ON skill_runs(account_id, started_at);

ALTER TABLE skill_failure_dismissals ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE skill_failure_dismissals ADD COLUMN IF NOT EXISTS account_id TEXT;
DO $$ BEGIN
  ALTER TABLE skill_failure_dismissals DROP CONSTRAINT IF EXISTS skill_failure_dismissals_skill_name_unique;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_skill_failure_dismissals_owner ON skill_failure_dismissals(skill_name, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_skill_failure_dismissals_account ON skill_failure_dismissals(skill_name, account_id);

-- Thesis/prediction surface is personal.
ALTER TABLE theses ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE theses ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE theses ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_theses_scope_owner ON theses(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_theses_account ON theses(account_id);

-- Content queue is personal.
ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_content_queue_scope_owner ON content_queue(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_content_queue_account ON content_queue(account_id);

-- Thoughts are personal observations.
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_thoughts_scope_owner ON thoughts(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_thoughts_account ON thoughts(account_id);

-- Hooks are either system/global templates or user-owned automations.
ALTER TABLE system_hooks ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE system_hooks ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE system_hooks ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_system_hooks_scope_owner ON system_hooks(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_system_hooks_account ON system_hooks(account_id);

-- Landscape radar config/feed is user-owned by default.
ALTER TABLE signal_sources ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE signal_sources ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE signal_sources ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_signal_sources_scope_owner ON signal_sources(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_signal_sources_account ON signal_sources(account_id);

ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_signal_items_scope_owner ON signal_items(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_signal_items_account ON signal_items(account_id);

ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE scan_runs ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_scan_runs_scope_owner ON scan_runs(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_scan_runs_account ON scan_runs(account_id);

-- Intention stack is Agent-owned per user, not global.
ALTER TABLE intentions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE intentions ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE intentions ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_intentions_scope_owner ON intentions(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_intentions_account ON intentions(account_id);

ALTER TABLE parked_ideas ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE parked_ideas ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE parked_ideas ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_parked_ideas_scope_owner ON parked_ideas(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_parked_ideas_account ON parked_ideas(account_id);
