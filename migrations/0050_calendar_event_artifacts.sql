CREATE TABLE IF NOT EXISTS calendar_event_artifacts (
  id SERIAL PRIMARY KEY,
  metadata_id INTEGER NOT NULL REFERENCES calendar_event_metadata(id) ON DELETE CASCADE,
  owner_user_id TEXT,
  principal_account_id TEXT,
  artifact_type TEXT NOT NULL DEFAULT 'library_page',
  library_page_id TEXT NOT NULL REFERENCES library_pages(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL DEFAULT 'brief',
  title TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_artifacts_metadata_page_unique
  ON calendar_event_artifacts(metadata_id, library_page_id);
CREATE INDEX IF NOT EXISTS idx_calendar_event_artifacts_metadata
  ON calendar_event_artifacts(metadata_id);
CREATE INDEX IF NOT EXISTS idx_calendar_event_artifacts_owner
  ON calendar_event_artifacts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_calendar_event_artifacts_principal_account
  ON calendar_event_artifacts(principal_account_id);
