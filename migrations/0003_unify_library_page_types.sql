-- Add tags and status columns
ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS status TEXT;

-- Migrate spec rows: copy metadata.status to status column, set tags to ["spec"]
UPDATE library_pages
SET tags = ARRAY['spec'],
    status = COALESCE((metadata->>'status'), 'draft')
WHERE type = 'spec';

-- Migrate folder rows: set tags to ["folder"]
UPDATE library_pages
SET tags = ARRAY['folder']
WHERE type = 'folder';

-- Drop type index, then drop type and metadata columns
DROP INDEX IF EXISTS idx_library_pages_type;
ALTER TABLE library_pages DROP COLUMN IF EXISTS type;
ALTER TABLE library_pages DROP COLUMN IF EXISTS metadata;
