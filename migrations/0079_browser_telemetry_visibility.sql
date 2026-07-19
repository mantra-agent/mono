-- Add visibility column to browser_performance_telemetry
-- Tracks whether the page was visible or backgrounded at the time of measurement.
-- NULL = row predates visibility tagging (legacy, treated per-metric in application layer).
ALTER TABLE browser_performance_telemetry ADD COLUMN IF NOT EXISTS visibility TEXT;

-- Index to enable efficient filtering by visibility when computing percentiles.
CREATE INDEX IF NOT EXISTS idx_browser_perf_visibility ON browser_performance_telemetry(visibility, kind, received_at);
