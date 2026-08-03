-- Canonical relational Tag source of truth.
-- Additive and replay-safe. Legacy JSON and entity tag arrays remain migration inputs only.
CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'global', 'system')),
  slug TEXT NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80),
  description TEXT NOT NULL DEFAULT '',
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, slug),
  UNIQUE (id, account_id)
);

CREATE TABLE IF NOT EXISTS tag_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id UUID NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'global', 'system')),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL CHECK (normalized_alias = lower(normalized_alias) AND normalized_alias ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tag_id, account_id) REFERENCES tags(id, account_id) ON DELETE CASCADE,
  UNIQUE (account_id, normalized_alias)
);

CREATE TABLE IF NOT EXISTS tag_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id UUID NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_user_id VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'global', 'system')),
  object_type TEXT NOT NULL CHECK (length(btrim(object_type)) BETWEEN 1 AND 80),
  object_id TEXT NOT NULL CHECK (length(btrim(object_id)) BETWEEN 1 AND 512),
  object_title TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit', 'legacy_array', 'legacy_registry', 'migration')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tag_id, account_id) REFERENCES tags(id, account_id) ON DELETE CASCADE,
  UNIQUE (account_id, tag_id, object_type, object_id)
);

CREATE TABLE IF NOT EXISTS tag_migrations (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  migration_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'skipped', 'ambiguous')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, migration_key)
);

CREATE INDEX IF NOT EXISTS idx_tags_account_updated ON tags(account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tag_aliases_tag ON tag_aliases(account_id, tag_id);
CREATE INDEX IF NOT EXISTS idx_tag_assignments_object ON tag_assignments(account_id, object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_tag_assignments_tag ON tag_assignments(account_id, tag_id);
CREATE INDEX IF NOT EXISTS idx_tag_assignments_owner ON tag_assignments(owner_user_id);
