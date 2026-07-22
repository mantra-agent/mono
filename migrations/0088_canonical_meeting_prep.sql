ALTER TABLE calendar_event_metadata
  ADD COLUMN IF NOT EXISTS agenda_library_page_id TEXT;

ALTER TABLE calendar_event_artifacts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'calendar_event_metadata_agenda_library_page_id_fkey'
      AND conrelid = 'calendar_event_metadata'::regclass
  ) THEN
    ALTER TABLE calendar_event_metadata
      ADD CONSTRAINT calendar_event_metadata_agenda_library_page_id_fkey
      FOREIGN KEY (agenda_library_page_id)
      REFERENCES library_pages(id)
      ON DELETE SET NULL;
  END IF;
END $migration$;

WITH ranked_prep AS (
  SELECT
    metadata_id,
    library_page_id,
    ROW_NUMBER() OVER (
      PARTITION BY metadata_id
      ORDER BY CASE artifact_kind WHEN 'agenda' THEN 0 ELSE 1 END, created_at, id
    ) AS rank
  FROM calendar_event_artifacts
  WHERE artifact_kind IN ('agenda', 'brief')
), chosen_prep AS (
  SELECT metadata_id, library_page_id
  FROM ranked_prep
  WHERE rank = 1
)
UPDATE calendar_event_metadata metadata
SET agenda_library_page_id = chosen.library_page_id,
    updated_at = CURRENT_TIMESTAMP
FROM chosen_prep chosen
WHERE metadata.id = chosen.metadata_id
  AND metadata.agenda_library_page_id IS NULL;

UPDATE calendar_event_artifacts artifact
SET artifact_kind = 'agenda',
    updated_at = CURRENT_TIMESTAMP
FROM calendar_event_metadata metadata
WHERE artifact.metadata_id = metadata.id
  AND artifact.library_page_id = metadata.agenda_library_page_id
  AND artifact.artifact_kind IN ('agenda', 'brief');

DELETE FROM calendar_event_artifacts artifact
USING calendar_event_metadata metadata
WHERE artifact.metadata_id = metadata.id
  AND artifact.artifact_kind IN ('agenda', 'brief')
  AND artifact.library_page_id <> metadata.agenda_library_page_id;

CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_artifacts_one_prep_per_meeting
  ON calendar_event_artifacts(metadata_id)
  WHERE artifact_kind IN ('agenda', 'brief');

ALTER TABLE calendar_event_artifacts
  ALTER COLUMN artifact_kind DROP DEFAULT;
