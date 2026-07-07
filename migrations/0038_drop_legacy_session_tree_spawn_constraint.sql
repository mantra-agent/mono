-- The original session_tree spawn idempotency invariant was created as an
-- absolute UNIQUE constraint on (parent_session_id, spawn_reason, spawner_skill_run).
-- Later migrations replaced it with a partial unique index over active spawns,
-- but DROP INDEX does not remove a constraint-owned unique index. Existing DBs
-- can therefore keep rejecting terminal/legacy duplicate spawn rows with:
--   duplicate key value violates unique constraint "uk_session_tree_spawn_idem"
ALTER TABLE session_tree DROP CONSTRAINT IF EXISTS uk_session_tree_spawn_idem;
DROP INDEX IF EXISTS uk_session_tree_spawn_idem;
