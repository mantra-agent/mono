ALTER TABLE memory_vnext_claims
  ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS expected_by TIMESTAMPTZ(6);

ALTER TABLE memory_vnext_sources
  ADD COLUMN IF NOT EXISTS clarity REAL,
  ADD COLUMN IF NOT EXISTS certainty REAL,
  ADD COLUMN IF NOT EXISTS source_observed_at TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS source_lineage_key TEXT,
  ADD COLUMN IF NOT EXISTS independence TEXT,
  ADD COLUMN IF NOT EXISTS producer_method TEXT,
  ADD COLUMN IF NOT EXISTS derivation_version TEXT,
  ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE memory_vnext_claim_links
  ADD COLUMN IF NOT EXISTS certainty REAL,
  ADD COLUMN IF NOT EXISTS producer_method TEXT,
  ADD COLUMN IF NOT EXISTS derivation_version TEXT,
  ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_source_clarity_bounded') THEN
    ALTER TABLE memory_vnext_sources ADD CONSTRAINT memory_vnext_source_clarity_bounded CHECK (clarity IS NULL OR (clarity >= 0 AND clarity <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_source_certainty_bounded') THEN
    ALTER TABLE memory_vnext_sources ADD CONSTRAINT memory_vnext_source_certainty_bounded CHECK (certainty IS NULL OR (certainty >= 0 AND certainty <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_source_independence_valid') THEN
    ALTER TABLE memory_vnext_sources ADD CONSTRAINT memory_vnext_source_independence_valid CHECK (independence IS NULL OR independence IN ('same_lineage', 'independent', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_claim_link_certainty_bounded') THEN
    ALTER TABLE memory_vnext_claim_links ADD CONSTRAINT memory_vnext_claim_link_certainty_bounded CHECK (certainty IS NULL OR (certainty >= 0 AND certainty <= 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_claim_validity_window') THEN
    ALTER TABLE memory_vnext_claims ADD CONSTRAINT memory_vnext_claim_validity_window CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_applicability
  ON memory_vnext_claims(valid_from, valid_until, expected_by);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_source_lineage
  ON memory_vnext_sources(claim_id, source_lineage_key);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_source_evidence
  ON memory_vnext_sources(claim_id, relationship, clarity, certainty);

COMMENT ON COLUMN memory_vnext_claims.confidence IS
  'Extraction-confidence compatibility data only. Claim certainty is derived independently from assessed evidence.';
COMMENT ON COLUMN memory_vnext_sources.strength IS
  'Legacy compatibility field. Source clarity and relationship certainty are independent evidence dimensions.';
COMMENT ON COLUMN memory_vnext_claim_links.strength IS
  'Legacy compatibility field. Relationship certainty is stored separately.';
