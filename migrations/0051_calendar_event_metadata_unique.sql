-- Calendar event metadata is upserted by (google_event_id, account_id, calendar_id).
-- Older databases could have the table without the corresponding unique index, causing
-- ON CONFLICT to fail with: no unique or exclusion constraint matching the ON CONFLICT specification.

DO $migration$
BEGIN
  IF to_regclass('public.calendar_event_metadata') IS NOT NULL THEN
    IF to_regclass('public.calendar_event_artifacts') IS NOT NULL THEN
      WITH ranked AS (
        SELECT
          id,
          MIN(id) OVER (PARTITION BY google_event_id, account_id, calendar_id) AS keep_id,
          ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
        FROM calendar_event_metadata
      ), duplicate_links AS (
        SELECT id, keep_id
        FROM ranked
        WHERE rn > 1
      )
      DELETE FROM calendar_event_artifacts artifact
      USING duplicate_links
      WHERE artifact.metadata_id = duplicate_links.id
        AND EXISTS (
          SELECT 1
          FROM calendar_event_artifacts kept
          WHERE kept.metadata_id = duplicate_links.keep_id
            AND kept.library_page_id = artifact.library_page_id
        );

      WITH ranked AS (
        SELECT
          id,
          MIN(id) OVER (PARTITION BY google_event_id, account_id, calendar_id) AS keep_id,
          ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
        FROM calendar_event_metadata
      ), duplicate_links AS (
        SELECT id, keep_id
        FROM ranked
        WHERE rn > 1
      )
      UPDATE calendar_event_artifacts artifact
      SET metadata_id = duplicate_links.keep_id
      FROM duplicate_links
      WHERE artifact.metadata_id = duplicate_links.id;
    END IF;

    IF to_regclass('public.calendar_event_people') IS NOT NULL THEN
      WITH ranked AS (
        SELECT
          id,
          MIN(id) OVER (PARTITION BY google_event_id, account_id, calendar_id) AS keep_id,
          ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
        FROM calendar_event_metadata
      ), duplicate_links AS (
        SELECT id, keep_id
        FROM ranked
        WHERE rn > 1
      )
      DELETE FROM calendar_event_people person
      USING duplicate_links
      WHERE person.metadata_id = duplicate_links.id
        AND EXISTS (
          SELECT 1
          FROM calendar_event_people kept
          WHERE kept.metadata_id = duplicate_links.keep_id
            AND kept.person_id = person.person_id
        );

      WITH ranked AS (
        SELECT
          id,
          MIN(id) OVER (PARTITION BY google_event_id, account_id, calendar_id) AS keep_id,
          ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
        FROM calendar_event_metadata
      ), duplicate_links AS (
        SELECT id, keep_id
        FROM ranked
        WHERE rn > 1
      )
      UPDATE calendar_event_people person
      SET metadata_id = duplicate_links.keep_id
      FROM duplicate_links
      WHERE person.metadata_id = duplicate_links.id;
    END IF;

    IF to_regclass('public.calendar_event_tasks') IS NOT NULL THEN
      WITH ranked AS (
        SELECT
          id,
          MIN(id) OVER (PARTITION BY google_event_id, account_id, calendar_id) AS keep_id,
          ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
        FROM calendar_event_metadata
      ), duplicate_links AS (
        SELECT id, keep_id
        FROM ranked
        WHERE rn > 1
      )
      DELETE FROM calendar_event_tasks task
      USING duplicate_links
      WHERE task.metadata_id = duplicate_links.id
        AND (
          (task.task_id IS NOT NULL AND EXISTS (
            SELECT 1
            FROM calendar_event_tasks kept
            WHERE kept.metadata_id = duplicate_links.keep_id
              AND kept.task_id = task.task_id
          ))
          OR
          (task.priority_title IS NOT NULL AND EXISTS (
            SELECT 1
            FROM calendar_event_tasks kept
            WHERE kept.metadata_id = duplicate_links.keep_id
              AND kept.priority_title = task.priority_title
          ))
        );

      WITH ranked AS (
        SELECT
          id,
          MIN(id) OVER (PARTITION BY google_event_id, account_id, calendar_id) AS keep_id,
          ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
        FROM calendar_event_metadata
      ), duplicate_links AS (
        SELECT id, keep_id
        FROM ranked
        WHERE rn > 1
      )
      UPDATE calendar_event_tasks task
      SET metadata_id = duplicate_links.keep_id
      FROM duplicate_links
      WHERE task.metadata_id = duplicate_links.id;
    END IF;

    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (PARTITION BY google_event_id, account_id, calendar_id ORDER BY id) AS rn
      FROM calendar_event_metadata
    )
    DELETE FROM calendar_event_metadata metadata
    USING ranked
    WHERE metadata.id = ranked.id
      AND ranked.rn > 1;

    ALTER TABLE calendar_event_metadata ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE calendar_event_metadata ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
    UPDATE calendar_event_metadata SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
    UPDATE calendar_event_metadata SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;

    IF to_regclass('public.calendar_event_artifacts') IS NOT NULL THEN
      ALTER TABLE calendar_event_artifacts ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE calendar_event_artifacts ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
      UPDATE calendar_event_artifacts SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
      UPDATE calendar_event_artifacts SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
    END IF;

    IF to_regclass('public.calendar_event_tasks') IS NOT NULL THEN
      ALTER TABLE calendar_event_tasks ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE calendar_event_tasks ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
      UPDATE calendar_event_tasks SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
      UPDATE calendar_event_tasks SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
    END IF;

    IF to_regclass('public.calendar_event_people') IS NOT NULL THEN
      ALTER TABLE calendar_event_people ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE calendar_event_people ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;
      UPDATE calendar_event_people SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
      UPDATE calendar_event_people SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;
    END IF;

    CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_metadata_event_account_calendar_unique
      ON calendar_event_metadata(google_event_id, account_id, calendar_id);
  END IF;
END $migration$;
