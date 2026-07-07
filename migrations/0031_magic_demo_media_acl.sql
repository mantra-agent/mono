-- Step 5: Magic Demo/media owner-scoped ACL foundation.
-- Additive and idempotent. Legacy unowned rows remain inaccessible to normal users
-- unless explicitly backfilled with owner/account information.

ALTER TABLE magic_demo_sessions
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT,
  ADD COLUMN IF NOT EXISTS account_id TEXT,
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_by_user_id TEXT;

UPDATE magic_demo_sessions
SET owner_user_id = user_id
WHERE owner_user_id IS NULL AND user_id IS NOT NULL;

UPDATE magic_demo_sessions s
SET account_id = a.id
FROM accounts a
WHERE s.account_id IS NULL
  AND a.kind = 'personal'
  AND a.owner_user_id = s.owner_user_id;

ALTER TABLE magic_demo_sessions
  ALTER COLUMN owner_user_id SET NOT NULL,
  ALTER COLUMN account_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_magic_demo_sessions_owner_created ON magic_demo_sessions(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_magic_demo_sessions_account_created ON magic_demo_sessions(account_id, created_at);

ALTER TABLE magic_demo_session_events
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT,
  ADD COLUMN IF NOT EXISTS account_id TEXT,
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT;

UPDATE magic_demo_session_events e
SET owner_user_id = s.owner_user_id,
    account_id = s.account_id,
    created_by_user_id = COALESCE(e.created_by_user_id, s.owner_user_id)
FROM magic_demo_sessions s
WHERE e.session_id = s.id
  AND (e.owner_user_id IS NULL OR e.account_id IS NULL OR e.created_by_user_id IS NULL);

ALTER TABLE magic_demo_session_events
  ALTER COLUMN owner_user_id SET NOT NULL,
  ALTER COLUMN account_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_magic_demo_events_owner_created ON magic_demo_session_events(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_magic_demo_events_account_created ON magic_demo_session_events(account_id, created_at);

ALTER TABLE magic_demo_vision_frames
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT,
  ADD COLUMN IF NOT EXISTS account_id TEXT,
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT;

UPDATE magic_demo_vision_frames f
SET owner_user_id = s.owner_user_id,
    account_id = s.account_id,
    created_by_user_id = COALESCE(f.created_by_user_id, s.owner_user_id)
FROM magic_demo_sessions s
WHERE f.session_id = s.id
  AND (f.owner_user_id IS NULL OR f.account_id IS NULL OR f.created_by_user_id IS NULL);

ALTER TABLE magic_demo_vision_frames
  ALTER COLUMN owner_user_id SET NOT NULL,
  ALTER COLUMN account_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_magic_demo_vision_frames_owner_created ON magic_demo_vision_frames(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_magic_demo_vision_frames_account_created ON magic_demo_vision_frames(account_id, created_at);

ALTER TABLE media_items
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT,
  ADD COLUMN IF NOT EXISTS account_id TEXT,
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_by_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_media_items_owner_created ON media_items(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_media_items_account_created ON media_items(account_id, created_at);

ALTER TABLE render_jobs
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS owner_user_id TEXT,
  ADD COLUMN IF NOT EXISTS account_id TEXT,
  ADD COLUMN IF NOT EXISTS created_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_by_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_render_jobs_owner_created ON render_jobs(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_render_jobs_account_created ON render_jobs(account_id, created_at);
