ALTER TABLE simple_people_surface_state
  ADD COLUMN IF NOT EXISTS reason_key text NOT NULL DEFAULT 'legacy';

UPDATE simple_people_surface_state
SET reason_key = COALESCE(NULLIF(dismissed_reason_key, ''), 'legacy')
WHERE reason_key = 'legacy';

ALTER TABLE simple_people_surface_state
  DROP CONSTRAINT IF EXISTS simple_people_surface_state_person_account_unique;

ALTER TABLE simple_people_surface_state
  ADD CONSTRAINT simple_people_surface_state_person_account_reason_unique
  UNIQUE (person_id, account_id, reason_key);

CREATE INDEX IF NOT EXISTS idx_simple_people_surface_state_person_reason
  ON simple_people_surface_state(person_id, reason_key);
