ALTER TABLE calendar_event_metadata
  ADD COLUMN IF NOT EXISTS speaker_policy JSONB;
