ALTER TABLE memory_vnext_claim_links
  ADD COLUMN IF NOT EXISTS relationship_class TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS producer_kind TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS epistemic_status TEXT NOT NULL DEFAULT 'legacy_unassessed',
  ADD COLUMN IF NOT EXISTS edge_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_claim_link_class_valid') THEN
    ALTER TABLE memory_vnext_claim_links ADD CONSTRAINT memory_vnext_claim_link_class_valid
      CHECK (relationship_class IN ('semantic', 'evidence', 'temporal', 'causal', 'consolidation', 'legacy'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_claim_link_producer_valid') THEN
    ALTER TABLE memory_vnext_claim_links ADD CONSTRAINT memory_vnext_claim_link_producer_valid
      CHECK (producer_kind IN ('asserted', 'derived', 'legacy'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_claim_link_epistemic_valid') THEN
    ALTER TABLE memory_vnext_claim_links ADD CONSTRAINT memory_vnext_claim_link_epistemic_valid
      CHECK (epistemic_status IN ('observation', 'hypothesis', 'causal_hypothesis', 'legacy_unassessed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_claim_link_causal_hypothesis') THEN
    ALTER TABLE memory_vnext_claim_links ADD CONSTRAINT memory_vnext_claim_link_causal_hypothesis
      CHECK (relationship_class <> 'causal' OR epistemic_status = 'causal_hypothesis');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_claim_link_canonical_evidence') THEN
    ALTER TABLE memory_vnext_claim_links ADD CONSTRAINT memory_vnext_claim_link_canonical_evidence
      CHECK (producer_kind = 'legacy' OR (certainty IS NOT NULL AND provenance <> '{}'::jsonb));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_claim_link_derived_metadata') THEN
    ALTER TABLE memory_vnext_claim_links ADD CONSTRAINT memory_vnext_claim_link_derived_metadata
      CHECK (producer_kind <> 'derived' OR (producer_method IS NOT NULL AND derivation_version IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_vnext_claim_link_relationship_class') THEN
    ALTER TABLE memory_vnext_claim_links ADD CONSTRAINT memory_vnext_claim_link_relationship_class CHECK (
      relationship_class = 'legacy'
      OR (relationship_class = 'semantic' AND relationship IN ('equivalent_to', 'similar_to', 'qualifies'))
      OR (relationship_class = 'evidence' AND relationship IN ('supports', 'contradicts', 'supersedes'))
      OR (relationship_class = 'temporal' AND relationship IN ('precedes', 'followed_by', 'overlaps'))
      OR (relationship_class = 'causal' AND relationship IN ('explains', 'contributed_to', 'caused', 'prevented', 'resulted_in'))
      OR (relationship_class = 'consolidation' AND relationship IN ('consolidates', 'duplicate_of'))
    ) NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_claim_link_edge_key
  ON memory_vnext_claim_links(owner_user_id, account_id, edge_key)
  WHERE edge_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_links_class
  ON memory_vnext_claim_links(relationship_class, relationship);

CREATE TABLE IF NOT EXISTS memory_vnext_claim_link_evidence (
  id SERIAL PRIMARY KEY,
  claim_link_id INTEGER NOT NULL REFERENCES memory_vnext_claim_links(id) ON DELETE CASCADE,
  source_ref_id INTEGER NOT NULL REFERENCES memory_vnext_sources(id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'basis',
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_memory_vnext_claim_link_evidence UNIQUE (claim_link_id, source_ref_id, role),
  CONSTRAINT memory_vnext_claim_link_evidence_role_valid CHECK (role IN ('basis', 'counterexample', 'corroboration'))
);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_link_evidence_link ON memory_vnext_claim_link_evidence(claim_link_id);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_link_evidence_source ON memory_vnext_claim_link_evidence(source_ref_id);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_link_evidence_owner ON memory_vnext_claim_link_evidence(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_claim_link_evidence_account ON memory_vnext_claim_link_evidence(account_id);

CREATE TABLE IF NOT EXISTS memory_vnext_transition_paths (
  id SERIAL PRIMARY KEY,
  derivation_key TEXT NOT NULL,
  status TEXT NOT NULL,
  certainty REAL NOT NULL,
  elapsed_seconds INTEGER,
  context_keys TEXT[] NOT NULL DEFAULT '{}',
  entity_keys TEXT[] NOT NULL DEFAULT '{}',
  producer_method TEXT NOT NULL,
  derivation_version TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  updated_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT memory_vnext_transition_status_valid CHECK (status IN ('observed_transition', 'causal_hypothesis')),
  CONSTRAINT memory_vnext_transition_certainty_bounded CHECK (certainty >= 0 AND certainty <= 1),
  CONSTRAINT memory_vnext_transition_elapsed_nonnegative CHECK (elapsed_seconds IS NULL OR elapsed_seconds >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_memory_vnext_transition_derivation
  ON memory_vnext_transition_paths(owner_user_id, account_id, derivation_key);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_transition_owner ON memory_vnext_transition_paths(scope, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_transition_account ON memory_vnext_transition_paths(account_id);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_transition_method ON memory_vnext_transition_paths(producer_method, derivation_version);

CREATE TABLE IF NOT EXISTS memory_vnext_transition_members (
  id SERIAL PRIMARY KEY,
  transition_path_id INTEGER NOT NULL REFERENCES memory_vnext_transition_paths(id) ON DELETE CASCADE,
  claim_id INTEGER NOT NULL REFERENCES memory_vnext_claims(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_memory_vnext_transition_member UNIQUE (transition_path_id, claim_id, role),
  CONSTRAINT memory_vnext_transition_member_role_valid CHECK (role IN ('prior_state', 'action', 'mechanism', 'later_state'))
);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_transition_member_path ON memory_vnext_transition_members(transition_path_id, role, ordinal);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_transition_member_claim ON memory_vnext_transition_members(claim_id, role);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_transition_member_owner ON memory_vnext_transition_members(scope, owner_user_id);

CREATE TABLE IF NOT EXISTS memory_vnext_transition_edges (
  id SERIAL PRIMARY KEY,
  transition_path_id INTEGER NOT NULL REFERENCES memory_vnext_transition_paths(id) ON DELETE CASCADE,
  claim_link_id INTEGER NOT NULL REFERENCES memory_vnext_claim_links(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'user',
  owner_user_id TEXT,
  account_id TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uk_memory_vnext_transition_edge UNIQUE (transition_path_id, claim_link_id, role),
  CONSTRAINT memory_vnext_transition_edge_role_valid CHECK (role IN ('prior_to_action', 'action_to_later', 'mechanism_evidence'))
);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_transition_edge_path ON memory_vnext_transition_edges(transition_path_id);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_transition_edge_link ON memory_vnext_transition_edges(claim_link_id);
CREATE INDEX IF NOT EXISTS idx_memory_vnext_transition_edge_owner ON memory_vnext_transition_edges(scope, owner_user_id);

COMMENT ON COLUMN memory_vnext_claim_links.relationship_class IS 'Orthogonal semantic, evidence, temporal, causal, consolidation, or explicit legacy class.';
COMMENT ON COLUMN memory_vnext_claim_links.epistemic_status IS 'Observation versus hypothesis status. Causal edges are always causal hypotheses.';
COMMENT ON TABLE memory_vnext_transition_paths IS 'Replay-safe derived prior-state + action + optional mechanism -> later-state paths. Sequence alone never creates causality.';
