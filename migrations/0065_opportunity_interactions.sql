ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user';
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS account_id TEXT;
UPDATE opportunities SET owner_user_id = user_id WHERE owner_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_opportunities_scope_owner ON opportunities(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_account ON opportunities(account_id);

CREATE TABLE IF NOT EXISTS opportunity_interactions (
  id SERIAL PRIMARY KEY,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_opportunity_interaction UNIQUE(opportunity_id, person_id, interaction_id)
);
CREATE INDEX IF NOT EXISTS idx_opportunity_interactions_opportunity ON opportunity_interactions(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_opportunity_interactions_interaction ON opportunity_interactions(person_id, interaction_id);
CREATE INDEX IF NOT EXISTS idx_opportunity_interactions_scope_owner ON opportunity_interactions(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_opportunity_interactions_account ON opportunity_interactions(account_id);
