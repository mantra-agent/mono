ALTER TABLE calendar_event_metadata
  ADD COLUMN IF NOT EXISTS agenda TEXT;
