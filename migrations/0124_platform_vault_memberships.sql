-- Canonical many-to-many Platform-to-Vault membership. Additive and replay-safe.
-- platforms.vault_id remains the migration-compatible primary/default Vault;
-- this relation becomes the owner visibility source of truth.

ALTER TABLE platforms
  ADD COLUMN IF NOT EXISTS vault_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'platforms_vault_id_vaults_id_fk'
  ) THEN
    ALTER TABLE platforms
      ADD CONSTRAINT platforms_vault_id_vaults_id_fk
      FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_platforms_vault ON platforms (vault_id);

CREATE TABLE IF NOT EXISTS platform_vault_memberships (
  id serial PRIMARY KEY,
  platform_id integer NOT NULL REFERENCES platforms(id) ON DELETE CASCADE,
  vault_id text NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
  scope text NOT NULL DEFAULT 'user',
  owner_user_id varchar,
  account_id varchar,
  created_by_user_id varchar,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_vault_memberships_platform_vault_unique UNIQUE (platform_id, vault_id)
);

CREATE INDEX IF NOT EXISTS idx_platform_vault_memberships_platform
  ON platform_vault_memberships (platform_id);
CREATE INDEX IF NOT EXISTS idx_platform_vault_memberships_vault_platform
  ON platform_vault_memberships (vault_id, platform_id);
CREATE INDEX IF NOT EXISTS idx_platform_vault_memberships_scope_owner
  ON platform_vault_memberships (scope, owner_user_id, account_id);

-- Seed primary vault from the owning account default vault when missing.
-- vaults.is_default is the canonical discriminant; vaults has no kind column.
UPDATE platforms p
SET vault_id = v.id
FROM vaults v
WHERE p.vault_id IS NULL
  AND p.account_id IS NOT NULL
  AND v.account_id = p.account_id
  AND v.is_default = true
  AND v.is_archived = false;

-- Fallback: any live vault in the same account.
-- DISTINCT ON subquery (not LATERAL referencing UPDATE target alias p).
UPDATE platforms p
SET vault_id = v.vault_id
FROM (
  SELECT DISTINCT ON (account_id)
    account_id,
    id AS vault_id
  FROM vaults
  WHERE is_archived = false
  ORDER BY
    account_id,
    CASE WHEN is_default = true THEN 0 ELSE 1 END,
    position ASC NULLS LAST,
    created_at ASC
) v
WHERE p.vault_id IS NULL
  AND p.account_id IS NOT NULL
  AND v.account_id = p.account_id;

-- Seed memberships from platforms.vault_id for rows that still lack membership.
-- platforms ownership columns are owner_user_id/account_id (no created_by_user_id).
INSERT INTO platform_vault_memberships (
  platform_id,
  vault_id,
  scope,
  owner_user_id,
  account_id,
  created_by_user_id
)
SELECT
  p.id,
  p.vault_id,
  COALESCE(p.scope, 'user'),
  p.owner_user_id,
  p.account_id,
  p.owner_user_id
FROM platforms p
WHERE p.vault_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM platform_vault_memberships m
    WHERE m.platform_id = p.id
  )
ON CONFLICT (platform_id, vault_id) DO NOTHING;

COMMENT ON COLUMN platforms.vault_id IS
  'Migration-compatible primary/default Vault; platform_vault_memberships owns Platform visibility.';
