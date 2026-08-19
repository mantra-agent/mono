-- Additive Wellness activity launch/completion fields.
-- Closed kinds live on the row so Habits can dispatch without naming instances.
ALTER TABLE wellness_activities ADD COLUMN IF NOT EXISTS launch_kind TEXT;
ALTER TABLE wellness_activities ADD COLUMN IF NOT EXISTS launch_target TEXT;
ALTER TABLE wellness_activities ADD COLUMN IF NOT EXISTS completion_source TEXT;
