-- Remount Environments onto canonical products.
-- platform_products stays as a frozen leftover; it is no longer the Environment parent.

DO $heal$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_class f ON f.oid = c.confrelid
    WHERE t.relname = 'platform_product_environments'
      AND f.relname = 'platform_products'
      AND c.contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE platform_product_environments DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $heal$;

UPDATE platform_product_environments e
SET product_id = pr.id
FROM platform_products pp
JOIN platforms p ON p.id = pp.platform_id
LEFT JOIN vaults v ON v.id = p.vault_id
JOIN products pr
  ON pr.account_id = COALESCE(p.account_id, v.account_id)
 AND lower(pr.name) = lower(pp.name)
WHERE e.product_id = pp.id
  AND e.product_id IS DISTINCT FROM pr.id;

DO $heal$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM platform_product_environments e
    LEFT JOIN products pr ON pr.id = e.product_id
    WHERE pr.id IS NULL
  ) THEN
    RAISE EXCEPTION 'environment product remount left orphan product_id values';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_product_environments_product_id_products_id_fk'
  ) THEN
    ALTER TABLE platform_product_environments
      ADD CONSTRAINT platform_product_environments_product_id_products_id_fk
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
  END IF;
END $heal$;

DO $heal$
DECLARE
  r RECORD;
BEGIN
  IF to_regclass('workflow_runs') IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_class f ON f.oid = c.confrelid
    WHERE t.relname = 'workflow_runs'
      AND f.relname = 'platform_products'
      AND c.contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE workflow_runs DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $heal$;

UPDATE workflow_runs wr
SET linked_product_id = pr.id
FROM platform_products pp
JOIN platforms p ON p.id = pp.platform_id
LEFT JOIN vaults v ON v.id = p.vault_id
JOIN products pr
  ON pr.account_id = COALESCE(p.account_id, v.account_id)
 AND lower(pr.name) = lower(pp.name)
WHERE wr.linked_product_id = pp.id
  AND wr.linked_product_id IS DISTINCT FROM pr.id;

DO $heal$
BEGIN
  IF to_regclass('workflow_runs') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM workflow_runs wr
    LEFT JOIN products pr ON pr.id = wr.linked_product_id
    WHERE wr.linked_product_id IS NOT NULL
      AND pr.id IS NULL
  ) THEN
    RAISE EXCEPTION 'workflow linked_product remount left orphan linked_product_id values';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_linked_product_id_products_id_fk'
  ) THEN
    ALTER TABLE workflow_runs
      ADD CONSTRAINT workflow_runs_linked_product_id_products_id_fk
      FOREIGN KEY (linked_product_id) REFERENCES products(id) ON DELETE SET NULL;
  END IF;
END $heal$;
