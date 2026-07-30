-- Additive speech-recognition control-plane foundation.
-- Existing capability bindings and meeting documents remain readable unchanged.
ALTER TABLE environment_capability_bindings
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_env_capability_bindings_speech_priority
  ON environment_capability_bindings(environment_id, capability_type, enabled, sort_order, id);

COMMENT ON COLUMN environment_capability_bindings.sort_order IS
  'Environment-local candidate priority; lower values are attempted first.';
