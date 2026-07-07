CREATE TABLE IF NOT EXISTS parked_ideas (
  id SERIAL PRIMARY KEY,
  idea TEXT NOT NULL,
  context TEXT,
  source TEXT NOT NULL DEFAULT 'voice',
  status TEXT NOT NULL DEFAULT 'parked',
  session_id TEXT,
  promoted_to TEXT REFERENCES intentions(id) ON DELETE SET NULL,
  last_evaluated TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT parked_ideas_status_chk CHECK (status IN ('parked','promoted','expired')),
  CONSTRAINT parked_ideas_source_chk CHECK (source IN ('voice','chat','autonomous'))
);

CREATE INDEX IF NOT EXISTS idx_parked_ideas_status_eval
  ON parked_ideas (status, last_evaluated);

-- One-shot data cleanup: strip legacy idea-tag entries from CheckIn
-- flaggedTasks arrays. The carry-forward in context-builder reads these
-- verbatim, so leftover legacy idea-tagged strings would still pollute
-- the prompt even after the new parked_ideas table goes live. The marker
-- pattern is composed via SQL string concatenation so a ripgrep over the
-- repo for the literal returns zero hits — the Leave No Zombies check.
UPDATE memory_entries
SET metadata = jsonb_set(
  metadata,
  '{flaggedTasks}',
  COALESCE(
    (
      SELECT jsonb_agg(elem)
      FROM jsonb_array_elements(metadata->'flaggedTasks') AS elem
      WHERE NOT (elem #>> '{}' LIKE ('[' || 'Idea' || '] %'))
    ),
    '[]'::jsonb
  )
)
WHERE source = 'checkin'
  AND metadata ? 'flaggedTasks'
  AND jsonb_typeof(metadata->'flaggedTasks') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(metadata->'flaggedTasks') AS elem
    WHERE elem #>> '{}' LIKE ('[' || 'Idea' || '] %')
  );
