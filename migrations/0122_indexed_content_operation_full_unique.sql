-- Exact-once tool-output archives: upgrade partial unique index to full unique.
-- The partial predicate (WHERE operation_key IS NOT NULL) let concurrent null-key
-- inserts bypass uniqueness. Tool-output archival now requires operation_key at
-- ensureToolOutputArchived; the index must enforce the same discriminant.

DROP INDEX IF EXISTS uk_indexed_content_operation;

CREATE UNIQUE INDEX IF NOT EXISTS uk_indexed_content_operation
  ON indexed_content(owner_user_id, principal_account_id, source_type, operation_key);
