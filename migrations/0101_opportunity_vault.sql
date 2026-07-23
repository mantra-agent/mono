-- Optional single-Vault placement for Opportunities. Additive and replay-safe.
-- Existing Opportunities remain unassigned (NULL) and therefore visible.
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS vault_id TEXT;

CREATE INDEX IF NOT EXISTS idx_opportunities_vault_id
  ON opportunities(vault_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'opportunities_vault_id_fkey'
      AND conrelid = 'opportunities'::regclass
  ) THEN
    ALTER TABLE opportunities
      ADD CONSTRAINT opportunities_vault_id_fkey
      FOREIGN KEY (vault_id) REFERENCES vaults(id) ON DELETE SET NULL;
  END IF;
END
$$;
