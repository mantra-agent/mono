-- LLM Router foundation: named exclusive connector pools + Account assignment.
-- Additive / nullable FKs for parallel cutover. NOT NULL only at sunset.

CREATE TABLE IF NOT EXISTS routers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_routers_name_unique
  ON routers (name);

-- Exactly one Default router.
CREATE UNIQUE INDEX IF NOT EXISTS idx_routers_one_default
  ON routers ((is_default))
  WHERE is_default = TRUE;

ALTER TABLE provider_connections
  ADD COLUMN IF NOT EXISTS router_id UUID REFERENCES routers(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_provider_connections_router
  ON provider_connections (router_id)
  WHERE router_id IS NOT NULL;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS router_id UUID REFERENCES routers(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_accounts_router
  ON accounts (router_id)
  WHERE router_id IS NOT NULL;

-- Seed empty Default when missing (boot also ensures; this makes fresh DBs ready).
INSERT INTO routers (name, is_default)
SELECT 'Default', TRUE
WHERE NOT EXISTS (SELECT 1 FROM routers WHERE is_default = TRUE);
