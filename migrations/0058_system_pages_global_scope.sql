-- Mark System folder library pages as scope='global' so all users can read them.
-- System pages are product docs (CODING.md, DESIGN.md, BRAND.md, INTRO.md, PLANNING.md, etc.)
-- and should be visible to every user. The System folder itself is also marked global.
--
-- The System folder is identified by title 'System' with no parent (root-level).
-- System pages are all direct children of the System folder.
-- This is idempotent: running it again has no effect on already-global pages.

DO $$
DECLARE
  system_folder_id TEXT;
BEGIN
  -- Find the System folder (root-level page titled 'System')
  SELECT id INTO system_folder_id
  FROM library_pages
  WHERE title = 'System' AND parent_id IS NULL
  LIMIT 1;

  IF system_folder_id IS NULL THEN
    RAISE NOTICE 'No System folder found — skipping global scope migration';
    RETURN;
  END IF;

  -- Mark the System folder itself as global
  UPDATE library_pages
  SET scope = 'global'
  WHERE id = system_folder_id AND scope != 'global';

  -- Mark all direct children of the System folder as global
  UPDATE library_pages
  SET scope = 'global'
  WHERE parent_id = system_folder_id AND scope != 'global';

  RAISE NOTICE 'System folder and children marked as scope=global';
END $$;
