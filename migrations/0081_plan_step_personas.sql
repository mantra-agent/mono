-- Plan steps own their execution persona so child sessions start in the correct
-- cognitive mode before context assembly and first inference. NULL remains valid
-- only for plans authored before this contract; the executor classifies and persists
-- those steps once when they next run.

ALTER TABLE plan_steps
  ADD COLUMN IF NOT EXISTS persona TEXT;

ALTER TABLE plan_steps
  DROP CONSTRAINT IF EXISTS chk_plan_steps_persona;

ALTER TABLE plan_steps
  ADD CONSTRAINT chk_plan_steps_persona
  CHECK (persona IS NULL OR persona IN ('Engineer', 'Architect', 'Default'));
