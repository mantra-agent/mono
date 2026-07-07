-- Repair scoped-table drift for environments that missed parts of 0030/0032.
-- Safe/idempotent. These columns are referenced by shared schemas and scoped storage predicates.

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sessions',
    'messages',
    'workspace_documents',
    'memory_entries',
    'memory_entity_links',
    'info_notes',
    'library_pages',
    'library_page_links',
    'library_annotations',
    'library_page_views',
    'emotional_states',
    'intentions',
    'parked_ideas',
    'system_hooks',
    'theses'
  ] LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT %L', table_name, 'user');
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS owner_user_id TEXT', table_name);
      EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS account_id TEXT', table_name);
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  index_repair TEXT[];
  table_name TEXT;
  index_repairs TEXT[][] := ARRAY[
    ARRAY['sessions', 'CREATE INDEX IF NOT EXISTS idx_sessions_scope_owner ON sessions(scope, owner_user_id)'],
    ARRAY['sessions', 'CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)'],
    ARRAY['messages', 'CREATE INDEX IF NOT EXISTS idx_messages_scope_owner ON messages(scope, owner_user_id)'],
    ARRAY['messages', 'CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id)'],
    ARRAY['workspace_documents', 'CREATE INDEX IF NOT EXISTS idx_ws_doc_scope_owner ON workspace_documents(scope, owner_user_id)'],
    ARRAY['workspace_documents', 'CREATE INDEX IF NOT EXISTS idx_ws_doc_account ON workspace_documents(account_id)'],
    ARRAY['memory_entries', 'CREATE INDEX IF NOT EXISTS idx_memory_scope_owner ON memory_entries(scope, owner_user_id)'],
    ARRAY['memory_entries', 'CREATE INDEX IF NOT EXISTS idx_memory_account ON memory_entries(account_id)'],
    ARRAY['memory_entity_links', 'CREATE INDEX IF NOT EXISTS idx_memory_entity_links_scope_owner ON memory_entity_links(scope, owner_user_id)'],
    ARRAY['memory_entity_links', 'CREATE INDEX IF NOT EXISTS idx_memory_entity_links_account ON memory_entity_links(account_id)'],
    ARRAY['info_notes', 'CREATE INDEX IF NOT EXISTS idx_info_notes_scope_owner ON info_notes(scope, owner_user_id)'],
    ARRAY['info_notes', 'CREATE INDEX IF NOT EXISTS idx_info_notes_account ON info_notes(account_id)'],
    ARRAY['library_pages', 'CREATE INDEX IF NOT EXISTS idx_library_pages_scope_owner ON library_pages(scope, owner_user_id)'],
    ARRAY['library_pages', 'CREATE INDEX IF NOT EXISTS idx_library_pages_account ON library_pages(account_id)'],
    ARRAY['library_page_links', 'CREATE INDEX IF NOT EXISTS idx_library_page_links_scope_owner ON library_page_links(scope, owner_user_id)'],
    ARRAY['library_page_links', 'CREATE INDEX IF NOT EXISTS idx_library_page_links_account ON library_page_links(account_id)'],
    ARRAY['library_annotations', 'CREATE INDEX IF NOT EXISTS idx_library_annotations_scope_owner ON library_annotations(scope, owner_user_id)'],
    ARRAY['library_annotations', 'CREATE INDEX IF NOT EXISTS idx_library_annotations_account ON library_annotations(account_id)'],
    ARRAY['library_page_views', 'CREATE INDEX IF NOT EXISTS idx_library_page_views_scope_owner ON library_page_views(scope, owner_user_id)'],
    ARRAY['library_page_views', 'CREATE INDEX IF NOT EXISTS idx_library_page_views_account ON library_page_views(account_id)'],
    ARRAY['emotional_states', 'CREATE INDEX IF NOT EXISTS idx_emotional_states_scope_owner ON emotional_states(scope, owner_user_id)'],
    ARRAY['emotional_states', 'CREATE INDEX IF NOT EXISTS idx_emotional_states_account ON emotional_states(account_id)'],
    ARRAY['intentions', 'CREATE INDEX IF NOT EXISTS idx_intentions_scope_owner ON intentions(scope, owner_user_id)'],
    ARRAY['intentions', 'CREATE INDEX IF NOT EXISTS idx_intentions_account ON intentions(account_id)'],
    ARRAY['parked_ideas', 'CREATE INDEX IF NOT EXISTS idx_parked_ideas_scope_owner ON parked_ideas(scope, owner_user_id)'],
    ARRAY['parked_ideas', 'CREATE INDEX IF NOT EXISTS idx_parked_ideas_account ON parked_ideas(account_id)'],
    ARRAY['system_hooks', 'CREATE INDEX IF NOT EXISTS idx_system_hooks_scope_owner ON system_hooks(scope, owner_user_id)'],
    ARRAY['system_hooks', 'CREATE INDEX IF NOT EXISTS idx_system_hooks_account ON system_hooks(account_id)'],
    ARRAY['theses', 'CREATE INDEX IF NOT EXISTS idx_theses_scope_owner ON theses(scope, owner_user_id)'],
    ARRAY['theses', 'CREATE INDEX IF NOT EXISTS idx_theses_account ON theses(account_id)']
  ];
BEGIN
  FOREACH index_repair SLICE 1 IN ARRAY index_repairs LOOP
    table_name := index_repair[1];
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE index_repair[2];
    END IF;
  END LOOP;
END $$;
