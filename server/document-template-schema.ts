import { sql } from "drizzle-orm";
import { db } from "./db";

export async function ensureDocumentTemplateSchema(): Promise<void> {
  await db.execute(sql`
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
    )
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS document_templates_global_id_key
      ON document_templates(id)
      WHERE scope = 'global'
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS document_templates_account_id_key
      ON document_templates(account_id, id)
      WHERE scope = 'user' AND account_id IS NOT NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_document_templates_scope_owner
      ON document_templates(scope, owner_user_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_document_templates_account
      ON document_templates(account_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_document_templates_page
      ON document_templates(page_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_document_templates_status
      ON document_templates(status)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS skill_template_bindings (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      skill_id VARCHAR NOT NULL,
      key VARCHAR(32) NOT NULL,
      template_id VARCHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT skill_template_bindings_key_check CHECK (key IN ('spec', 'daily', 'weekly'))
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS skill_template_bindings_skill_key
      ON skill_template_bindings(skill_id, key)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_skill_template_bindings_template
      ON skill_template_bindings(template_id)
  `);
}
