UPDATE memory_vnext_claims
SET content_hash = encode(
  digest(
    convert_to(
      (CASE
        WHEN owner_user_id IS NOT NULL THEN 'user:' || owner_user_id
        WHEN account_id IS NOT NULL THEN 'account:' || account_id
        ELSE 'actor:system'
      END) || chr(31) || lower(trim(content)),
      'UTF8'
    ),
    'sha256'
  ),
  'hex'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uk_memory_vnext_claim_content_hash'
      AND conrelid = 'memory_vnext_claims'::regclass
  ) THEN
    ALTER TABLE memory_vnext_claims
      ADD CONSTRAINT uk_memory_vnext_claim_content_hash UNIQUE (content_hash);
  END IF;
END $$;
