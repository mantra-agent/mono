CREATE TABLE IF NOT EXISTS simple_people_surface_state (
  id serial PRIMARY KEY,
  person_id text NOT NULL,
  dismissed_at timestamp with time zone,
  dismissed_reason_key text,
  snoozed_until timestamp with time zone,
  scope text NOT NULL DEFAULT 'user',
  owner_user_id text,
  account_id text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT simple_people_surface_state_person_account_unique UNIQUE (person_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_simple_people_surface_state_scope_owner
  ON simple_people_surface_state(scope, owner_user_id);

CREATE INDEX IF NOT EXISTS idx_simple_people_surface_state_snoozed_until
  ON simple_people_surface_state(snoozed_until);
