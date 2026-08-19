-- Sunset leftover unnamed global model chain.
-- Accounts must point at a named Router. Model connectors must belong to a Router.

INSERT INTO routers (name, is_default)
SELECT 'Default', TRUE
WHERE NOT EXISTS (SELECT 1 FROM routers WHERE is_default = TRUE);

UPDATE accounts a
SET router_id = d.id,
    updated_at = CURRENT_TIMESTAMP
FROM routers d
WHERE a.router_id IS NULL
  AND d.is_default = TRUE;

DELETE FROM provider_connections
WHERE connector_kind = 'model'
  AND router_id IS NULL;

ALTER TABLE accounts
  ALTER COLUMN router_id SET NOT NULL;

DO $$
BEGIN
  ALTER TABLE provider_connections
    ADD CONSTRAINT provider_connections_model_router_required
    CHECK (connector_kind <> 'model' OR router_id IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
