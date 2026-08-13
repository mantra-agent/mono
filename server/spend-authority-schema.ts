import { createLogger } from "./log";

const log = createLogger("SpendAuthoritySchema");
const MIGRATION_LOCK_KEY = "migration.account-spend-authority.v1";

type QueryableClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>> }>;
  release: () => void;
};

type ConnectionPool = {
  connect: () => Promise<QueryableClient>;
};

/**
 * Additive Account entitlement discriminant for Phase 2 spend gate.
 *
 * Account owns entitled | unentitled. Default is unentitled so incomplete/orphan
 * rows cannot spend. Existing real personal Accounts (kind=personal with an owner)
 * backfill to entitled so Ray/Anna keep working. No Stripe in this cut.
 */
export async function ensureSpendAuthoritySchema(pool: ConnectionPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('${MIGRATION_LOCK_KEY}'))`);

    if (!(await tableExists(client, "accounts"))) {
      await client.query("COMMIT");
      log.info("spend authority schema skipped; accounts table absent");
      return;
    }

    await client.query(`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS entitlement TEXT NOT NULL DEFAULT 'unentitled'
    `);

    await client.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'accounts_entitlement_check'
        ) THEN
          ALTER TABLE accounts ADD CONSTRAINT accounts_entitlement_check
            CHECK (entitlement IN ('entitled', 'unentitled'));
        END IF;
      END $migration$
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_accounts_entitlement
        ON accounts(entitlement)
    `);

    // Existing real personal Accounts keep working. Orphans / incomplete shells stay unentitled.
    const backfill = await client.query(`
      UPDATE accounts
      SET entitlement = 'entitled',
          updated_at = CURRENT_TIMESTAMP
      WHERE kind = 'personal'
        AND owner_user_id IS NOT NULL
        AND entitlement IS DISTINCT FROM 'entitled'
      RETURNING id
    `);

    await client.query(`
      COMMENT ON COLUMN accounts.entitlement IS
        'Phase 2 spend discriminant: entitled | unentitled. Account pays; Instance consumes. Stripe attaches later.'
    `);

    await client.query("COMMIT");
    log.info("spend authority schema convergence complete", {
      personalAccountsEntitled: backfill.rows?.length ?? 0,
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
