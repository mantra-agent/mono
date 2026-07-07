-- Step 3: scoped core personal substrate for chat, memory, library/info, and cognition.
-- Additive and idempotent. Existing rows are backfilled to Ray/admin personal account.

DO $$
DECLARE
  ray_user_id text;
  ray_account_id text;
BEGIN
  SELECT id INTO ray_user_id
  FROM users
  WHERE email = 'raymond.kallmeyer@gmail.com' OR role = 'admin'
  ORDER BY CASE WHEN email = 'raymond.kallmeyer@gmail.com' THEN 0 ELSE 1 END, created_at NULLS LAST
  LIMIT 1;

  IF ray_user_id IS NOT NULL THEN
    SELECT id INTO ray_account_id
    FROM accounts
    WHERE kind = 'personal' AND owner_user_id = ray_user_id
    LIMIT 1;

    IF ray_account_id IS NULL THEN
      INSERT INTO accounts (kind, name, owner_user_id)
      VALUES ('personal', 'Ray Personal Account', ray_user_id)
      ON CONFLICT (kind, owner_user_id) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      RETURNING id INTO ray_account_id;
    END IF;

    INSERT INTO memberships (account_id, user_id, role)
    VALUES (ray_account_id, ray_user_id, 'owner')
    ON CONFLICT (account_id, user_id) DO UPDATE SET role = 'owner', updated_at = CURRENT_TIMESTAMP;
  END IF;

  -- Add columns to all target tables.
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_by_user_id text;

  ALTER TABLE messages ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_by_user_id text;

  ALTER TABLE workspace_documents ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE workspace_documents ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE workspace_documents ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE workspace_documents ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE workspace_documents ADD COLUMN IF NOT EXISTS updated_by_user_id text;

  ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS updated_by_user_id text;

  ALTER TABLE memory_entity_links ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE memory_entity_links ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE memory_entity_links ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE memory_entity_links ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE memory_entity_links ADD COLUMN IF NOT EXISTS updated_by_user_id text;

  ALTER TABLE info_notes ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE info_notes ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE info_notes ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE info_notes ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE info_notes ADD COLUMN IF NOT EXISTS updated_by_user_id text;

  ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS updated_by_user_id text;

  ALTER TABLE library_page_links ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE library_page_links ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE library_page_links ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE library_page_links ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE library_page_links ADD COLUMN IF NOT EXISTS updated_by_user_id text;

  ALTER TABLE library_annotations ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE library_annotations ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE library_annotations ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE library_annotations ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE library_annotations ADD COLUMN IF NOT EXISTS updated_by_user_id text;

  ALTER TABLE library_page_views ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE library_page_views ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE library_page_views ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE library_page_views ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE library_page_views ADD COLUMN IF NOT EXISTS updated_by_user_id text;

  ALTER TABLE emotional_states ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE emotional_states ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE emotional_states ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE emotional_states ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE emotional_states ADD COLUMN IF NOT EXISTS updated_by_user_id text;

  ALTER TABLE personas ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'user';
  ALTER TABLE personas ADD COLUMN IF NOT EXISTS owner_user_id text;
  ALTER TABLE personas ADD COLUMN IF NOT EXISTS account_id text;
  ALTER TABLE personas ADD COLUMN IF NOT EXISTS created_by_user_id text;
  ALTER TABLE personas ADD COLUMN IF NOT EXISTS updated_by_user_id text;
  ALTER TABLE personas ADD COLUMN IF NOT EXISTS template_persona_id integer;

  -- Backfill existing private data to Ray/admin account. Seed personas are global templates.
  IF ray_user_id IS NOT NULL THEN
    UPDATE sessions SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
    UPDATE messages SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
    UPDATE workspace_documents SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
    UPDATE memory_entries SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
    UPDATE memory_entity_links SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
    UPDATE info_notes SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
    UPDATE library_pages SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
    UPDATE library_page_links SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
    UPDATE library_annotations SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
    UPDATE library_page_views SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
    UPDATE emotional_states SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
    UPDATE personas SET scope = 'global', owner_user_id = NULL, account_id = NULL WHERE source = 'seed' OR is_default = true;
    UPDATE personas SET owner_user_id = COALESCE(owner_user_id, ray_user_id), account_id = COALESCE(account_id, ray_account_id), created_by_user_id = COALESCE(created_by_user_id, ray_user_id) WHERE scope = 'user' AND owner_user_id IS NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_scope_owner ON sessions(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE INDEX IF NOT EXISTS idx_messages_scope_owner ON messages(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id);
CREATE INDEX IF NOT EXISTS idx_memory_scope_owner ON memory_entries(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_memory_account ON memory_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ws_doc_scope_owner ON workspace_documents(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_library_pages_scope_owner ON library_pages(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_library_pages_account ON library_pages(account_id);
CREATE INDEX IF NOT EXISTS idx_personas_scope_owner ON personas(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_emotional_states_scope_owner ON emotional_states(scope, owner_user_id);
