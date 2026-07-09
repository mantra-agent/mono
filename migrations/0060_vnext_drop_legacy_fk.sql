-- Drop the FK constraint from memory_vnext_claims.source_memory_id → memory_entries.id.
-- The column remains as a nullable integer for extraction budget scoping,
-- but provenance is canonically tracked via memory_vnext_sources (source refs).
-- Sentinel value 0 (used by the poller to fake independence) is converted to NULL.

-- Step 1: Drop the FK constraint
ALTER TABLE memory_vnext_claims
  DROP CONSTRAINT IF EXISTS memory_vnext_claims_source_memory_id_memory_entries_id_fk;

-- Step 2: Convert sentinel 0 values to NULL
UPDATE memory_vnext_claims
  SET source_memory_id = NULL
  WHERE source_memory_id = 0;
