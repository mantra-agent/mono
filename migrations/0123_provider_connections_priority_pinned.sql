-- Explicit connector priority pin: pinned connectors sort ahead of unpinned peers.
ALTER TABLE provider_connections ADD COLUMN IF NOT EXISTS priority_pinned BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_provider_connections_kind_pin_order
  ON provider_connections (connector_kind, priority_pinned DESC, sort_order);
