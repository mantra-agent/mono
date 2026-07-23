ALTER TABLE agent_profiles
  ALTER COLUMN agent_name SET DEFAULT 'Mantra';

UPDATE agent_profiles
SET agent_name = 'Mantra',
    updated_at = CURRENT_TIMESTAMP
WHERE agent_name = 'Agent';

UPDATE agent_profiles
SET metadata = metadata - 'identityModel' - 'rayIdentityModel',
    updated_at = CURRENT_TIMESTAMP
WHERE metadata ? 'identityModel'
   OR metadata ? 'rayIdentityModel';

-- People records remain narrative enrichment. Profile rows own proper names.

WITH canonical_user_people AS (
  SELECT DISTINCT ON (up.user_id)
    up.user_id,
    p.name,
    p.nicknames
  FROM user_profiles up
  JOIN persons p
    ON p.cabinet_level = 'user'
   AND (
     (up.account_id IS NOT NULL AND p.account_id = up.account_id)
     OR p.owner_user_id = up.user_id
   )
  ORDER BY up.user_id, p.updated_at DESC
)
UPDATE user_profiles up
SET display_name = CASE
      WHEN up.display_name IS NULL OR lower(up.display_name) = lower(u.email)
        THEN cup.name
      ELSE up.display_name
    END,
    preferred_name = CASE
      WHEN up.preferred_name IS NULL OR lower(up.preferred_name) = lower(u.email)
        THEN COALESCE(NULLIF(cup.nicknames->>0, ''), NULLIF(split_part(cup.name, ' ', 1), ''), cup.name)
      ELSE up.preferred_name
    END,
    updated_at = CURRENT_TIMESTAMP
FROM users u, canonical_user_people cup
WHERE up.user_id = u.id
  AND cup.user_id = up.user_id
  AND (
    up.display_name IS NULL
    OR up.preferred_name IS NULL
    OR lower(up.display_name) = lower(u.email)
    OR lower(up.preferred_name) = lower(u.email)
  );
