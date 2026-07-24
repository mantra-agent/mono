-- Version persona bundle defaults so existing user copies can inherit curated
-- defaults exactly once while later user edits remain authoritative.
ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS bundle_defaults_version INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN personas.bundle_defaults_version IS
  'Last curated persona bundle defaults version applied. User edits remain authoritative after initialization.';
