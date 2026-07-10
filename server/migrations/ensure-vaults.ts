import { pool } from "../db";
import { createLogger } from "../log";

const log = createLogger("EnsureVaults");

/**
 * Idempotent vault schema bootstrap + backfill.
 *
 * 1. Create `vaults` table if not exists
 * 2. Add `active_vault_id` and `visible_vault_ids` to `users`
 * 3. Add `vault_id` to all Phase-1 owned tables
 * 4. Create a "Personal" vault for every account that lacks one
 * 5. Backfill vault_id on all owned rows to the account's Personal vault
 * 6. Set users.active_vault_id and visible_vault_ids defaults
 *
 * All operations are additive and idempotent (safe to re-run).
 */
export async function ensureVaults(): Promise<void> {
  const t0 = Date.now();
  try {
    // ── 1. Vaults table ────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vaults (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        icon TEXT,
        color TEXT,
        purpose TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        policy JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_default BOOLEAN NOT NULL DEFAULT false,
        is_archived BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, name)
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_vaults_account ON vaults(account_id)`,
    );

    // ── 2. Users table vault columns ───────────────────────────────
    await pool.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS active_vault_id TEXT`,
    );
    await pool.query(
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS visible_vault_ids TEXT[] DEFAULT '{}'::text[]`,
    );

    // ── 3. vault_id on owned tables (Phase 1 + Phase 2) ──────────
    const vaultIdTables = [
      // Phase 1
      "sessions",
      "messages",
      "workspace_documents",
      "memory_entries",
      "library_pages",
      "emotional_states",
      "personas",
      "skills",
      "skill_runs",
      "theses",
      "signal_sources",
      "signal_items",
      // Phase 2: Calendar
      "calendar_event_metadata",
      "calendar_event_tasks",
      "calendar_event_people",
      "calendar_event_artifacts",
      // Phase 2: People
      "persons",
      "simple_people_surface_state",
      // Phase 2: Finance (user data, NOT plaid_accounts/plaid_sync_cursors plumbing)
      "plaid_transactions",
      "plaid_holdings",
      "plaid_liabilities",
      "manual_assets",
      "manual_liabilities",
      "financial_goals",
      "recurring_expenses",
      "expense_categories",
      "merchant_category_overrides",
      "budget_entries",
      "budget_income_override",
      "budget_monthly_overrides",
      "income_sources",
      "income_deductions",
      "income_deposits",
      "debt_payments",
      "financed_assets",
      "manual_401k_accounts",
      "future_cash_events",
      "transaction_amortizations",
      // Phase 2: Object storage ACLs (written by setObjectAclPolicy)
      "object_acls",
    ];

    for (const table of vaultIdTables) {
      // Some tables may not exist yet (e.g. financed_assets created later by finance-scope).
      // Use DO block to skip gracefully.
      await pool.query(`
        DO $vault_col$
        BEGIN
          IF to_regclass('public.${table}') IS NOT NULL THEN
            ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS vault_id TEXT;
          END IF;
        END $vault_col$;
      `);
    }

    // Add indexes (idempotent)
    const indexedTables = [
      { table: "sessions", idx: "idx_sessions_vault" },
      { table: "workspace_documents", idx: "idx_ws_doc_vault" },
      { table: "memory_entries", idx: "idx_memory_vault" },
      { table: "library_pages", idx: "idx_library_pages_vault" },
      // Phase 2 indexes
      { table: "calendar_event_metadata", idx: "idx_cal_meta_vault" },
      { table: "persons", idx: "idx_persons_vault" },
    ];
    for (const { table, idx } of indexedTables) {
      await pool.query(`
        DO $vault_idx$
        BEGIN
          IF to_regclass('public.${table}') IS NOT NULL THEN
            CREATE INDEX IF NOT EXISTS ${idx} ON "${table}"(vault_id);
          END IF;
        END $vault_idx$;
      `);
    }

    // ── 4. Create "Personal" vault per account ─────────────────────
    // Uses accounts table as the canonical account registry.
    // The Personal vault is the default vault for each account.
    const { rowCount: createdCount } = await pool.query(`
      INSERT INTO vaults (account_id, name, icon, color, position, is_default)
      SELECT a.id, 'Personal', 'P', '#828A96', 0, true
      FROM accounts a
      WHERE NOT EXISTS (
        SELECT 1 FROM vaults v
        WHERE v.account_id = a.id AND v.is_default = true
      )
    `);
    if (createdCount && createdCount > 0) {
      log.log(`Created ${createdCount} Personal vault(s)`);
    }

    // ── 5. Backfill vault_id on all owned rows ─────────────────────
    // For each table, set vault_id to the account's default vault
    // where vault_id is currently NULL and accountCol is populated.
    // Phase 1 tables use account_id. Finance tables use principal_account_id.
    const backfillTables = [
      // Phase 1
      { table: "sessions", accountCol: "account_id" },
      { table: "messages", accountCol: "account_id" },
      { table: "workspace_documents", accountCol: "account_id" },
      { table: "memory_entries", accountCol: "account_id" },
      { table: "library_pages", accountCol: "account_id" },
      { table: "emotional_states", accountCol: "account_id" },
      { table: "personas", accountCol: "account_id" },
      { table: "skills", accountCol: "account_id" },
      { table: "skill_runs", accountCol: "account_id" },
      { table: "theses", accountCol: "account_id" },
      { table: "signal_sources", accountCol: "account_id" },
      { table: "signal_items", accountCol: "account_id" },
      // Phase 2: Calendar (use account_id)
      { table: "calendar_event_metadata", accountCol: "account_id" },
      { table: "calendar_event_tasks", accountCol: "principal_account_id" },
      { table: "calendar_event_people", accountCol: "principal_account_id" },
      { table: "calendar_event_artifacts", accountCol: "principal_account_id" },
      // Phase 2: People (use account_id)
      { table: "persons", accountCol: "account_id" },
      { table: "simple_people_surface_state", accountCol: "account_id" },
      // Phase 2: Finance (use principal_account_id — maps to accounts.id)
      { table: "plaid_transactions", accountCol: "principal_account_id" },
      { table: "plaid_holdings", accountCol: "principal_account_id" },
      { table: "plaid_liabilities", accountCol: "principal_account_id" },
      { table: "manual_assets", accountCol: "principal_account_id" },
      { table: "manual_liabilities", accountCol: "principal_account_id" },
      { table: "financial_goals", accountCol: "principal_account_id" },
      { table: "recurring_expenses", accountCol: "principal_account_id" },
      { table: "expense_categories", accountCol: "principal_account_id" },
      { table: "merchant_category_overrides", accountCol: "principal_account_id" },
      { table: "budget_entries", accountCol: "principal_account_id" },
      { table: "budget_income_override", accountCol: "principal_account_id" },
      { table: "budget_monthly_overrides", accountCol: "principal_account_id" },
      { table: "income_sources", accountCol: "principal_account_id" },
      { table: "income_deductions", accountCol: "principal_account_id" },
      { table: "income_deposits", accountCol: "principal_account_id" },
      { table: "debt_payments", accountCol: "principal_account_id" },
      { table: "financed_assets", accountCol: "principal_account_id" },
      { table: "manual_401k_accounts", accountCol: "principal_account_id" },
      { table: "future_cash_events", accountCol: "principal_account_id" },
      { table: "transaction_amortizations", accountCol: "principal_account_id" },
    ];

    for (const { table, accountCol } of backfillTables) {
      // Skip if table does not exist (e.g. financed_assets created later)
      const { rows: tableExists } = await pool.query(
        `SELECT to_regclass('public.${table}') AS t`,
      );
      if (!tableExists[0]?.t) continue;

      const { rowCount } = await pool.query(`
        UPDATE "${table}" t
        SET vault_id = v.id
        FROM vaults v
        WHERE v.account_id = t.${accountCol}
          AND v.is_default = true
          AND t.vault_id IS NULL
          AND t.${accountCol} IS NOT NULL
      `);
      if (rowCount && rowCount > 0) {
        log.log(`Backfilled ${rowCount} rows in ${table}`);
      }
    }

    // Backfill object_acls: account lives inside the policy JSONB (owner = user id).
    // Rows owned by "system" or unknown users keep NULL vault_id.
    {
      const { rows: aclTable } = await pool.query(
        `SELECT to_regclass('public.object_acls') AS t`,
      );
      if (aclTable[0]?.t) {
        const { rowCount } = await pool.query(`
          UPDATE object_acls t
          SET vault_id = v.id
          FROM memberships m
          JOIN vaults v ON v.account_id = m.account_id AND v.is_default = true
          WHERE m.user_id = t.policy->>'owner'
            AND t.vault_id IS NULL
        `);
        if (rowCount && rowCount > 0) {
          log.log(`Backfilled ${rowCount} rows in object_acls`);
        }
      }
    }

    // ── 6. Set users.active_vault_id and visible_vault_ids ─────────
    // For each user whose active_vault_id is NULL, set it to the
    // Personal vault of their account (via memberships).
    const { rowCount: usersUpdated } = await pool.query(`
      UPDATE users u
      SET
        active_vault_id = v.id,
        visible_vault_ids = ARRAY[v.id]
      FROM memberships m
      JOIN vaults v ON v.account_id = m.account_id AND v.is_default = true
      WHERE m.user_id = u.id
        AND u.active_vault_id IS NULL
    `);
    if (usersUpdated && usersUpdated > 0) {
      log.log(`Set active_vault_id for ${usersUpdated} user(s)`);
    }

    const elapsed = Date.now() - t0;
    log.log(`Vault schema ensured in ${elapsed}ms`);
  } catch (err) {
    log.error("Failed to ensure vault schema", err);
  }
}
