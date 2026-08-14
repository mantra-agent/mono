ALTER TABLE platform_product_environments
  ADD COLUMN IF NOT EXISTS platform_id INTEGER;

DO $heal$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_product_environments_platform_id_platforms_id_fk'
  ) THEN
    ALTER TABLE platform_product_environments
      ADD CONSTRAINT platform_product_environments_platform_id_platforms_id_fk
      FOREIGN KEY (platform_id) REFERENCES platforms(id) ON DELETE CASCADE;
  END IF;
END $heal$;

UPDATE platform_product_environments e
SET platform_id = pp.platform_id
FROM platform_products pp
WHERE e.platform_id IS NULL
  AND e.product_id = pp.id;

CREATE INDEX IF NOT EXISTS idx_platform_product_environments_platform
  ON platform_product_environments(platform_id);
