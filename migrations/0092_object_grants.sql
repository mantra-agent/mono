-- P2: one canonical per-object work authorization ledger.
-- Vault membership does not participate in this access model.

CREATE TABLE IF NOT EXISTS object_grants (
  id SERIAL PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  granted_by_user_id TEXT NOT NULL,
  origin_type TEXT NOT NULL,
  origin_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT object_grants_subject_type_check CHECK (subject_type IN ('user', 'invited_subject')),
  CONSTRAINT object_grants_object_type_check CHECK (object_type IN ('project', 'milestone', 'task')),
  CONSTRAINT object_grants_capability_check CHECK (capability IN ('read', 'write', 'admin')),
  CONSTRAINT object_grants_origin_type_check CHECK (origin_type IN ('meeting', 'manual'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_object_grants_one_live_subject_object
  ON object_grants(subject_type, subject_id, object_type, object_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_object_grants_live_subject_object
  ON object_grants(subject_type, subject_id, object_type, object_id, capability)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_object_grants_live_object
  ON object_grants(object_type, object_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE object_grants IS 'Canonical per-object work authorization ledger. Revocation stamps revoked_at; rows are never deleted.';
COMMENT ON COLUMN object_grants.object_id IS 'Project/task decimal id; milestone uses project_id:milestone_id because milestone ids are project-local.';
