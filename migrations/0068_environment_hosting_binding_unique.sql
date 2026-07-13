-- A Platform Environment owns exactly one canonical hosting binding.
-- Abort rather than deleting data if historical duplicates exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM environment_hosting_bindings
    GROUP BY environment_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one hosting binding per environment: duplicate environment_id rows exist';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_environment_hosting_bindings_environment;
CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_hosting_bindings_environment_unique
  ON environment_hosting_bindings(environment_id);
