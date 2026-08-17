-- Document Template Shapes: id → Library page map + skill key bindings.
-- Spec @page:4475da53-c8ab-4a81-8321-66d8fd84aebc / @feature:e18a142d-3fa0-45fc-b47f-03d009b68f80

CREATE TABLE IF NOT EXISTS document_templates (
  row_id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  id VARCHAR(64) NOT NULL,
  name TEXT NOT NULL,
  page_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  scope TEXT NOT NULL DEFAULT 'global',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT document_templates_scope_check CHECK (scope IN ('global', 'user')),
  CONSTRAINT document_templates_status_check CHECK (status IN ('active', 'deprecated')),
  CONSTRAINT document_templates_global_owner_check CHECK (
    (scope = 'global' AND owner_user_id IS NULL AND account_id IS NULL)
    OR (scope = 'user' AND owner_user_id IS NOT NULL AND account_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS document_templates_global_id_key
  ON document_templates(id)
  WHERE scope = 'global';

CREATE UNIQUE INDEX IF NOT EXISTS document_templates_account_id_key
  ON document_templates(account_id, id)
  WHERE scope = 'user' AND account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_templates_scope_owner
  ON document_templates(scope, owner_user_id);

CREATE INDEX IF NOT EXISTS idx_document_templates_account
  ON document_templates(account_id);

CREATE INDEX IF NOT EXISTS idx_document_templates_page
  ON document_templates(page_id);

CREATE INDEX IF NOT EXISTS idx_document_templates_status
  ON document_templates(status);

CREATE TABLE IF NOT EXISTS skill_template_bindings (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id VARCHAR NOT NULL,
  key VARCHAR(32) NOT NULL,
  template_id VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT skill_template_bindings_key_check CHECK (key IN ('spec', 'daily', 'weekly'))
);

CREATE UNIQUE INDEX IF NOT EXISTS skill_template_bindings_skill_key
  ON skill_template_bindings(skill_id, key);

CREATE INDEX IF NOT EXISTS idx_skill_template_bindings_template
  ON skill_template_bindings(template_id);
