ALTER TABLE simple_people_surface_state
  ADD COLUMN IF NOT EXISTS surfaced_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP;
