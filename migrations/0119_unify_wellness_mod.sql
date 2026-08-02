-- Retire Coaching as a standalone Mod and converge its account-owned state into
-- Wellness. Historical Coaching rows remain for audit, but are made inactive.
-- Replay-safe: target rows are inserted/upgraded idempotently and resource-ledger
-- ownership moves only after duplicate active owners are retired.

-- Preserve the strongest entitlement: either prior entitlement authorizes Wellness.
INSERT INTO mod_entitlements (
  id,
  account_id,
  mod_key,
  status,
  source,
  requested_version,
  provisioned_version,
  granted_at,
  expires_at,
  revoked_at,
  metadata,
  created_by_user_id,
  scope,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid()::text,
  coaching.account_id,
  'wellness',
  coaching.status,
  coaching.source,
  coaching.requested_version,
  coaching.provisioned_version,
  coaching.granted_at,
  coaching.expires_at,
  coaching.revoked_at,
  coaching.metadata,
  coaching.created_by_user_id,
  coaching.scope,
  coaching.created_at,
  coaching.updated_at
FROM mod_entitlements AS coaching
WHERE coaching.mod_key = 'coaching'
ON CONFLICT (account_id, mod_key) DO UPDATE
SET
  status = CASE
    WHEN mod_entitlements.status = 'entitled'
      OR EXCLUDED.status = 'entitled'
      THEN 'entitled'
    ELSE mod_entitlements.status
  END,
  requested_version = COALESCE(mod_entitlements.requested_version, EXCLUDED.requested_version),
  provisioned_version = COALESCE(mod_entitlements.provisioned_version, EXCLUDED.provisioned_version),
  granted_at = CASE
    WHEN mod_entitlements.status = 'entitled' THEN mod_entitlements.granted_at
    WHEN EXCLUDED.status = 'entitled' THEN EXCLUDED.granted_at
    ELSE mod_entitlements.granted_at
  END,
  expires_at = CASE
    WHEN mod_entitlements.status = 'entitled' THEN mod_entitlements.expires_at
    WHEN EXCLUDED.status = 'entitled' THEN EXCLUDED.expires_at
    ELSE mod_entitlements.expires_at
  END,
  revoked_at = CASE
    WHEN mod_entitlements.status = 'entitled'
      OR EXCLUDED.status = 'entitled'
      THEN NULL
    ELSE mod_entitlements.revoked_at
  END,
  metadata = EXCLUDED.metadata || mod_entitlements.metadata,
  updated_at = GREATEST(mod_entitlements.updated_at, EXCLUDED.updated_at);

-- Preserve an existing Wellness installation unless Coaching is active and
-- Wellness is not. Configuration is merged with Wellness values authoritative.
INSERT INTO mod_installations (
  id,
  account_id,
  mod_key,
  status,
  installed_version,
  desired_version,
  definition_version,
  configuration,
  enabled_at,
  disabled_at,
  failure_code,
  failure_detail,
  created_by_user_id,
  scope,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid()::text,
  coaching.account_id,
  'wellness',
  coaching.status,
  coaching.installed_version,
  coaching.desired_version,
  coaching.definition_version,
  coaching.configuration,
  coaching.enabled_at,
  coaching.disabled_at,
  coaching.failure_code,
  coaching.failure_detail,
  coaching.created_by_user_id,
  coaching.scope,
  coaching.created_at,
  coaching.updated_at
FROM mod_installations AS coaching
WHERE coaching.mod_key = 'coaching'
ON CONFLICT (account_id, mod_key) DO UPDATE
SET
  status = CASE
    WHEN mod_installations.status = 'active' THEN 'active'
    WHEN EXCLUDED.status = 'active' THEN 'active'
    ELSE mod_installations.status
  END,
  installed_version = CASE
    WHEN mod_installations.status = 'active' THEN mod_installations.installed_version
    WHEN EXCLUDED.status = 'active' THEN EXCLUDED.installed_version
    ELSE mod_installations.installed_version
  END,
  desired_version = COALESCE(mod_installations.desired_version, EXCLUDED.desired_version),
  definition_version = CASE
    WHEN mod_installations.status = 'active' THEN mod_installations.definition_version
    WHEN EXCLUDED.status = 'active' THEN EXCLUDED.definition_version
    ELSE mod_installations.definition_version
  END,
  configuration = EXCLUDED.configuration || mod_installations.configuration,
  enabled_at = CASE
    WHEN mod_installations.status = 'active' THEN mod_installations.enabled_at
    WHEN EXCLUDED.status = 'active' THEN EXCLUDED.enabled_at
    ELSE mod_installations.enabled_at
  END,
  disabled_at = CASE
    WHEN mod_installations.status = 'active'
      OR EXCLUDED.status = 'active'
      THEN NULL
    ELSE mod_installations.disabled_at
  END,
  failure_code = CASE
    WHEN mod_installations.status = 'active'
      OR EXCLUDED.status = 'active'
      THEN NULL
    ELSE mod_installations.failure_code
  END,
  failure_detail = CASE
    WHEN mod_installations.status = 'active'
      OR EXCLUDED.status = 'active'
      THEN NULL
    ELSE mod_installations.failure_detail
  END,
  updated_at = GREATEST(mod_installations.updated_at, EXCLUDED.updated_at);

-- If both installations already own the same live resource, retain Wellness as
-- canonical and preserve the Coaching ledger row as removed history.
UPDATE mod_installation_resources AS coaching_resource
SET
  state = 'removed',
  removed_at = COALESCE(coaching_resource.removed_at, NOW()),
  last_error = COALESCE(
    coaching_resource.last_error,
    'Retired duplicate during Coaching-to-Wellness convergence'
  ),
  updated_at = NOW()
FROM mod_installations AS coaching_installation,
     mod_installations AS wellness_installation,
     mod_installation_resources AS wellness_resource
WHERE coaching_installation.id = coaching_resource.installation_id
  AND coaching_installation.mod_key = 'coaching'
  AND wellness_installation.account_id = coaching_installation.account_id
  AND wellness_installation.mod_key = 'wellness'
  AND wellness_resource.installation_id = wellness_installation.id
  AND wellness_resource.account_id = coaching_resource.account_id
  AND wellness_resource.resource_type = coaching_resource.resource_type
  AND wellness_resource.resource_id = coaching_resource.resource_id
  AND wellness_resource.state <> 'removed'
  AND coaching_resource.state <> 'removed';

-- Transfer every remaining live resource ledger row to the canonical Wellness
-- installation. Removed rows stay attached to Coaching as historical evidence.
UPDATE mod_installation_resources AS coaching_resource
SET
  installation_id = wellness_installation.id,
  updated_at = NOW()
FROM mod_installations AS coaching_installation,
     mod_installations AS wellness_installation
WHERE coaching_installation.id = coaching_resource.installation_id
  AND coaching_installation.mod_key = 'coaching'
  AND wellness_installation.account_id = coaching_installation.account_id
  AND wellness_installation.mod_key = 'wellness'
  AND coaching_resource.state <> 'removed';

-- Historical source rows remain queryable but can no longer authorize product
-- composition or represent a live standalone installation.
UPDATE mod_entitlements
SET
  status = 'denied',
  revoked_at = COALESCE(revoked_at, NOW()),
  updated_at = NOW()
WHERE mod_key = 'coaching'
  AND (status <> 'denied' OR revoked_at IS NULL);

UPDATE mod_installations
SET
  status = 'disabled',
  disabled_at = COALESCE(disabled_at, NOW()),
  updated_at = NOW()
WHERE mod_key = 'coaching'
  AND (status <> 'disabled' OR disabled_at IS NULL);
