-- Canonical many-to-many Person-to-Vault membership. Additive and replay-safe.
CREATE TABLE IF NOT EXISTS person_vault_memberships (
  person_id TEXT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (person_id, vault_id)
);

CREATE INDEX IF NOT EXISTS idx_person_vault_memberships_vault_person
  ON person_vault_memberships(vault_id, person_id);
CREATE INDEX IF NOT EXISTS idx_person_vault_memberships_scope_owner
  ON person_vault_memberships(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_person_vault_memberships_account
  ON person_vault_memberships(account_id);

-- Preserve existing behavior. Prefer a Person's valid legacy vault, then the
-- account's live default Vault, then its first live Vault by stable order.
INSERT INTO person_vault_memberships (
  person_id,
  vault_id,
  scope,
  owner_user_id,
  account_id,
  created_by_user_id
)
SELECT
  p.id,
  chosen.vault_id,
  'user',
  p.owner_user_id,
  p.account_id,
  p.owner_user_id
FROM persons p
CROSS JOIN LATERAL (
  SELECT v.id AS vault_id
  FROM vaults v
  WHERE v.account_id = p.account_id
    AND v.is_archived = FALSE
  ORDER BY
    CASE WHEN v.id = p.vault_id THEN 0 ELSE 1 END,
    CASE WHEN v.is_default THEN 0 ELSE 1 END,
    v.position,
    v.created_at,
    v.id
  LIMIT 1
) chosen
WHERE p.scope = 'user'
  AND p.owner_user_id IS NOT NULL
  AND p.account_id IS NOT NULL
ON CONFLICT (person_id, vault_id) DO NOTHING;
