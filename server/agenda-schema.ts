import { sql } from "drizzle-orm";
import { db } from "./db";

export async function ensureAgendaDefinitionSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agenda_definitions (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(80) NOT NULL,
      normalized_name VARCHAR(80) NOT NULL,
      description TEXT,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      reserved_key VARCHAR(64),
      scope TEXT NOT NULL DEFAULT 'user',
      owner_user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT agenda_definitions_scope_check CHECK (scope = 'user'),
      CONSTRAINT agenda_definitions_items_check CHECK (jsonb_typeof(items) = 'array')
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agenda_definitions_owner_name_key
      ON agenda_definitions(owner_user_id, account_id, normalized_name)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agenda_definitions_owner_reserved_key
      ON agenda_definitions(owner_user_id, account_id, reserved_key)
      WHERE reserved_key IS NOT NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_agenda_definitions_scope_owner
      ON agenda_definitions(scope, owner_user_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_agenda_definitions_account_updated
      ON agenda_definitions(account_id, updated_at DESC)
  `);
}
