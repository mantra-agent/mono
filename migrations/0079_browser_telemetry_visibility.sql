-- Add visibility column to browser_performance_telemetry
-- Tracks whether the page was visible or backgrounded at the time of measurement.
-- NULL = row predates visibility tagging (legacy, treated per-metric in application layer).
ALTER TABLE browser_performance_telemetry ADD COLUMN IF NOT EXISTS visibility TEXT;
