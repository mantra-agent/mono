import type { Request } from "express";
import type { SQL } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { pool } from "./db";
import { getPrincipal, type Principal } from "./principal";
import {
  combineWithSensitiveVisible,
  combineWithSensitiveWritable,
  sensitiveOwnershipValues,
  type SensitiveOwnerColumns,
} from "./sensitive-scope";
import { createLogger } from "./log";
import {
  plaidAccounts,
  plaidTransactions,
  plaidHoldings,
  plaidLiabilities,
  plaidSyncCursors,
  manualAssets,
  manualLiabilities,
  financialGoals,
  recurringExpenses,
  budgetEntries,
  budgetIncomeOverride,
  budgetMonthlyOverrides,
  incomeSources,
  incomeDeductions,
  incomeDeposits,
  debtPayments,
  financedAssets,
  manual401kAccounts,
  futureCashEvents,
  transactionAmortizations,
  expenseCategories,
  merchantCategoryOverrides,
} from "@shared/schema";

const log = createLogger("FinanceScope");

const FINANCE_SENSITIVE_TABLE_NAMES = [
  "plaid_accounts",
  "plaid_transactions",
  "plaid_holdings",
  "plaid_liabilities",
  "plaid_sync_cursors",
  "manual_assets",
  "manual_liabilities",
  "financial_goals",
  "recurring_expenses",
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
  "expense_categories",
  "merchant_category_overrides",
] as const;

export const financeTables = {
  plaidAccounts,
  plaidTransactions,
  plaidHoldings,
  plaidLiabilities,
  plaidSyncCursors,
  manualAssets,
  manualLiabilities,
  financialGoals,
  recurringExpenses,
  budgetEntries,
  budgetIncomeOverride,
  budgetMonthlyOverrides,
  incomeSources,
  incomeDeductions,
  incomeDeposits,
  debtPayments,
  financedAssets,
  manual401kAccounts,
  futureCashEvents,
  transactionAmortizations,
  expenseCategories,
  merchantCategoryOverrides,
};

type FinanceSensitiveTable = { ownerUserId?: unknown; principalAccountId?: unknown; vaultId?: unknown };

let schemaEnsurePromise: Promise<void> | null = null;
let schemaEnsured = false;

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function principalOrThrow(req: Request): Principal {
  const principal = getPrincipal(req);
  if (!principal) {
    throw Object.assign(new Error("Authentication required"), { status: 401 });
  }
  return principal;
}

export function financeSensitiveColumns(table: FinanceSensitiveTable): SensitiveOwnerColumns {
  if (!table.ownerUserId || !table.principalAccountId) {
    throw new Error("Finance table is missing owner columns in the Drizzle model");
  }
  const cols: SensitiveOwnerColumns = {
    ownerUserId: table.ownerUserId as SensitiveOwnerColumns["ownerUserId"],
    principalAccountId: table.principalAccountId as SensitiveOwnerColumns["principalAccountId"],
  };
  if (table.vaultId) {
    cols.vaultId = table.vaultId as SensitiveOwnerColumns["vaultId"];
  }
  return cols;
}

export function financeSensitiveValues(req: Request) {
  return sensitiveOwnershipValues(principalOrThrow(req));
}

export function visibleFinance(req: Request, table: FinanceSensitiveTable, predicate?: SQL | undefined) {
  return combineWithSensitiveVisible(financeSensitiveColumns(table), predicate, principalOrThrow(req));
}

export function writableFinance(req: Request, table: FinanceSensitiveTable, predicate?: SQL | undefined) {
  return combineWithSensitiveWritable(financeSensitiveColumns(table), predicate, principalOrThrow(req));
}

export function visibleFinanceForCurrentPrincipal(table: FinanceSensitiveTable, predicate?: SQL | undefined) {
  return combineWithSensitiveVisible(financeSensitiveColumns(table), predicate);
}

export async function ensureFinanceSensitiveSchema(): Promise<void> {
  if (schemaEnsured) return;
  schemaEnsurePromise ??= ensureFinanceSensitiveSchemaInner()
    .then(() => {
      schemaEnsured = true;
    })
    .finally(() => {
      schemaEnsurePromise = null;
    });
  await schemaEnsurePromise;
}

