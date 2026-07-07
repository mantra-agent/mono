-- Repair runtime drift from multi-user scope rollout.
-- content_queue gained scoped columns in 0032, but some deployed DBs missed that migration.
ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE content_queue ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE INDEX IF NOT EXISTS idx_content_queue_scope_owner ON content_queue(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_content_queue_account ON content_queue(account_id);

-- Personas are now global templates plus owner-scoped copies. A global UNIQUE(name)
-- constraint prevents activating a seed/template persona by copying it for a scope.
ALTER TABLE personas ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE personas ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS template_persona_id INTEGER;
ALTER TABLE personas DROP CONSTRAINT IF EXISTS personas_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_global_name_unique ON personas (LOWER(name)) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_user_name_unique ON personas (owner_user_id, LOWER(name)) WHERE scope = 'user' AND owner_user_id IS NOT NULL;
