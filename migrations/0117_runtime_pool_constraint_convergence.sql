-- Converge historical inline Runtime pool CHECK names with the canonical contract.
-- PostgreSQL auto-named the original inline checks as *_resource_pool_check.

ALTER TABLE runtime_runs
  DROP CONSTRAINT IF EXISTS runtime_runs_resource_pool_check,
  DROP CONSTRAINT IF EXISTS runtime_runs_pool_check,
  ADD CONSTRAINT runtime_runs_pool_check CHECK (
    resource_pool IN ('realtime_agent','interactive_agent','background_agent','short_worker','isolated_execution')
  );

ALTER TABLE runtime_attempts
  DROP CONSTRAINT IF EXISTS runtime_attempts_resource_pool_check,
  DROP CONSTRAINT IF EXISTS runtime_attempts_pool_check,
  ADD CONSTRAINT runtime_attempts_pool_check CHECK (
    resource_pool IN ('realtime_agent','interactive_agent','background_agent','short_worker','isolated_execution')
  );
