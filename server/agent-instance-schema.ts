import { createLogger } from "./log";

const log = createLogger("AgentInstanceSchema");
const MIGRATION_LOCK_KEY = "migration.agent-instance-schema.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>> }>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

/**
 * Idempotent convergence for Agent Instance — the mind / continuity boundary.
 *
 * Account owns billing and which Instances exist. Instance owns memory/timers/skills
 * (ownership moves in later phases). Instance membership is Manager | Participant.
 * Structural invariants:
 * - Instance belongs to exactly one Account
 * - One User pins to exactly one Instance per Account
 *
 * Backfill preserves existing agent_profiles minds: one Instance per profile/personal
 * Account, Manager membership for the profile user, profile.instance_id dual-write.
 * True orphans are quarantined on the profile rather than inventing owners.
 */
export async function ensureAgentInstanceSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_instances (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
        account_id VARCHAR NOT NULL,
        name TEXT NOT NULL,
        created_by_user_id VARCHAR,
        status TEXT NOT NULL DEFAULT 'active',
        quarantine_reason TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      DO $migration$
      BEGIN
        IF to_regclass('public.accounts') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'agent_instances_account_id_fkey'
        ) THEN
          ALTER TABLE agent_instances ADD CONSTRAINT agent_instances_account_id_fkey
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
        END IF;
        IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'agent_instances_created_by_user_id_fkey'
        ) THEN
          ALTER TABLE agent_instances ADD CONSTRAINT agent_instances_created_by_user_id_fkey
            FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'agent_instances_status_check'
        ) THEN
          ALTER TABLE agent_instances ADD CONSTRAINT agent_instances_status_check
            CHECK (status IN ('active', 'quarantined'));
        END IF;
      END $migration$
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_agent_instances_account ON agent_instances(account_id)`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_agent_instances_created_by ON agent_instances(created_by_user_id)`,
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_instance_memberships (
        id SERIAL PRIMARY KEY,
        instance_id VARCHAR NOT NULL,
        user_id VARCHAR NOT NULL,
        account_id VARCHAR NOT NULL,
        role TEXT NOT NULL DEFAULT 'participant',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'agent_instance_memberships_instance_id_fkey'
        ) THEN
          ALTER TABLE agent_instance_memberships ADD CONSTRAINT agent_instance_memberships_instance_id_fkey
            FOREIGN KEY (instance_id) REFERENCES agent_instances(id) ON DELETE CASCADE;
        END IF;
        IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'agent_instance_memberships_user_id_fkey'
        ) THEN
          ALTER TABLE agent_instance_memberships ADD CONSTRAINT agent_instance_memberships_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
        END IF;
        IF to_regclass('public.accounts') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'agent_instance_memberships_account_id_fkey'
        ) THEN
          ALTER TABLE agent_instance_memberships ADD CONSTRAINT agent_instance_memberships_account_id_fkey
            FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'agent_instance_memberships_role_check'
        ) THEN
          ALTER TABLE agent_instance_memberships ADD CONSTRAINT agent_instance_memberships_role_check
            CHECK (role IN ('manager', 'participant'));
        END IF;
      END $migration$
    `);

    // One User pins to exactly one Instance inside one Account.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_instance_memberships_account_user_unique
        ON agent_instance_memberships(account_id, user_id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_instance_memberships_instance_user_unique
        ON agent_instance_memberships(instance_id, user_id)
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_agent_instance_memberships_user ON agent_instance_memberships(user_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_agent_instance_memberships_instance ON agent_instance_memberships(instance_id)`,
    );

    await client.query(`
      ALTER TABLE agent_profiles
        ADD COLUMN IF NOT EXISTS instance_id VARCHAR
    `);

    await client.query(`
      DO $migration$
      BEGIN
        IF to_regclass('public.agent_instances') IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'agent_profiles_instance_id_fkey'
        ) THEN
          ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_instance_id_fkey
            FOREIGN KEY (instance_id) REFERENCES agent_instances(id) ON DELETE SET NULL;
        END IF;
      END $migration$
    `);

    // Ownership uniqueness is instance_id. Never recreate the retired user unique.
    await client.query(`DROP INDEX IF EXISTS idx_agent_profiles_user_unique`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_instance_unique
        ON agent_profiles(instance_id)
        WHERE instance_id IS NOT NULL
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_agent_profiles_instance ON agent_profiles(instance_id)`,
    );

    // Live leftovers from reverted commercial gates — unread and must not return.
    await client.query(`ALTER TABLE accounts DROP COLUMN IF EXISTS entitlement`);
    await client.query(`ALTER TABLE accounts DROP COLUMN IF EXISTS model_access`);
    await client.query(`ALTER TABLE accounts DROP COLUMN IF EXISTS stripe_customer_id`);

    await client.query(`
      COMMENT ON TABLE agent_instances IS
        'Agent Instance mind/continuity boundary. Belongs to exactly one Account. Memory/timers/skills ownership moves here in later phases.'
    `);
    await client.query(`
      COMMENT ON TABLE agent_instance_memberships IS
        'Instance membership Manager|Participant. UNIQUE(account_id, user_id) encodes one pin per Account.'
    `);
    await client.query(`
      COMMENT ON COLUMN agent_profiles.instance_id IS
        'Owning Agent Instance (unique when set). user_id remains created_by / rolling-deploy dual-write key, not uniqueness.'
    `);

    const backfill = await backfillAgentInstances(client);
    await client.query("COMMIT");
    log.info("agent instance schema convergence complete", backfill);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // best-effort rollback
    }
    throw error;
  } finally {
    client.release();
  }
}

type BackfillStats = {
  profilesLinked: number;
  instancesCreated: number;
  membershipsCreated: number;
  personalAccountsCovered: number;
  profilesQuarantined: number;
};

async function backfillAgentInstances(client: QueryableClient): Promise<BackfillStats> {
  const stats: BackfillStats = {
    profilesLinked: 0,
    instancesCreated: 0,
    membershipsCreated: 0,
    personalAccountsCovered: 0,
    profilesQuarantined: 0,
  };

  // 1) Existing minds: one Instance per agent_profiles row that can resolve an Account.
  const profiles = await client.query(`
    SELECT
      ap.id AS profile_id,
      ap.user_id,
      ap.account_id AS profile_account_id,
      ap.instance_id,
      ap.agent_name,
      a_personal.id AS personal_account_id
    FROM agent_profiles ap
    LEFT JOIN accounts a_personal
      ON a_personal.kind = 'personal'
     AND a_personal.owner_user_id = ap.user_id
    ORDER BY ap.created_at ASC, ap.id ASC
  `);

  for (const row of profiles.rows ?? []) {
    const profileId = String(row.profile_id);
    const userId = row.user_id ? String(row.user_id) : null;
    const accountId =
      (row.profile_account_id ? String(row.profile_account_id) : null) ??
      (row.personal_account_id ? String(row.personal_account_id) : null);
    const existingInstanceId = row.instance_id ? String(row.instance_id) : null;
    const agentName = typeof row.agent_name === "string" && row.agent_name.trim()
      ? String(row.agent_name).trim().slice(0, 120)
      : "Mantra";

    if (existingInstanceId) {
      if (userId && accountId) {
        const created = await ensureMembership(client, {
          instanceId: existingInstanceId,
          userId,
          accountId,
          role: "manager",
        });
        if (created) stats.membershipsCreated += 1;
      }
      continue;
    }

    if (!accountId || !userId) {
      await client.query(
        `
          UPDATE agent_profiles
          SET
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'instanceQuarantine',
              jsonb_build_object(
                'reason', $2::text,
                'at', CURRENT_TIMESTAMP
              )
            ),
            updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
            AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'instanceQuarantine')
        `,
        [
          profileId,
          !userId
            ? "orphan_agent_profile_missing_user"
            : "orphan_agent_profile_missing_account",
        ],
      );
      stats.profilesQuarantined += 1;
      continue;
    }

    // Prefer an Instance this user is already pinned to in the Account.
    const existingPin = await client.query(
      `
        SELECT instance_id
        FROM agent_instance_memberships
        WHERE account_id = $1 AND user_id = $2
        LIMIT 1
      `,
      [accountId, userId],
    );
    let instanceId =
      existingPin.rows?.[0]?.instance_id != null
        ? String(existingPin.rows[0].instance_id)
        : null;

    if (!instanceId) {
      const created = await client.query(
        `
          INSERT INTO agent_instances (account_id, name, created_by_user_id, status)
          VALUES ($1, $2, $3, 'active')
          RETURNING id
        `,
        [accountId, agentName, userId],
      );
      instanceId = created.rows?.[0]?.id != null ? String(created.rows[0].id) : null;
      if (!instanceId) {
        throw new Error(`Failed to create agent_instance for profile ${profileId}`);
      }
      stats.instancesCreated += 1;
    }

    const membershipCreated = await ensureMembership(client, {
      instanceId,
      userId,
      accountId,
      role: "manager",
    });
    if (membershipCreated) stats.membershipsCreated += 1;

    await client.query(
      `
        UPDATE agent_profiles
        SET
          instance_id = $2,
          account_id = COALESCE(account_id, $3),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
          AND (instance_id IS DISTINCT FROM $2 OR account_id IS DISTINCT FROM COALESCE(account_id, $3))
      `,
      [profileId, instanceId, accountId],
    );
    stats.profilesLinked += 1;
  }

  // 2) Personal Accounts with no Instance yet (no profile, or profile already handled without pin).
  const uncovered = await client.query(`
    SELECT a.id AS account_id, a.owner_user_id, a.name
    FROM accounts a
    WHERE a.kind = 'personal'
      AND a.owner_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_instances ai WHERE ai.account_id = a.id
      )
    ORDER BY a.created_at ASC, a.id ASC
  `);

  for (const row of uncovered.rows ?? []) {
    const accountId = String(row.account_id);
    const ownerUserId = String(row.owner_user_id);
    const name =
      typeof row.name === "string" && row.name.trim()
        ? String(row.name).trim().slice(0, 120)
        : "Personal";

    const created = await client.query(
      `
        INSERT INTO agent_instances (account_id, name, created_by_user_id, status)
        VALUES ($1, $2, $3, 'active')
        RETURNING id
      `,
      [accountId, name, ownerUserId],
    );
    const instanceId = created.rows?.[0]?.id != null ? String(created.rows[0].id) : null;
    if (!instanceId) {
      throw new Error(`Failed to create agent_instance for personal account ${accountId}`);
    }
    stats.instancesCreated += 1;
    stats.personalAccountsCovered += 1;

    const membershipCreated = await ensureMembership(client, {
      instanceId,
      userId: ownerUserId,
      accountId,
      role: "manager",
    });
    if (membershipCreated) stats.membershipsCreated += 1;

    // Dual-write any still-unlinked profile for this user onto the new Instance.
    await client.query(
      `
        UPDATE agent_profiles
        SET
          instance_id = $2,
          account_id = COALESCE(account_id, $3),
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
          AND instance_id IS NULL
      `,
      [ownerUserId, instanceId, accountId],
    );
  }

  return stats;
}

async function ensureMembership(
  client: QueryableClient,
  args: { instanceId: string; userId: string; accountId: string; role: "manager" | "participant" },
): Promise<boolean> {
  const result = await client.query(
    `
      INSERT INTO agent_instance_memberships (instance_id, user_id, account_id, role)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (account_id, user_id) DO UPDATE
        SET
          instance_id = EXCLUDED.instance_id,
          role = CASE
            WHEN agent_instance_memberships.role = 'manager' OR EXCLUDED.role = 'manager'
              THEN 'manager'
            ELSE agent_instance_memberships.role
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE
        agent_instance_memberships.instance_id IS DISTINCT FROM EXCLUDED.instance_id
        OR (
          EXCLUDED.role = 'manager'
          AND agent_instance_memberships.role IS DISTINCT FROM 'manager'
        )
      RETURNING id
    `,
    [args.instanceId, args.userId, args.accountId, args.role],
  );
  return (result.rows?.length ?? 0) > 0;
}
