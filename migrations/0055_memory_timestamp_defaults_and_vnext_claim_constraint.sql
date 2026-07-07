-- Repair production timestamp defaults for legacy memory/thought paths and ensure vNext claim upsert has its structural conflict target.

ALTER TABLE memory_content_blocks
  ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;

UPDATE memory_content_blocks
SET created_at = CURRENT_TIMESTAMP
WHERE created_at IS NULL;

ALTER TABLE memory_events
  ALTER COLUMN occurred_at SET DEFAULT CURRENT_TIMESTAMP;

UPDATE memory_events
SET occurred_at = CURRENT_TIMESTAMP
WHERE occurred_at IS NULL;

ALTER TABLE thoughts
  ALTER COLUMN occurred_at SET DEFAULT CURRENT_TIMESTAMP;

UPDATE thoughts
SET occurred_at = CURRENT_TIMESTAMP
WHERE occurred_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uk_memory_vnext_claim_content_hash'
      AND conrelid = 'memory_vnext_claims'::regclass
  ) THEN
    ALTER TABLE memory_vnext_claims
      ADD CONSTRAINT uk_memory_vnext_claim_content_hash UNIQUE (content_hash);
  END IF;
END $$;
