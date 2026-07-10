import { pgTable, serial, text, timestamp, jsonb, real, boolean, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";

export const plaidAccounts = pgTable("plaid_accounts", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  accountId: text("account_id").notNull().unique(),
  itemId: text("item_id").notNull(),
  name: text("name").notNull(),
  officialName: text("official_name"),
  type: text("type").notNull(),
  subtype: text("subtype"),
  mask: text("mask"),
  currencyCode: text("currency_code").default("USD"),
  currentBalance: real("current_balance"),
  availableBalance: real("available_balance"),
  creditLimit: real("credit_limit"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertPlaidAccountSchema = createInsertSchema(plaidAccounts).omit({ id: true , ownerUserId: true, principalAccountId: true});
export type PlaidAccount = typeof plaidAccounts.$inferSelect;
export type InsertPlaidAccount = z.infer<typeof insertPlaidAccountSchema>;

export const plaidTransactions = pgTable("plaid_transactions", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  transactionId: text("transaction_id").notNull().unique(),
  accountId: text("account_id").notNull(),
  itemId: text("item_id").notNull(),
  date: text("date").notNull(),
  amount: real("amount").notNull(),
  currencyCode: text("currency_code").default("USD"),
  name: text("name").notNull(),
  merchantName: text("merchant_name"),
  categoryPrimary: text("category_primary"),
  categoryDetailed: text("category_detailed"),
  categoryConfidence: text("category_confidence"),
  pending: boolean("pending").default(false),
  locationCity: text("location_city"),
  locationRegion: text("location_region"),
  isRecurring: boolean("is_recurring").default(false),
  recurringStreamId: text("recurring_stream_id"),
  source: text("source").default("plaid"),
  transferPairId: text("transfer_pair_id"),
  isInternalTransfer: boolean("is_internal_transfer").notNull().default(false),
  transferPairSource: text("transfer_pair_source"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertPlaidTransactionSchema = createInsertSchema(plaidTransactions).omit({ id: true, createdAt: true , ownerUserId: true, principalAccountId: true});
export type PlaidTransaction = typeof plaidTransactions.$inferSelect;
export type InsertPlaidTransaction = z.infer<typeof insertPlaidTransactionSchema>;

export const transferPairOverrides = pgTable("transfer_pair_overrides", {
  id: serial("id").primaryKey(),
  transactionId: text("transaction_id").notNull().unique(),
  pairWithTransactionId: text("pair_with_transaction_id"),
  forceMarkInternal: boolean("force_mark_internal").notNull().default(false),
  forceUnmark: boolean("force_unmark").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertTransferPairOverrideSchema = createInsertSchema(transferPairOverrides).omit({ id: true, createdAt: true, updatedAt: true });
export type TransferPairOverride = typeof transferPairOverrides.$inferSelect;
export type InsertTransferPairOverride = z.infer<typeof insertTransferPairOverrideSchema>;

export const appMigrations = pgTable("app_migrations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  ranAt: timestamp("ran_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  metadata: jsonb("metadata"),
});

export const plaidSecurities = pgTable("plaid_securities", {
  id: serial("id").primaryKey(),
  securityId: text("security_id").notNull().unique(),
  name: text("name"),
  tickerSymbol: text("ticker_symbol"),
  type: text("type"),
  closePrice: real("close_price"),
  closePriceAsOf: text("close_price_as_of"),
  currencyCode: text("currency_code").default("USD"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertPlaidSecuritySchema = createInsertSchema(plaidSecurities).omit({ id: true });
export type PlaidSecurity = typeof plaidSecurities.$inferSelect;
export type InsertPlaidSecurity = z.infer<typeof insertPlaidSecuritySchema>;

export const plaidHoldings = pgTable("plaid_holdings", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  accountId: text("account_id").notNull(),
  itemId: text("item_id").notNull(),
  securityId: text("security_id").notNull(),
  quantity: real("quantity").notNull(),
  costBasis: real("cost_basis"),
  institutionValue: real("institution_value"),
  institutionPrice: real("institution_price"),
  currencyCode: text("currency_code").default("USD"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertPlaidHoldingSchema = createInsertSchema(plaidHoldings).omit({ id: true , ownerUserId: true, principalAccountId: true});
export type PlaidHolding = typeof plaidHoldings.$inferSelect;
export type InsertPlaidHolding = z.infer<typeof insertPlaidHoldingSchema>;

export const plaidLiabilities = pgTable("plaid_liabilities", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  accountId: text("account_id").notNull(),
  itemId: text("item_id").notNull(),
  liabilityType: text("liability_type").notNull(),
  balance: real("balance"),
  creditLimit: real("credit_limit"),
  aprPercentage: real("apr_percentage"),
  aprType: text("apr_type"),
  minimumPayment: real("minimum_payment"),
  manualPaymentAmount: real("manual_payment_amount"),
  nextPaymentDueDate: text("next_payment_due_date"),
  interestRatePercentage: real("interest_rate_percentage"),
  originationDate: text("origination_date"),
  loanTerm: text("loan_term"),
  notes: text("notes"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertPlaidLiabilitySchema = createInsertSchema(plaidLiabilities).omit({ id: true , ownerUserId: true, principalAccountId: true});
export type PlaidLiability = typeof plaidLiabilities.$inferSelect;
export type InsertPlaidLiability = z.infer<typeof insertPlaidLiabilitySchema>;

export const plaidSyncCursors = pgTable("plaid_sync_cursors", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  itemId: text("item_id").notNull().unique(),
  cursor: text("cursor"),
  lastSynced: timestamp("last_synced", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  syncStatus: text("sync_status").default("idle").notNull(),
  pagesCompleted: integer("pages_completed").default(0).notNull(),
  totalAdded: integer("total_added").default(0).notNull(),
  syncError: text("sync_error"),
  syncStartedAt: timestamp("sync_started_at", { withTimezone: true }),
  lastSyncAttempt: timestamp("last_sync_attempt", { withTimezone: true }),
  needsInvestigation: boolean("needs_investigation").default(false).notNull(),
});

export const insertPlaidSyncCursorSchema = createInsertSchema(plaidSyncCursors).omit({ id: true , ownerUserId: true, principalAccountId: true});
export type PlaidSyncCursor = typeof plaidSyncCursors.$inferSelect;
export type InsertPlaidSyncCursor = z.infer<typeof insertPlaidSyncCursorSchema>;

export const manualAssets = pgTable("manual_assets", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  name: text("name").notNull(),
  category: text("category").notNull(),
  currentValue: real("current_value").notNull(),
  notes: text("notes"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertManualAssetSchema = createInsertSchema(manualAssets).omit({ id: true, createdAt: true , ownerUserId: true, principalAccountId: true});
export type ManualAsset = typeof manualAssets.$inferSelect;
export type InsertManualAsset = z.infer<typeof insertManualAssetSchema>;

export const manualLiabilities = pgTable("manual_liabilities", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  name: text("name").notNull(),
  category: text("category").notNull(),
  balance: real("balance").notNull(),
  aprPercentage: real("apr_percentage"),
  minimumPayment: real("minimum_payment"),
  manualPaymentAmount: real("manual_payment_amount"),
  nextPaymentDueDate: text("next_payment_due_date"),
  notes: text("notes"),
  lastUpdated: timestamp("last_updated", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertManualLiabilitySchema = createInsertSchema(manualLiabilities).omit({ id: true, createdAt: true , ownerUserId: true, principalAccountId: true});
export type ManualLiability = typeof manualLiabilities.$inferSelect;
export type InsertManualLiability = z.infer<typeof insertManualLiabilitySchema>;

export const financialGoals = pgTable("financial_goals", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  name: text("name").notNull(),
  targetAmount: real("target_amount").notNull(),
  currentAmount: real("current_amount").notNull().default(0),
  category: text("category").notNull(),
  linkedAccountIds: text("linked_account_ids").array(),
  notes: text("notes"),
  targetDate: text("target_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertFinancialGoalSchema = createInsertSchema(financialGoals).omit({ id: true, createdAt: true, updatedAt: true , ownerUserId: true, principalAccountId: true});
export type FinancialGoal = typeof financialGoals.$inferSelect;
export type InsertFinancialGoal = z.infer<typeof insertFinancialGoalSchema>;

export const recurringExpenses = pgTable("recurring_expenses", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  name: text("name").notNull(),
  amount: real("amount").notNull(),
  frequency: text("frequency").notNull(),
  category: text("category").notNull(),
  nextDueDate: text("next_due_date"),
  lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
  source: text("source").notNull().default("manual"),
  transactionPattern: text("transaction_pattern"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertRecurringExpenseSchema = createInsertSchema(recurringExpenses).omit({ id: true, createdAt: true , ownerUserId: true, principalAccountId: true});
export type RecurringExpense = typeof recurringExpenses.$inferSelect;
export type InsertRecurringExpense = z.infer<typeof insertRecurringExpenseSchema>;

export const expenseCategories = pgTable("expense_categories", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  plaidCategory: text("plaid_category"),
  color: text("color"),
});

export const insertExpenseCategorySchema = createInsertSchema(expenseCategories).omit({ id: true, ownerUserId: true, principalAccountId: true });
export type ExpenseCategory = typeof expenseCategories.$inferSelect;
export type InsertExpenseCategory = z.infer<typeof insertExpenseCategorySchema>;

export const merchantCategoryOverrides = pgTable("merchant_category_overrides", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  merchantName: text("merchant_name").notNull(),
  categoryId: integer("category_id").notNull(),
});

export const insertMerchantCategoryOverrideSchema = createInsertSchema(merchantCategoryOverrides).omit({ id: true, ownerUserId: true, principalAccountId: true });
export type MerchantCategoryOverride = typeof merchantCategoryOverrides.$inferSelect;
export type InsertMerchantCategoryOverride = z.infer<typeof insertMerchantCategoryOverrideSchema>;

export const budgetEntries = pgTable("budget_entries", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  category: text("category").notNull(),
  monthlyAmount: real("monthly_amount").notNull().default(0),
});

export const insertBudgetEntrySchema = createInsertSchema(budgetEntries).omit({ id: true , ownerUserId: true, principalAccountId: true});
export type BudgetEntry = typeof budgetEntries.$inferSelect;
export type InsertBudgetEntry = z.infer<typeof insertBudgetEntrySchema>;

export const budgetIncomeOverride = pgTable("budget_income_override", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  monthlyIncome: real("monthly_income"),
  useOverride: boolean("use_override").notNull().default(false),
});

export const insertBudgetIncomeOverrideSchema = createInsertSchema(budgetIncomeOverride).omit({ id: true , ownerUserId: true, principalAccountId: true});
export type BudgetIncomeOverride = typeof budgetIncomeOverride.$inferSelect;
export type InsertBudgetIncomeOverride = z.infer<typeof insertBudgetIncomeOverrideSchema>;

export const budgetMonthlyOverrides = pgTable("budget_monthly_overrides", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  category: text("category").notNull(),
  month: text("month").notNull(),
  amount: real("amount").notNull(),
});

export const insertBudgetMonthlyOverrideSchema = createInsertSchema(budgetMonthlyOverrides).omit({ id: true , ownerUserId: true, principalAccountId: true});
export type BudgetMonthlyOverride = typeof budgetMonthlyOverrides.$inferSelect;
export type InsertBudgetMonthlyOverride = z.infer<typeof insertBudgetMonthlyOverrideSchema>;

export const incomeSources = pgTable("income_sources", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  name: text("name").notNull(),
  grossPay: real("gross_pay").notNull(),
  payFrequency: text("pay_frequency").notNull(),
  effectiveDate: text("effective_date"),
  isActive: boolean("is_active").notNull().default(true),
});

export const insertIncomeSourceSchema = createInsertSchema(incomeSources).omit({ id: true , ownerUserId: true, principalAccountId: true});
export type IncomeSource = typeof incomeSources.$inferSelect;
export type InsertIncomeSource = z.infer<typeof insertIncomeSourceSchema>;

export const incomeDeductions = pgTable("income_deductions", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  sourceId: integer("source_id").notNull(),
  name: text("name").notNull(),
  amount: real("amount").notNull(),
  isPreTax: boolean("is_pre_tax").notNull().default(true),
});

export const insertIncomeDeductionSchema = createInsertSchema(incomeDeductions).omit({ id: true , ownerUserId: true, principalAccountId: true});
export type IncomeDeduction = typeof incomeDeductions.$inferSelect;
export type InsertIncomeDeduction = z.infer<typeof insertIncomeDeductionSchema>;

export const incomeDeposits = pgTable("income_deposits", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  sourceId: integer("source_id").notNull(),
  accountId: text("account_id"),
  accountLabel: text("account_label"),
  amount: real("amount").notNull(),
});

export const insertIncomeDepositSchema = createInsertSchema(incomeDeposits).omit({ id: true , ownerUserId: true, principalAccountId: true});
export type IncomeDeposit = typeof incomeDeposits.$inferSelect;
export type InsertIncomeDeposit = z.infer<typeof insertIncomeDepositSchema>;

export const debtPayments = pgTable("debt_payments", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  liabilityType: text("liability_type").notNull(),
  liabilityId: integer("liability_id").notNull(),
  amount: real("amount").notNull(),
  date: text("date").notNull(),
  fromAccountId: text("from_account_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertDebtPaymentSchema = createInsertSchema(debtPayments).omit({ id: true, createdAt: true , ownerUserId: true, principalAccountId: true});
export type DebtPayment = typeof debtPayments.$inferSelect;
export type InsertDebtPayment = z.infer<typeof insertDebtPaymentSchema>;

export const financedAssets = pgTable("financed_assets", {
  id: serial("id").primaryKey(),
  scope: text("scope").notNull().default("user"),
  ownerUserId: text("owner_user_id"),
  accountId: text("account_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  name: text("name").notNull(),
  category: text("category").notNull(),
  purchasePrice: real("purchase_price").notNull(),
  purchaseDate: text("purchase_date"),
  currentValue: real("current_value").notNull(),
  depreciationMethod: text("depreciation_method").default("none"),
  usefulLifeMonths: integer("useful_life_months"),
  salvageValue: real("salvage_value").default(0),
  loanOriginalAmount: real("loan_original_amount"),
  loanBalance: real("loan_balance"),
  loanApr: real("loan_apr"),
  monthlyPayment: real("monthly_payment"),
  totalPayments: integer("total_payments"),
  paymentsMade: integer("payments_made").default(0),
  loanStartDate: text("loan_start_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertFinancedAssetSchema = createInsertSchema(financedAssets).omit({ id: true, scope: true, ownerUserId: true, accountId: true, createdAt: true, updatedAt: true , principalAccountId: true});
export type FinancedAsset = typeof financedAssets.$inferSelect;
export type InsertFinancedAsset = z.infer<typeof insertFinancedAssetSchema>;

export const manual401kAccounts = pgTable("manual_401k_accounts", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  name: text("name").notNull(),
  currentBalance: real("current_balance").notNull(),
  linkedDeductionId: integer("linked_deduction_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertManual401kAccountSchema = createInsertSchema(manual401kAccounts).omit({ id: true, createdAt: true, updatedAt: true , ownerUserId: true, principalAccountId: true});
export type Manual401kAccount = typeof manual401kAccounts.$inferSelect;
export type InsertManual401kAccount = z.infer<typeof insertManual401kAccountSchema>;

export const futureCashEvents = pgTable("future_cash_events", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  category: text("category").notNull(),
  amount: real("amount").notNull(),
  date: text("date").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertFutureCashEventSchema = createInsertSchema(futureCashEvents).omit({ id: true, createdAt: true, updatedAt: true , ownerUserId: true, principalAccountId: true});
export type FutureCashEvent = typeof futureCashEvents.$inferSelect;
export type InsertFutureCashEvent = z.infer<typeof insertFutureCashEventSchema>;

export const transactionAmortizations = pgTable("transaction_amortizations", {
  id: serial("id").primaryKey(),
  ownerUserId: text("owner_user_id"),
  principalAccountId: text("principal_account_id"),
  vaultId: text("vault_id"),
  transactionId: text("transaction_id").notNull(),
  originalAmount: real("original_amount").notNull(),
  spreadMonths: integer("spread_months").notNull(),
  startMonth: text("start_month").notNull(),
  category: text("category").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertTransactionAmortizationSchema = createInsertSchema(transactionAmortizations).omit({ id: true, createdAt: true , ownerUserId: true, principalAccountId: true});
export type TransactionAmortization = typeof transactionAmortizations.$inferSelect;
export type InsertTransactionAmortization = z.infer<typeof insertTransactionAmortizationSchema>;
