-- Canonical many-to-many Project-to-Vault membership. Additive and replay-safe.
-- projects.vault_id remains the migration-compatible primary/default Vault;
-- this relation becomes the owner visibility authority.
CREATE TABLE IF NOT EXISTS project_vault_memberships (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, vault_id)
);

CREATE INDEX IF NOT EXISTS idx_project_vault_memberships_vault_project
  ON project_vault_memberships(vault_id, project_id);
CREATE INDEX IF NOT EXISTS idx_project_vault_memberships_scope_owner
  ON project_vault_memberships(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_project_vault_memberships_account
  ON project_vault_memberships(account_id);

-- Preserve every existing Project in its current live projects.vault_id. The
-- work-vault convergence migration already guarantees this column is non-null.
INSERT INTO project_vault_memberships (
  project_id,
  vault_id,
  scope,
  owner_user_id,
  account_id,
  created_by_user_id
)
SELECT
  project.id,
  project.vault_id,
  'user',
  project.owner_user_id,
  project.account_id,
  project.owner_user_id
FROM projects AS project
JOIN vaults AS vault
  ON vault.id = project.vault_id
 AND vault.account_id = project.account_id
 AND vault.is_archived = FALSE
WHERE project.scope = 'user'
  AND project.owner_user_id IS NOT NULL
  AND project.account_id IS NOT NULL
ON CONFLICT (project_id, vault_id) DO NOTHING;

DO $migration$
DECLARE
  unresolved_projects INTEGER;
BEGIN
  SELECT count(*) INTO unresolved_projects
  FROM projects AS project
  WHERE project.scope = 'user'
    AND project.owner_user_id IS NOT NULL
    AND project.account_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM project_vault_memberships AS membership
      JOIN vaults AS vault
        ON vault.id = membership.vault_id
       AND vault.account_id = project.account_id
       AND vault.is_archived = FALSE
      WHERE membership.project_id = project.id
        AND membership.owner_user_id = project.owner_user_id
        AND membership.account_id = project.account_id
    );
  IF unresolved_projects > 0 THEN
    RAISE EXCEPTION 'Project Vault membership convergence unresolved projects=%', unresolved_projects;
  END IF;
END $migration$;

COMMENT ON TABLE project_vault_memberships IS 'Canonical live Project-to-Vault membership and owner visibility authority.';
COMMENT ON COLUMN projects.vault_id IS 'Migration-compatible primary/default Vault; project_vault_memberships owns Project visibility.';
