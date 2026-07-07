ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'page';
ALTER TABLE library_pages ADD COLUMN IF NOT EXISTS metadata JSONB;
CREATE INDEX IF NOT EXISTS idx_library_pages_type ON library_pages(type);
