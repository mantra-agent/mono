ALTER TABLE plan_session_links
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_session_links_one_pinned_per_session
  ON plan_session_links(session_id)
  WHERE unlinked_at IS NULL AND pinned_at IS NOT NULL;
