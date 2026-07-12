ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
CREATE INDEX IF NOT EXISTS idx_signal_items_snoozed_until ON signal_items(snoozed_until);
