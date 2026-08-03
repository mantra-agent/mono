import type { Pool } from "pg";

const MIGRATION_LOCK_KEY = "build-deployment-home-schema-v3";

/** Additive, replay-safe schema convergence for Build deployment observations. */
export async function ensureBuildDeploymentSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_deployment_observations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        platform_environment_id INTEGER NOT NULL REFERENCES platform_product_environments(id) ON DELETE RESTRICT,
        provider TEXT NOT NULL,
        provider_deployment_id TEXT NOT NULL,
        deployment_state TEXT NOT NULL,
        platform_name TEXT NOT NULL,
        product_name TEXT NOT NULL,
        environment_name TEXT NOT NULL,
        commit_sha TEXT,
        deployed_at TIMESTAMPTZ NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT platform_deployment_observations_provider_check CHECK (provider = 'railway'),
        CONSTRAINT platform_deployment_observations_state_check CHECK (deployment_state = 'SUCCESS'),
        CONSTRAINT platform_deployment_observations_provider_id_check CHECK (char_length(provider_deployment_id) BETWEEN 1 AND 200),
        CONSTRAINT platform_deployment_observations_identity_check CHECK (
          char_length(platform_name) BETWEEN 1 AND 200
          AND char_length(product_name) BETWEEN 1 AND 200
          AND char_length(environment_name) BETWEEN 1 AND 200
        ),
        CONSTRAINT platform_deployment_observations_commit_check CHECK (
          commit_sha IS NULL OR char_length(commit_sha) BETWEEN 1 AND 200
        )
      )
    `);
    // Migration 0116 left a global unique on (provider, provider_deployment_id).
    // Drop it so account-scoped observation identity is the only uniqueness rule.
    await client.query(`
      DROP INDEX IF EXISTS uk_platform_deployment_observation_provider_deployment
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_platform_deployment_observation_provider_identity
      ON platform_deployment_observations(account_id, platform_environment_id, provider, provider_deployment_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_platform_deployment_observations_owner_time
      ON platform_deployment_observations(owner_user_id, account_id, deployed_at DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS build_deployment_home_projections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        observation_id UUID NOT NULL REFERENCES platform_deployment_observations(id) ON DELETE RESTRICT,
        platform_environment_id INTEGER REFERENCES platform_product_environments(id) ON DELETE RESTRICT,
        reason_key TEXT NOT NULL,
        dismissed_at TIMESTAMPTZ,
        dismissed_by_user_id TEXT,
        scope TEXT NOT NULL DEFAULT 'user',
        owner_user_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT build_deployment_home_projection_reason_check CHECK (char_length(reason_key) BETWEEN 1 AND 500),
        CONSTRAINT build_deployment_home_projection_dismissal_check CHECK (
          (dismissed_at IS NULL AND dismissed_by_user_id IS NULL)
          OR (dismissed_at IS NOT NULL AND dismissed_by_user_id IS NOT NULL)
        )
      )
    `);
    await client.query(`
      ALTER TABLE build_deployment_home_projections
      ADD COLUMN IF NOT EXISTS platform_environment_id INTEGER REFERENCES platform_product_environments(id) ON DELETE RESTRICT
    `);
    await client.query(`
      UPDATE build_deployment_home_projections AS projection
      SET platform_environment_id = observation.platform_environment_id
      FROM platform_deployment_observations AS observation
      WHERE projection.observation_id = observation.id
        AND projection.platform_environment_id IS NULL
    `);
    await client.query(`
      DELETE FROM build_deployment_home_projections AS projection
      USING build_deployment_home_projections AS newer,
            platform_deployment_observations AS projection_observation,
            platform_deployment_observations AS newer_observation
      WHERE projection.account_id = newer.account_id
        AND projection.platform_environment_id = newer.platform_environment_id
        AND projection.id <> newer.id
        AND projection.observation_id = projection_observation.id
        AND newer.observation_id = newer_observation.id
        AND (
          projection_observation.deployed_at < newer_observation.deployed_at
          OR (
            projection_observation.deployed_at = newer_observation.deployed_at
            AND projection.created_at < newer.created_at
          )
          OR (
            projection_observation.deployed_at = newer_observation.deployed_at
            AND projection.created_at = newer.created_at
            AND projection.id::text < newer.id::text
          )
        )
    `);
    await client.query(`
      ALTER TABLE build_deployment_home_projections
      ALTER COLUMN platform_environment_id SET NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_build_deployment_home_projection_environment
      ON build_deployment_home_projections(account_id, platform_environment_id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_build_deployment_home_projection_observation
      ON build_deployment_home_projections(observation_id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uk_build_deployment_home_projection_reason
      ON build_deployment_home_projections(account_id, reason_key)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_build_deployment_home_projection_owner
      ON build_deployment_home_projections(owner_user_id, account_id, dismissed_at, created_at DESC)
    `);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
