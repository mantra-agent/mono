import { createLogger } from "./log";

const log = createLogger("AccountModelAccessSchema");
const MIGRATION_LOCK_KEY = "migration.account-model-access.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>> }>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

/**
 * Additive Account model entitlement + reserved Stripe customer attach point.
 *
 * - model_access JSONB: commercial gate over platform model connectors
 *   default platform_stack so entitled Accounts keep using the global stack
 * - stripe_customer_id: reserved for @task:2359; no billing engine here
 */
export async function ensureAccountModelAccessSchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);

    if (!(await tableExists(client, "accounts"))) {
      await client.query("COMMIT");
      log.info("account model access schema skipped; accounts table absent");
      return;
    }

    await client.query(`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS model_access JSONB NOT NULL DEFAULT '{"mode":"platform_stack"}'::jsonb
    `);

    await client.query(`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT
    `);

    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'accounts_model_access_mode_check'
        ) THEN
          ALTER TABLE accounts ADD CONSTRAINT accounts_model_access_mode_check
            CHECK (
              jsonb_typeof(model_access) = 'object'
              AND COALESCE(model_access->>'mode', 'platform_stack')
                IN ('platform_stack', 'allowlist', 'none')
            );
        END IF;
      END $migration$
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_stripe_customer_id_unique
        ON accounts(stripe_customer_id)
        WHERE stripe_customer_id IS NOT NULL
    `);

    // Entitled Accounts that somehow lack a mode get the platform stack.
    const backfill = await client.query(`
      UPDATE accounts
      SET model_access = '{"mode":"platform_stack"}'::jsonb,
          updated_at = CURRENT_TIMESTAMP
      WHERE entitlement = 'entitled'
        AND (
          model_access IS NULL
          OR jsonb_typeof(model_access) <> 'object'
          OR COALESCE(model_access->>'mode', '') = ''
        )
      RETURNING id
    `);

    await client.query(`
      COMMENT ON COLUMN accounts.model_access IS
        'Phase 2 commercial model gate: {mode: platform_stack|allowlist|none, providers?, connectorIds?, tiers?}. Platform provider_connections stay infrastructure.'
    `);

    await client.query(`
      COMMENT ON COLUMN accounts.stripe_customer_id IS
        'Reserved Stripe customer attach point for Account billing (@task:2359). No billing engine in this cut.'
    `);

    await client.query("COMMIT");
    log.info("account model access schema convergence complete", {
      entitledAccountsRepaired: backfill.rows?.length ?? 0,
    });
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

async function tableExists(client: QueryableClient, tableName: string): Promise<boolean> {
  const result = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${tableName}`]);
  return Boolean(result.rows?.[0]?.reg);
}
