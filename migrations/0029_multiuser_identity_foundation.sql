CREATE TABLE IF NOT EXISTS accounts (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL DEFAULT 'personal',
  name TEXT NOT NULL,
  owner_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_accounts_kind ON accounts(kind);
CREATE INDEX IF NOT EXISTS idx_accounts_owner_user ON accounts(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_kind_owner_unique ON accounts(kind, owner_user_id);

CREATE TABLE IF NOT EXISTS memberships (
  id SERIAL PRIMARY KEY,
  account_id VARCHAR NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_account_user_unique ON memberships(account_id, user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_account ON memberships(account_id);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id VARCHAR PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_id VARCHAR REFERENCES accounts(id) ON DELETE SET NULL,
  display_name TEXT,
  preferred_name TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  onboarding_status TEXT NOT NULL DEFAULT 'not_started',
  memory_consent BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_user_profiles_account ON user_profiles(account_id);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id VARCHAR REFERENCES accounts(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL DEFAULT 'Agent',
  relationship_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_user_unique ON agent_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_profiles_account ON agent_profiles(account_id);

CREATE TABLE IF NOT EXISTS privileged_access_audit (
  id SERIAL PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  actor_account_id VARCHAR REFERENCES accounts(id) ON DELETE SET NULL,
  impersonated_user_id VARCHAR REFERENCES users(id) ON DELETE SET NULL,
  impersonated_account_id VARCHAR REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  reason TEXT,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_privileged_access_actor ON privileged_access_audit(actor_type, actor_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_privileged_access_impersonated ON privileged_access_audit(impersonated_user_id, created_at);
