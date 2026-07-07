ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS curated_title text;
ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS curated_reason text;
ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS curation_status text NOT NULL DEFAULT 'unread';
ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS curation_score real;
ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS matched_topics text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE signal_items ADD COLUMN IF NOT EXISTS curated_at timestamptz;
