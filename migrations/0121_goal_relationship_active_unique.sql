-- Goal Relationship Stewardship — structural uniqueness for active relationship links.
--
-- Explicit goal relationships (e.g. goal:X involves_person person:Y) are stored in
-- the generic address_links ledger. Adds/removes use fresh idempotency keys so a
-- link can be retired and later re-created; the invariant "at most one ACTIVE link
-- per (owner, account, source, predicate, target)" therefore belongs in the data
-- model, not in application guards.
--
-- Additive and replay-safe: first retire any pre-existing ACTIVE duplicates
-- (keeping the earliest per endpoint tuple), then add the partial-unique index.
-- After the first run no active duplicates remain, so the UPDATE is a no-op.

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY owner_user_id, account_id, source_address, predicate, target_address
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM address_links
  WHERE lifecycle = 'active'
)
UPDATE address_links a
SET lifecycle = 'retired', retired_at = CURRENT_TIMESTAMP
FROM ranked r
WHERE a.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uk_address_links_active_relationship
  ON address_links (owner_user_id, account_id, source_address, predicate, target_address)
  WHERE lifecycle = 'active';
