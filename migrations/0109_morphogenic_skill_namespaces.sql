-- Skills are user-owned intelligence definitions. Global rows are templates;
-- each user/account may own one same-named private override.
ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_name_unique;
DROP INDEX IF EXISTS skills_name_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_global_name_unique
  ON skills(name)
  WHERE scope = 'global';

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_owner_name_unique
  ON skills(owner_user_id, account_id, name)
  WHERE scope = 'user';

ALTER TABLE skill_failure_dismissals
  DROP CONSTRAINT IF EXISTS skill_failure_dismissals_skill_name_key;
ALTER TABLE skill_failure_dismissals
  DROP CONSTRAINT IF EXISTS skill_failure_dismissals_skill_name_unique;
DROP INDEX IF EXISTS skill_failure_dismissals_skill_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS skill_failure_dismissals_owner_name_key
  ON skill_failure_dismissals(owner_user_id, account_id, skill_name);