async function ensureFinanceSensitiveSchemaInner(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS financed_assets (
      id SERIAL PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'user',
      owner_user_id TEXT,
      account_id TEXT,
      principal_account_id TEXT,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'asset',
      purchase_price REAL NOT NULL DEFAULT 0,
      purchase_date TEXT,
      current_value REAL NOT NULL DEFAULT 0,
      depreciation_method TEXT DEFAULT 'none',
      useful_life_months INTEGER,
      salvage_value REAL DEFAULT 0,
      loan_original_amount REAL,
      loan_balance REAL,
      loan_apr REAL,
      monthly_payment REAL,
      total_payments INTEGER,
      payments_made INTEGER DEFAULT 0,
      loan_start_date TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `);

  for (const tableName of FINANCE_SENSITIVE_TABLE_NAMES) {
    await pool.query(`
      DO $finance_scope$
      BEGIN
        IF to_regclass('public.${tableName}') IS NOT NULL THEN
          ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
          ALTER TABLE ${quoteIdent(tableName)} ADD COLUMN IF NOT EXISTS principal_account_id TEXT;
          CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${tableName}_owner_user`)} ON ${quoteIdent(tableName)}(owner_user_id);
          CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${tableName}_principal_account`)} ON ${quoteIdent(tableName)}(principal_account_id);
        END IF;
      END $finance_scope$;
    `);
  }

  await pool.query(`ALTER TABLE financed_assets ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user'`);
  await pool.query(`ALTER TABLE financed_assets ADD COLUMN IF NOT EXISTS account_id TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_financed_assets_scope_owner ON financed_assets(scope, owner_user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_financed_assets_account ON financed_assets(account_id)`);

  await pool.query(`
    WITH legacy_owner AS (
      SELECT u.id AS user_id, a.id AS account_id
      FROM users u
      INNER JOIN accounts a ON a.owner_user_id = u.id AND a.kind = 'personal'
      ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.created_at ASC
      LIMIT 1
    )
    UPDATE financed_assets f
    SET scope = 'user',
        owner_user_id = COALESCE(f.owner_user_id, legacy_owner.user_id),
        principal_account_id = COALESCE(f.principal_account_id, legacy_owner.account_id),
        account_id = COALESCE(f.account_id, legacy_owner.account_id)
    FROM legacy_owner
    WHERE f.owner_user_id IS NULL OR f.principal_account_id IS NULL OR f.account_id IS NULL
  `);

  // Migrate global unique constraints to composite (column, owner_user_id) for multi-user.
  // budget_entries: category must be unique per user, not globally.
  await pool.query(`
    DO $unique_fix$
    BEGIN
      -- budget_entries: drop global unique on category, add composite
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'budget_entries_category_unique' AND conrelid = 'budget_entries'::regclass) THEN
        ALTER TABLE budget_entries DROP CONSTRAINT budget_entries_category_unique;
      END IF;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_entries_category_owner ON budget_entries(category, owner_user_id);

      -- expense_categories: drop global unique on name, add composite
      IF to_regclass('public.expense_categories') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_categories_name_unique' AND conrelid = 'expense_categories'::regclass) THEN
          ALTER TABLE expense_categories DROP CONSTRAINT expense_categories_name_unique;
        END IF;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_name_owner ON expense_categories(name, owner_user_id);
      END IF;

      -- merchant_category_overrides: drop global unique on merchant_name, add composite
      IF to_regclass('public.merchant_category_overrides') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merchant_category_overrides_merchant_name_unique' AND conrelid = 'merchant_category_overrides'::regclass) THEN
          ALTER TABLE merchant_category_overrides DROP CONSTRAINT merchant_category_overrides_merchant_name_unique;
        END IF;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_cat_overrides_merchant_owner ON merchant_category_overrides(merchant_name, owner_user_id);
      END IF;
    END $unique_fix$;
  `);

  // Backfill ownership for expense_categories and merchant_category_overrides
  for (const tableName of ["expense_categories", "merchant_category_overrides"]) {
    await pool.query(`
      WITH legacy_owner AS (
        SELECT u.id AS user_id, a.id AS account_id
        FROM users u
        INNER JOIN accounts a ON a.owner_user_id = u.id AND a.kind = 'personal'
        ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, u.created_at ASC
        LIMIT 1
      )
      UPDATE ${quoteIdent(tableName)} t
      SET owner_user_id = COALESCE(t.owner_user_id, legacy_owner.user_id),
          principal_account_id = COALESCE(t.principal_account_id, legacy_owner.account_id)
      FROM legacy_owner
      WHERE t.owner_user_id IS NULL OR t.principal_account_id IS NULL
    `);
  }

  log.log("finance sensitive schema ensured");
}

export async function ensureFinanceSensitiveSchemaMiddleware(_req: Request, res: { status: (code: number) => { json: (body: unknown) => void } }, next: (error?: unknown) => void) {
  try {
    await ensureFinanceSensitiveSchema();
    next();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error(`finance sensitive schema ensure failed: ${msg}`);
    res.status(503).json({ error: "Finance access-control schema is unavailable" });
  }
}

export function accountOwnedPredicate(req: Request, accountIdColumn: typeof plaidTransactions.accountId, accountId: string) {
  return visibleFinance(req, plaidTransactions, eq(accountIdColumn, accountId));
}
