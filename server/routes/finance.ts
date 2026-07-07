import type { Express, Request, Response } from "express";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { db } from "../db";
import { eq, and, gte, lte, inArray, lt, sql } from "drizzle-orm";
import { desc } from "drizzle-orm";
import { responsibilityRuns } from "@shared/schema";
import { timerStorage } from "../file-storage/timers";
import {
  manualAssets, insertManualAssetSchema,
  manualLiabilities, insertManualLiabilitySchema,
  financialGoals, insertFinancialGoalSchema,
  recurringExpenses, insertRecurringExpenseSchema,
  budgetEntries, insertBudgetEntrySchema,
  budgetIncomeOverride, insertBudgetIncomeOverrideSchema,
  budgetMonthlyOverrides, insertBudgetMonthlyOverrideSchema,
  expenseCategories, insertExpenseCategorySchema,
  plaidAccounts,
  merchantCategoryOverrides, insertMerchantCategoryOverrideSchema,
  plaidTransactions,
  plaidHoldings,
  incomeSources, insertIncomeSourceSchema,
  incomeDeductions, insertIncomeDeductionSchema,
  incomeDeposits, insertIncomeDepositSchema,
  debtPayments, insertDebtPaymentSchema,
  plaidLiabilities,
  financedAssets, insertFinancedAssetSchema,
  manual401kAccounts, insertManual401kAccountSchema,
  futureCashEvents, insertFutureCashEventSchema,
} from "@shared/schema";
import {
  ensureFinanceSensitiveSchemaMiddleware,
  financeSensitiveValues,
  financeSensitiveColumns,
  principalOrThrow,
  visibleFinance,
  visibleFinanceForCurrentPrincipal,
  writableFinance,
} from "../finance-scope";
import { bumpFinanceAreaActivity, getFinanceAreaActivity } from "../finance-area-activity";
import {
  buildLiabilityItems,
  getTotalLiabilityPayments,
  simulateLiabilityPaydown,
  projectInvestmentGrowth,
  buildFinancedAssetProjectionsFull,
  simulateFinancedAssetsMonth,
  projectFinancedAssets,
  buildInvestmentAccounts,
  calculateNetWorthComponents,
  computeForecastGrid,
  type ForecastResult,
} from "../forecast-helpers";

const log = createLogger("FinanceRoutes");

export async function fetchAndComputeForecast(opts: {
  months?: number;
  pastMonths?: number;
  growthRate?: number;
  startMonth?: string;
}): Promise<ForecastResult> {
  const months = opts.months ?? 12;
  const pastMonths = opts.pastMonths ?? 3;
  const growthRate = opts.growthRate ?? 7;

  const now = new Date();
  let rangeStartDate: Date;
  let rangeEndDate: Date;
  if (opts.startMonth && /^\d{4}-\d{2}$/.test(opts.startMonth)) {
    const [sy, sm] = opts.startMonth.split("-").map(Number);
    rangeStartDate = new Date(sy, sm - 1, 1);
    rangeEndDate = new Date(sy, sm - 1 + months - 1, 28);
  } else {
    rangeStartDate = new Date(now.getFullYear(), now.getMonth() - pastMonths, 1);
    rangeEndDate = new Date(now.getFullYear(), now.getMonth() + months - 1, 28);
  }
  const startDate = `${rangeStartDate.getFullYear()}-${String(rangeStartDate.getMonth() + 1).padStart(2, "0")}-01`;
  const endDate = `${rangeEndDate.getFullYear()}-${String(rangeEndDate.getMonth() + 1).padStart(2, "0")}-${String(rangeEndDate.getDate()).padStart(2, "0")}`;

  const { listAmortizationsWithTxn } = await import("../finance-amortization");

  const [
    txns, sources, deductionRows, depositRows, budgetRows, overrideRows,
    catRows, merchantRows, holdings, manualAssetRows,
    plaidLiabilityRows, manualLiabilityRows, financedAssetRows, accountRows,
    manual401kRows, futureCashEventRows, amortizations,
  ] = await Promise.all([
    db.select().from(plaidTransactions).where(visibleFinanceForCurrentPrincipal(plaidTransactions, and(gte(plaidTransactions.date, startDate), lte(plaidTransactions.date, endDate)))),
    db.select().from(incomeSources).where(visibleFinanceForCurrentPrincipal(incomeSources)),
    db.select().from(incomeDeductions).where(visibleFinanceForCurrentPrincipal(incomeDeductions)),
    db.select().from(incomeDeposits).where(visibleFinanceForCurrentPrincipal(incomeDeposits)),
    db.select().from(budgetEntries).where(visibleFinanceForCurrentPrincipal(budgetEntries)),
    db.select().from(budgetMonthlyOverrides).where(visibleFinanceForCurrentPrincipal(budgetMonthlyOverrides)),
    db.select().from(expenseCategories).where(visibleFinanceForCurrentPrincipal(expenseCategories)),
    db.select().from(merchantCategoryOverrides).where(visibleFinanceForCurrentPrincipal(merchantCategoryOverrides)),
    db.select().from(plaidHoldings).where(visibleFinanceForCurrentPrincipal(plaidHoldings)),
    db.select().from(manualAssets).where(visibleFinanceForCurrentPrincipal(manualAssets)),
    db.select().from(plaidLiabilities).where(visibleFinanceForCurrentPrincipal(plaidLiabilities)),
    db.select().from(manualLiabilities).where(visibleFinanceForCurrentPrincipal(manualLiabilities)),
    db.select().from(financedAssets).where(visibleFinanceForCurrentPrincipal(financedAssets)),
    db.select().from(plaidAccounts).where(visibleFinanceForCurrentPrincipal(plaidAccounts)),
    db.select().from(manual401kAccounts).where(visibleFinanceForCurrentPrincipal(manual401kAccounts)),
    db.select().from(futureCashEvents).where(visibleFinanceForCurrentPrincipal(futureCashEvents)),
    listAmortizationsWithTxn({ activeOnly: true }),
  ]);

  return computeForecastGrid({
    months, pastMonths, growthRate, startMonth: opts.startMonth,
    txns, sources, deductionRows, depositRows, budgetRows, overrideRows,
    catRows, merchantRows, holdings, manualAssetRows,
    plaidLiabilityRows, manualLiabilityRows, financedAssetRows, accountRows,
    manual401kRows, futureCashEventRows, amortizations,
  });
}

export async function registerFinanceRoutes(app: Express) {
  app.use("/api/finance", ensureFinanceSensitiveSchemaMiddleware);

  app.use("/api/finance", (req: Request, res: Response, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      return next();
    }
    res.on("finish", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const path = req.path;
      let area: "budget" | "income" | "categories" | null = null;
      if (path.startsWith("/api/finance/budget")) area = "budget";
      else if (path.startsWith("/api/finance/income-")) area = "income";
      else if (
        path.startsWith("/api/finance/categories") ||
        path.startsWith("/api/finance/merchant-overrides")
      ) area = "categories";
      if (area) {
        bumpFinanceAreaActivity(area).catch((err) => {
          log.warn(`bump finance area activity (${area}) failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    });
    next();
  });

  app.get("/api/finance/manual-assets", requireAuth, async (req: Request, res: Response) => {
    try {
      const assets = await db.select().from(manualAssets).where(visibleFinance(req, manualAssets));
      res.json({ assets });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list manual assets error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/manual-assets", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertManualAssetSchema.parse(req.body);
      const [asset] = await db.insert(manualAssets).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      res.status(201).json(asset);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("create manual asset error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.put("/api/finance/manual-assets/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const parsed = insertManualAssetSchema.partial().parse(req.body);
      const [updated] = await db.update(manualAssets)
        .set({ ...parsed, lastUpdated: new Date() })
        .where(writableFinance(req, manualAssets, eq(manualAssets.id, id)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Asset not found" });
      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("update manual asset error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/manual-assets/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const [deleted] = await db.delete(manualAssets).where(writableFinance(req, manualAssets, eq(manualAssets.id, id))).returning();
      if (!deleted) return res.status(404).json({ error: "Asset not found" });
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete manual asset error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/manual-liabilities", requireAuth, async (req: Request, res: Response) => {
    try {
      const liabilities = await db.select().from(manualLiabilities).where(visibleFinance(req, manualLiabilities));
      res.json({ liabilities });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list manual liabilities error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/manual-liabilities", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertManualLiabilitySchema.parse(req.body);
      const [liability] = await db.insert(manualLiabilities).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      res.status(201).json(liability);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("create manual liability error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.put("/api/finance/manual-liabilities/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const parsed = insertManualLiabilitySchema.partial().parse(req.body);
      const [updated] = await db.update(manualLiabilities)
        .set({ ...parsed, lastUpdated: new Date() })
        .where(writableFinance(req, manualLiabilities, eq(manualLiabilities.id, id)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Liability not found" });
      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("update manual liability error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/manual-liabilities/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const [deleted] = await db.delete(manualLiabilities).where(writableFinance(req, manualLiabilities, eq(manualLiabilities.id, id))).returning();
      if (!deleted) return res.status(404).json({ error: "Liability not found" });
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete manual liability error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.patch("/api/finance/plaid-liabilities/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const setFields: Partial<{
        manualPaymentAmount: number | null;
        aprPercentage: number | null;
        interestRatePercentage: number | null;
        notes: string | null;
        lastUpdated: Date;
      }> = {};
      if (req.body.manualPaymentAmount !== undefined) setFields.manualPaymentAmount = req.body.manualPaymentAmount;
      if (req.body.aprPercentage !== undefined) setFields.aprPercentage = req.body.aprPercentage;
      if (req.body.interestRatePercentage !== undefined) setFields.interestRatePercentage = req.body.interestRatePercentage;
      if (req.body.notes !== undefined) setFields.notes = req.body.notes;
      if (Object.keys(setFields).length === 0) return res.status(400).json({ error: "No valid fields to update" });
      setFields.lastUpdated = new Date();
      const [updated] = await db.update(plaidLiabilities)
        .set(setFields)
        .where(eq(plaidLiabilities.id, id))
        .returning();
      if (!updated) return res.status(404).json({ error: "Liability not found" });
      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("update plaid liability error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.get("/api/finance/total-liability-payments", requireAuth, async (_req: Request, res: Response) => {
    try {
      const [plaidRows, manualRows] = await Promise.all([
        db.select().from(plaidLiabilities).where(visibleFinance(req, plaidLiabilities)),
        db.select().from(manualLiabilities).where(visibleFinance(req, manualLiabilities)),
      ]);
      const items = buildLiabilityItems(plaidRows, manualRows);
      const total = getTotalLiabilityPayments(items);
      res.json({ totalLiabilityPayments: Math.round(total * 100) / 100 });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("total liability payments error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/goals", requireAuth, async (req: Request, res: Response) => {
    try {
      const goals = await db.select().from(financialGoals).where(visibleFinance(req, financialGoals));
      const accounts = await db.select().from(plaidAccounts).where(visibleFinance(req, plaidAccounts));
      const accountMap = new Map(accounts.map(a => [a.accountId, a]));

      const enrichedGoals = goals.map(g => {
        let computedAmount = g.currentAmount || 0;
        if (g.linkedAccountIds && g.linkedAccountIds.length > 0) {
          computedAmount = 0;
          for (const aid of g.linkedAccountIds) {
            const acct = accountMap.get(aid);
            if (acct) {
              computedAmount += acct.currentBalance || 0;
            }
          }
        }
        return { ...g, currentAmount: computedAmount };
      });

      res.json({ goals: enrichedGoals });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list goals error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/goals", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertFinancialGoalSchema.parse(req.body);
      const catLower = (parsed.category || "").toLowerCase().replace(/[_\s]+/g, " ").trim();
      if ((catLower === "emergency fund" || catLower === "savings") &&
          (!parsed.linkedAccountIds || parsed.linkedAccountIds.length === 0)) {
        const depositoryAccounts = await db.select({ accountId: plaidAccounts.accountId })
          .from(plaidAccounts).where(eq(plaidAccounts.type, "depository"));
        if (depositoryAccounts.length > 0) {
          parsed.linkedAccountIds = depositoryAccounts.map(a => a.accountId);
        }
      }
      const [goal] = await db.insert(financialGoals).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      res.status(201).json(goal);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("create goal error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.put("/api/finance/goals/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const parsed = insertFinancialGoalSchema.partial().parse(req.body);
      const [updated] = await db.update(financialGoals)
        .set({ ...parsed, updatedAt: new Date() })
        .where(writableFinance(req, financialGoals, eq(financialGoals.id, id)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Goal not found" });
      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("update goal error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/goals/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const [deleted] = await db.delete(financialGoals).where(writableFinance(req, financialGoals, eq(financialGoals.id, id))).returning();
      if (!deleted) return res.status(404).json({ error: "Goal not found" });
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete goal error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/recurring", requireAuth, async (req: Request, res: Response) => {
    try {
      const expenses = await db.select().from(recurringExpenses).where(visibleFinance(req, recurringExpenses));
      res.json({ expenses });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list recurring expenses error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/recurring", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertRecurringExpenseSchema.parse(req.body);
      const [expense] = await db.insert(recurringExpenses).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      res.status(201).json(expense);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("create recurring expense error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.put("/api/finance/recurring/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const body = { ...req.body };
      if (typeof body.lastReviewedAt === "string") body.lastReviewedAt = new Date(body.lastReviewedAt);
      const parsed = insertRecurringExpenseSchema.partial().parse(body);
      const [updated] = await db.update(recurringExpenses)
        .set(parsed)
        .where(writableFinance(req, recurringExpenses, eq(recurringExpenses.id, id)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Recurring expense not found" });
      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("update recurring expense error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/recurring/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const [deleted] = await db.delete(recurringExpenses).where(writableFinance(req, recurringExpenses, eq(recurringExpenses.id, id))).returning();
      if (!deleted) return res.status(404).json({ error: "Recurring expense not found" });
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete recurring expense error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/budget-entries", requireAuth, async (req: Request, res: Response) => {
    try {
      const entries = await db.select().from(budgetEntries).where(visibleFinance(req, budgetEntries));
      res.json({ entries });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list budget entries error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.put("/api/finance/budget-entries", requireAuth, async (req: Request, res: Response) => {
    try {
      const items = req.body.entries as Array<{ category: string; monthlyAmount: number }>;
      if (!Array.isArray(items)) return res.status(400).json({ error: "entries array required" });
      const ownerValues = financeSensitiveValues(req);
      const results = [];
      for (const item of items) {
        const parsed = insertBudgetEntrySchema.parse(item);
        // Look for existing entry owned by this user for this category
        const existing = await db.select().from(budgetEntries)
          .where(writableFinance(req, budgetEntries, eq(budgetEntries.category, parsed.category)));
        let entry;
        if (existing.length > 0) {
          [entry] = await db.update(budgetEntries)
            .set({ monthlyAmount: parsed.monthlyAmount })
            .where(eq(budgetEntries.id, existing[0].id))
            .returning();
        } else {
          [entry] = await db.insert(budgetEntries)
            .values({ ...parsed, ...ownerValues })
            .returning();
        }
        results.push(entry);
      }
      res.json({ entries: results });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("upsert budget entries error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.get("/api/finance/budget-income-override", requireAuth, async (req: Request, res: Response) => {
    try {
      const rows = await db.select().from(budgetIncomeOverride).where(visibleFinance(req, budgetIncomeOverride));
      const override = rows.length > 0 ? rows[0] : { id: null, monthlyIncome: null, useOverride: false };
      res.json(override);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("get income override error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.put("/api/finance/budget-income-override", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertBudgetIncomeOverrideSchema.parse(req.body);
      const rows = await db.select().from(budgetIncomeOverride).where(visibleFinance(req, budgetIncomeOverride));
      let result;
      if (rows.length > 0) {
        [result] = await db.update(budgetIncomeOverride).set(parsed).where(eq(budgetIncomeOverride.id, rows[0].id)).returning();
      } else {
        [result] = await db.insert(budgetIncomeOverride).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      }
      res.json(result);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("upsert income override error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  const DEFAULT_CATEGORIES: Array<{ name: string; plaidCategory: string; color: string }> = [
    { name: "Food & Drink", plaidCategory: "FOOD_AND_DRINK", color: "#f97316" },
    { name: "Transportation", plaidCategory: "TRANSPORTATION", color: "#3b82f6" },
    { name: "Rent & Utilities", plaidCategory: "RENT_AND_UTILITIES", color: "#8b5cf6" },
    { name: "Shopping", plaidCategory: "GENERAL_MERCHANDISE", color: "#ec4899" },
    { name: "Entertainment", plaidCategory: "ENTERTAINMENT", color: "#f43f5e" },
    { name: "Personal Care", plaidCategory: "PERSONAL_CARE", color: "#14b8a6" },
    { name: "Services", plaidCategory: "GENERAL_SERVICES", color: "#6366f1" },
    { name: "Home", plaidCategory: "HOME_IMPROVEMENT", color: "#84cc16" },
    { name: "Travel", plaidCategory: "TRAVEL", color: "#06b6d4" },
    { name: "Medical", plaidCategory: "MEDICAL", color: "#ef4444" },
    { name: "Other", plaidCategory: "UNCATEGORIZED", color: "#a1a1aa" },
  ];

  app.get("/api/finance/categories", requireAuth, async (req: Request, res: Response) => {
    try {
      let categories = await db.select().from(expenseCategories).where(visibleFinance(req, expenseCategories));
      if (categories.length === 0) {
        const ownerValues = financeSensitiveValues(req);
        for (const def of DEFAULT_CATEGORIES) {
          const [cat] = await db.insert(expenseCategories)
            .values({ name: def.name, isDefault: true, plaidCategory: def.plaidCategory, color: def.color, ...ownerValues })
            .returning();
          if (cat) categories.push(cat);
        }
      }
      res.json({ categories });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list categories error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/categories", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertExpenseCategorySchema.parse({ ...req.body, isDefault: false });
      const [category] = await db.insert(expenseCategories).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      res.status(201).json(category);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("create category error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.put("/api/finance/categories/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const parsed = insertExpenseCategorySchema.partial().parse(req.body);
      const [updated] = await db.update(expenseCategories)
        .set(parsed)
        .where(writableFinance(req, expenseCategories, eq(expenseCategories.id, id)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Category not found" });
      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("update category error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/categories/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const existing = await db.select().from(expenseCategories).where(writableFinance(req, expenseCategories, eq(expenseCategories.id, id)));
      if (existing.length === 0) return res.status(404).json({ error: "Category not found" });
      if (existing[0].isDefault) return res.status(400).json({ error: "Cannot delete default categories" });
      await db.delete(merchantCategoryOverrides).where(writableFinance(req, merchantCategoryOverrides, eq(merchantCategoryOverrides.categoryId, id)));
      await db.delete(expenseCategories).where(writableFinance(req, expenseCategories, eq(expenseCategories.id, id)));
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete category error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/merchant-overrides", requireAuth, async (req: Request, res: Response) => {
    try {
      const overrides = await db.select().from(merchantCategoryOverrides).where(visibleFinance(req, merchantCategoryOverrides));
      res.json({ overrides });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list merchant overrides error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.put("/api/finance/merchant-overrides", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertMerchantCategoryOverrideSchema.parse(req.body);
      const ownerValues = financeSensitiveValues(req);
      // Owner-scoped upsert: find existing by merchant+owner, update or insert
      const existing = await db.select().from(merchantCategoryOverrides)
        .where(writableFinance(req, merchantCategoryOverrides, eq(merchantCategoryOverrides.merchantName, parsed.merchantName)));
      let override;
      if (existing.length > 0) {
        [override] = await db.update(merchantCategoryOverrides)
          .set({ categoryId: parsed.categoryId })
          .where(eq(merchantCategoryOverrides.id, existing[0].id))
          .returning();
      } else {
        [override] = await db.insert(merchantCategoryOverrides)
          .values({ ...parsed, ...ownerValues })
          .returning();
      }
      res.json(override);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("upsert merchant override error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/merchant-overrides/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const [deleted] = await db.delete(merchantCategoryOverrides).where(writableFinance(req, merchantCategoryOverrides, eq(merchantCategoryOverrides.id, id))).returning();
      if (!deleted) return res.status(404).json({ error: "Override not found" });
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete merchant override error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/summary", requireAuth, async (_req: Request, res: Response) => {
    try {
      const { getFinanceSummary } = await import("../plaid-service");
      const summary = await getFinanceSummary();
      res.json(summary);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("finance summary error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/activity", requireAuth, async (req: Request, res: Response) => {
    try {
      const [accountsRow] = await db.select({ ts: sql<Date | null>`max(${plaidAccounts.lastUpdated})` }).from(plaidAccounts).where(visibleFinance(req, plaidAccounts));
      const [txnRow] = await db.select({ ts: sql<Date | null>`max(${plaidTransactions.createdAt})` }).from(plaidTransactions).where(visibleFinance(req, plaidTransactions));
      const [plaidLiabRow] = await db.select({ ts: sql<Date | null>`max(${plaidLiabilities.lastUpdated})` }).from(plaidLiabilities).where(visibleFinance(req, plaidLiabilities));
      const [manualLiabRow] = await db.select({ ts: sql<Date | null>`max(${manualLiabilities.lastUpdated})` }).from(manualLiabilities).where(visibleFinance(req, manualLiabilities));
      const [debtPayRow] = await db.select({ ts: sql<Date | null>`max(${debtPayments.createdAt})` }).from(debtPayments).where(visibleFinance(req, debtPayments));
      const [goalsRow] = await db.select({ ts: sql<Date | null>`max(${financialGoals.updatedAt})` }).from(financialGoals).where(visibleFinance(req, financialGoals));
      const [holdingsRow] = await db.select({ ts: sql<Date | null>`max(${plaidHoldings.lastUpdated})` }).from(plaidHoldings).where(visibleFinance(req, plaidHoldings));
      const [k401Row] = await db.select({ ts: sql<Date | null>`max(${manual401kAccounts.updatedAt})` }).from(manual401kAccounts).where(visibleFinance(req, manual401kAccounts));
      const [manualAssetsRow] = await db.select({ ts: sql<Date | null>`max(${manualAssets.lastUpdated})` }).from(manualAssets).where(visibleFinance(req, manualAssets));
      const [financedAssetsRow] = await db.select({ ts: sql<Date | null>`max(${financedAssets.updatedAt})` }).from(financedAssets).where(visibleFinance(req, financedAssets));
      const [futureCashRow] = await db.select({ ts: sql<Date | null>`max(${futureCashEvents.updatedAt})` }).from(futureCashEvents).where(visibleFinance(req, futureCashEvents));
      const [recurringCreatedRow] = await db.select({ ts: sql<Date | null>`max(${recurringExpenses.createdAt})` }).from(recurringExpenses).where(visibleFinance(req, recurringExpenses));
      const [recurringReviewedRow] = await db.select({ ts: sql<Date | null>`max(${recurringExpenses.lastReviewedAt})` }).from(recurringExpenses).where(visibleFinance(req, recurringExpenses));

      let plaidRefreshTs: Date | null = null;
      try {
        const timers = await timerStorage.getAll();
        const refreshTimerIds = timers.filter(t => t.type === "system" && t.prompt === "plaid-refresh").map(t => t.id);
        if (refreshTimerIds.length > 0) {
          const [runRow] = await db
            .select({ ts: sql<Date | null>`max(${responsibilityRuns.completedAt})` })
            .from(responsibilityRuns)
            .where(and(inArray(responsibilityRuns.responsibilityId, refreshTimerIds), eq(responsibilityRuns.status, "completed")));
          plaidRefreshTs = runRow?.ts ?? null;
        }
      } catch (err) {
        log.warn(`finance activity: timer lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      const [budgetActivity, incomeActivity, categoriesActivity] = await Promise.all([
        getFinanceAreaActivity("budget"),
        getFinanceAreaActivity("income"),
        getFinanceAreaActivity("categories"),
      ]);

      const toIso = (d: Date | null | undefined): string | null =>
        d instanceof Date && !isNaN(d.getTime()) ? d.toISOString() : null;

      const maxIso = (...vals: Array<string | null>): string | null => {
        const tsList = vals
          .filter((v): v is string => typeof v === "string")
          .map(v => Date.parse(v))
          .filter(n => Number.isFinite(n));
        if (tsList.length === 0) return null;
        return new Date(Math.max(...tsList)).toISOString();
      };

      const accountsTs = maxIso(toIso(accountsRow?.ts), toIso(plaidRefreshTs));
      const transactionsTs = toIso(txnRow?.ts);
      const liabilitiesTs = maxIso(toIso(plaidLiabRow?.ts), toIso(manualLiabRow?.ts), toIso(debtPayRow?.ts));
      const goalsTs = toIso(goalsRow?.ts);
      const investmentsTs = maxIso(toIso(holdingsRow?.ts), toIso(k401Row?.ts));
      const assetsTs = maxIso(toIso(manualAssetsRow?.ts), toIso(financedAssetsRow?.ts));
      const recurringTs = maxIso(toIso(recurringCreatedRow?.ts), toIso(recurringReviewedRow?.ts));
      const forecastTs = maxIso(toIso(futureCashRow?.ts), assetsTs, investmentsTs, liabilitiesTs, accountsTs, transactionsTs);

      const areas = {
        home: maxIso(accountsTs, transactionsTs, liabilitiesTs, goalsTs, investmentsTs, assetsTs, recurringTs, forecastTs, budgetActivity, incomeActivity, categoriesActivity),
        goals: goalsTs,
        budget: budgetActivity,
        recurring: recurringTs,
        liabilities: liabilitiesTs,
        transactions: transactionsTs,
        accounts: accountsTs,
        investments: investmentsTs,
        assets: assetsTs,
        income: incomeActivity,
        forecast: forecastTs,
        categories: categoriesActivity,
      };

      const lastActivityAt = areas.home;
      res.json({ lastActivityAt, areas });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("finance activity error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/budget-monthly-overrides", requireAuth, async (req: Request, res: Response) => {
    try {
      const month = req.query.month as string | undefined;
      let overrides;
      if (month) {
        overrides = await db.select().from(budgetMonthlyOverrides).where(visibleFinance(req, budgetMonthlyOverrides, eq(budgetMonthlyOverrides.month, month)));
      } else {
        overrides = await db.select().from(budgetMonthlyOverrides).where(visibleFinanceForCurrentPrincipal(budgetMonthlyOverrides));
      }
      res.json({ overrides });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list monthly overrides error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.put("/api/finance/budget-monthly-overrides", requireAuth, async (req: Request, res: Response) => {
    try {
      const { month, entries } = req.body as { month: string; entries: Array<{ category: string; amount: number }> };
      if (!month || !Array.isArray(entries)) return res.status(400).json({ error: "month and entries array required" });
      await db.delete(budgetMonthlyOverrides).where(writableFinance(req, budgetMonthlyOverrides, eq(budgetMonthlyOverrides.month, month)));
      const ownerValues = financeSensitiveValues(req);
      const results = [];
      for (const entry of entries) {
        if (entry.amount > 0) {
          const [row] = await db.insert(budgetMonthlyOverrides).values({
            category: entry.category,
            month,
            amount: entry.amount,
            ...ownerValues,
          }).returning();
          results.push(row);
        }
      }
      res.json({ overrides: results });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("upsert monthly overrides error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/budget-monthly-overrides/:month", requireAuth, async (req: Request, res: Response) => {
    try {
      const month = req.params.month as string;
      await db.delete(budgetMonthlyOverrides).where(writableFinance(req, budgetMonthlyOverrides, eq(budgetMonthlyOverrides.month, month)));
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete monthly overrides error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/budget-comparison", requireAuth, async (req: Request, res: Response) => {
    try {
      const mode = (req.query.mode as string) || "this_month";
      const now = new Date();
      let startDate: string;
      let endDate: string;
      let divisor = 1;

      if (mode === "last_month") {
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        startDate = lastMonth.toISOString().split("T")[0];
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        endDate = lastMonthEnd.toISOString().split("T")[0];
      } else if (mode === "trailing_avg") {
        const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 12, 1);
        startDate = twelveMonthsAgo.toISOString().split("T")[0];
        const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
        endDate = lastMonthEnd.toISOString().split("T")[0];
        divisor = -1;
      } else {
        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        startDate = thisMonthStart.toISOString().split("T")[0];
        endDate = now.toISOString().split("T")[0];
      }

      const { listAmortizationsWithTxn, getAmortizedSpendingForMonth } = await import("../finance-amortization");
      const [txns, overrideRows, catRows, amortizations] = await Promise.all([
        db.select().from(plaidTransactions).where(visibleFinanceForCurrentPrincipal(plaidTransactions, and(gte(plaidTransactions.date, startDate), lte(plaidTransactions.date, endDate)))),
        db.select().from(merchantCategoryOverrides).where(visibleFinanceForCurrentPrincipal(merchantCategoryOverrides)),
        db.select().from(expenseCategories).where(visibleFinanceForCurrentPrincipal(expenseCategories)),
        listAmortizationsWithTxn({ activeOnly: true }),
      ]);
      const catById = new Map(catRows.map(c => [c.id, c]));
      const merchantMap = new Map(overrideRows.map(o => [o.merchantName.toLowerCase(), o.categoryId]));

      let income = 0;
      let spending = 0;
      const spendingByCategory: Record<string, number> = {};
      const spendingByMonthByCategory: Record<string, Record<string, number>> = {};

      // Internal transfer aggregate — surfaced separately so the UI can render
      // a collapsible row WITHOUT inflating income/spending totals.
      let internalTransferCount = 0;
      let internalTotalIn = 0;
      let internalTotalOut = 0;

      for (const txn of txns) {
        if (txn.isInternalTransfer) {
          internalTransferCount += 1;
          if (txn.amount < 0) internalTotalIn += Math.abs(txn.amount);
          else internalTotalOut += txn.amount;
          continue;
        }
        if (txn.amount < 0) {
          income += Math.abs(txn.amount);
        } else {
          spending += txn.amount;
          let cat = txn.categoryPrimary || "UNCATEGORIZED";
          const merchant = (txn.merchantName || txn.name || "").toLowerCase();
          const overrideCatId = merchantMap.get(merchant);
          if (overrideCatId !== undefined) {
            const catObj = catById.get(overrideCatId);
            cat = catObj?.plaidCategory || catObj?.name || cat;
          }
          spendingByCategory[cat] = (spendingByCategory[cat] || 0) + txn.amount;
          const m = txn.date.substring(0, 7);
          if (!spendingByMonthByCategory[m]) spendingByMonthByCategory[m] = {};
          spendingByMonthByCategory[m][cat] = (spendingByMonthByCategory[m][cat] || 0) + txn.amount;
        }
      }

      const rawTotalsByCategory = { ...spendingByCategory };
      if (amortizations.length > 0) {
        const months = new Set(Object.keys(spendingByMonthByCategory));
        const startM = startDate.substring(0, 7);
        const endM = endDate.substring(0, 7);
        for (const a of amortizations) {
          if (!a.isActive || a.orphaned) continue;
          // Include every month the spread covers (within window) so slices fire.
          for (let i = 0; i < a.spreadMonths; i++) {
            const [sy, sm] = a.startMonth.split("-").map(Number);
            const d = new Date(sy, sm - 1 + i, 1);
            const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            if (m >= startM && m <= endM) months.add(m);
          }
          // Include the txn's own month (within window) so the lump-subtraction
          // fires even when the spread starts later than the txn month.
          if (a.txnMonth && a.txnMonth >= startM && a.txnMonth <= endM) {
            months.add(a.txnMonth);
          }
        }
        const newTotals: Record<string, number> = {};
        let newSpending = 0;
        for (const m of months) {
          const adjusted = getAmortizedSpendingForMonth(m, spendingByMonthByCategory[m] || {}, amortizations);
          for (const [cat, amt] of Object.entries(adjusted)) {
            newTotals[cat] = (newTotals[cat] || 0) + amt;
            newSpending += amt;
          }
        }
        for (const k of Object.keys(spendingByCategory)) delete spendingByCategory[k];
        for (const [k, v] of Object.entries(newTotals)) spendingByCategory[k] = v;
        spending = newSpending;
      }

      let monthsWithData = 0;
      if (divisor === -1 && txns.length > 0) {
        monthsWithData = new Set(txns.map(t => t.date.substring(0, 7))).size;
        divisor = 12;
      } else if (divisor === -1) {
        divisor = 12;
      }

      if (divisor > 1) {
        income = income / divisor;
        spending = spending / divisor;
        for (const cat in spendingByCategory) {
          spendingByCategory[cat] = Math.round(spendingByCategory[cat] / divisor * 100) / 100;
        }
      }

      const internalNet = Math.round((internalTotalIn - internalTotalOut) * 100) / 100;
      res.json({
        mode,
        startDate,
        endDate,
        income: Math.round(income * 100) / 100,
        spending: Math.round(spending * 100) / 100,
        spendingByCategory,
        rawSpendingByCategory: rawTotalsByCategory,
        amortizationActive: amortizations.length > 0,
        monthsWithData,
        internalTransfers: {
          count: internalTransferCount,
          totalIn: Math.round(internalTotalIn * 100) / 100,
          totalOut: Math.round(internalTotalOut * 100) / 100,
          netAmount: internalNet,
        },
        incomeNote: "Income is actual-to-date; budget amounts are full-month targets",
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("budget comparison error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/budget-category-transactions", requireAuth, async (req: Request, res: Response) => {
    try {
      const category = req.query.category as string;
      const startDate = req.query.startDate as string;
      const endDate = req.query.endDate as string;

      if (!category || !startDate || !endDate) {
        return res.status(400).json({ error: "category, startDate, and endDate are required" });
      }

      const txns = await db.select().from(plaidTransactions)
        .where(visibleFinance(req, plaidTransactions, and(gte(plaidTransactions.date, startDate), lte(plaidTransactions.date, endDate))));

      const overrideRows = await db.select().from(merchantCategoryOverrides).where(visibleFinance(req, merchantCategoryOverrides));
      const catRows = await db.select().from(expenseCategories).where(visibleFinance(req, expenseCategories));
      const catById = new Map(catRows.map(c => [c.id, c]));
      const merchantMap = new Map(overrideRows.map(o => [o.merchantName.toLowerCase(), o.categoryId]));

      const filtered = txns.filter(txn => {
        if (txn.isInternalTransfer) return false;
        if (txn.amount < 0) return false;
        let cat = txn.categoryPrimary || "UNCATEGORIZED";
        const merchant = (txn.merchantName || txn.name || "").toLowerCase();
        const overrideCatId = merchantMap.get(merchant);
        if (overrideCatId !== undefined) {
          const catObj = catById.get(overrideCatId);
          cat = catObj?.plaidCategory || catObj?.name || cat;
        }
        return cat === category;
      });

      filtered.sort((a, b) => b.date.localeCompare(a.date));

      res.json({
        transactions: filtered.map(t => ({
          transactionId: t.transactionId,
          date: t.date,
          name: t.name,
          merchantName: t.merchantName,
          amount: t.amount,
        })),
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("budget category transactions error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  // --- Internal transfers ---------------------------------------------------

  app.post("/api/finance/transactions/:id/mark-internal", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const pairWith = typeof req.body?.pairWith === "string" && req.body.pairWith.length > 0
        ? req.body.pairWith
        : undefined;
      const { markInternalTransfer } = await import("../finance-internal-transfers");
      await markInternalTransfer(id, pairWith);
      res.json({ ok: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("mark-internal error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/transactions/:id/unmark-internal", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const { unmarkInternalTransfer } = await import("../finance-internal-transfers");
      await unmarkInternalTransfer(id);
      res.json({ ok: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("unmark-internal error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  // Candidate counterparts for the manual pair picker: transactions in the
  // opposite direction within +/- 7 days at a similar amount, on a different
  // account. Returned ordered by closest amount/date.
  app.get("/api/finance/transactions/:id/pair-candidates", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const [source] = await db.select().from(plaidTransactions).where(visibleFinance(req, plaidTransactions, eq(plaidTransactions.transactionId, id)));
      if (!source) return res.status(404).json({ error: "transaction not found" });

      const sourceDate = new Date(source.date + "T00:00:00Z");
      const minDate = new Date(sourceDate.getTime() - 7 * 86400000).toISOString().slice(0, 10);
      const maxDate = new Date(sourceDate.getTime() + 7 * 86400000).toISOString().slice(0, 10);

      const candidates = await db
        .select()
        .from(plaidTransactions)
        .where(visibleFinance(req, plaidTransactions, and(gte(plaidTransactions.date, minDate), lte(plaidTransactions.date, maxDate))));

      const targetSign = source.amount > 0 ? -1 : 1;
      const filtered = candidates
        .filter(c => c.transactionId !== id)
        .filter(c => c.accountId !== source.accountId)
        .filter(c => Math.sign(c.amount) === targetSign)
        .map(c => ({
          transactionId: c.transactionId,
          accountId: c.accountId,
          date: c.date,
          amount: c.amount,
          name: c.name,
          merchantName: c.merchantName,
          isInternalTransfer: c.isInternalTransfer,
          amountDelta: Math.abs(Math.abs(c.amount) - Math.abs(source.amount)),
          dayDelta: Math.abs(
            (new Date(c.date + "T00:00:00Z").getTime() - sourceDate.getTime()) / 86400000,
          ),
        }))
        .sort((a, b) => a.amountDelta - b.amountDelta || a.dayDelta - b.dayDelta)
        .slice(0, 25);

      res.json({ source: { transactionId: source.transactionId, accountId: source.accountId, date: source.date, amount: source.amount, name: source.name }, candidates: filtered });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error("pair-candidates error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  const FREQUENCY_MULTIPLIERS: Record<string, number> = {
    weekly: 52 / 12,
    biweekly: 26 / 12,
    semimonthly: 2,
    monthly: 1,
    annually: 1 / 12,
  };

  app.get("/api/finance/income-sources", requireAuth, async (req: Request, res: Response) => {
    try {
      const sources = await db.select().from(incomeSources).where(visibleFinance(req, incomeSources));
      const deductions = await db.select().from(incomeDeductions).where(visibleFinance(req, incomeDeductions));
      const deposits = await db.select().from(incomeDeposits).where(visibleFinance(req, incomeDeposits));

      const enriched = sources.map(source => {
        const srcDeductions = deductions.filter(d => d.sourceId === source.id);
        const srcDeposits = deposits.filter(d => d.sourceId === source.id);
        const totalDeductions = srcDeductions.reduce((s, d) => s + d.amount, 0);
        const takeHomePay = source.grossPay - totalDeductions;
        const multiplier = FREQUENCY_MULTIPLIERS[source.payFrequency] || 1;
        const monthlyGross = source.grossPay * multiplier;
        const monthlyNet = takeHomePay * multiplier;

        const deductionsWithMonthly = srcDeductions.map(d => ({
          ...d,
          monthlyAmount: Math.round(d.amount * multiplier * 100) / 100,
        }));
        const totalMonthlyDeductions = Math.round(deductionsWithMonthly.reduce((s, d) => s + d.monthlyAmount, 0) * 100) / 100;

        return {
          ...source,
          deductions: deductionsWithMonthly,
          deposits: srcDeposits,
          takeHomePay,
          monthlyGross: Math.round(monthlyGross * 100) / 100,
          monthlyNet: Math.round(monthlyNet * 100) / 100,
          totalMonthlyDeductions,
        };
      });

      const totalMonthlyGross = enriched.filter(s => s.isActive).reduce((s, src) => s + src.monthlyGross, 0);
      const totalMonthlyNet = enriched.filter(s => s.isActive).reduce((s, src) => s + src.monthlyNet, 0);

      res.json({
        sources: enriched,
        totalMonthlyGross: Math.round(totalMonthlyGross * 100) / 100,
        totalMonthlyNet: Math.round(totalMonthlyNet * 100) / 100,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list income sources error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/income-sources", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertIncomeSourceSchema.parse(req.body);
      const [source] = await db.insert(incomeSources).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      res.status(201).json(source);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("create income source error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.put("/api/finance/income-sources/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const parsed = insertIncomeSourceSchema.partial().parse(req.body);
      const [updated] = await db.update(incomeSources).set(parsed).where(writableFinance(req, incomeSources, eq(incomeSources.id, id))).returning();
      if (!updated) return res.status(404).json({ error: "Income source not found" });
      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("update income source error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/income-sources/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      await db.delete(incomeDeductions).where(eq(incomeDeductions.sourceId, id));
      await db.delete(incomeDeposits).where(eq(incomeDeposits.sourceId, id));
      const [deleted] = await db.delete(incomeSources).where(writableFinance(req, incomeSources, eq(incomeSources.id, id))).returning();
      if (!deleted) return res.status(404).json({ error: "Income source not found" });
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete income source error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/income-deductions", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertIncomeDeductionSchema.parse(req.body);
      const [deduction] = await db.insert(incomeDeductions).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      res.status(201).json(deduction);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("create income deduction error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.put("/api/finance/income-deductions/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const parsed = insertIncomeDeductionSchema.partial().parse(req.body);
      const [updated] = await db.update(incomeDeductions).set(parsed).where(writableFinance(req, incomeDeductions, eq(incomeDeductions.id, id))).returning();
      if (!updated) return res.status(404).json({ error: "Deduction not found" });
      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("update income deduction error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/income-deductions/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const [deleted] = await db.delete(incomeDeductions).where(writableFinance(req, incomeDeductions, eq(incomeDeductions.id, id))).returning();
      if (!deleted) return res.status(404).json({ error: "Deduction not found" });
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete income deduction error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/income-deposits", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertIncomeDepositSchema.parse(req.body);
      const [deposit] = await db.insert(incomeDeposits).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      res.status(201).json(deposit);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("create income deposit error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.put("/api/finance/income-deposits/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const parsed = insertIncomeDepositSchema.partial().parse(req.body);
      const [updated] = await db.update(incomeDeposits).set(parsed).where(writableFinance(req, incomeDeposits, eq(incomeDeposits.id, id))).returning();
      if (!updated) return res.status(404).json({ error: "Deposit not found" });
      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("update income deposit error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/income-deposits/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const [deleted] = await db.delete(incomeDeposits).where(writableFinance(req, incomeDeposits, eq(incomeDeposits.id, id))).returning();
      if (!deleted) return res.status(404).json({ error: "Deposit not found" });
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete income deposit error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  async function getAutoDetectedPayments(req: Request, filterLiabilityId?: number): Promise<Array<{
    id: number;
    liabilityType: string;
    liabilityId: number;
    amount: number;
    date: string;
    fromAccountId: string | null;
    notes: string | null;
    createdAt: Date;
    source: "auto";
    merchantName: string | null;
  }>> {
    const liabilities = filterLiabilityId
      ? await db.select().from(plaidLiabilities).where(visibleFinance(req, plaidLiabilities, eq(plaidLiabilities.id, filterLiabilityId)))
      : await db.select().from(plaidLiabilities).where(visibleFinance(req, plaidLiabilities));

    if (liabilities.length === 0) return [];

    const accountIds = liabilities.map(l => l.accountId);
    const txns = await db.select().from(plaidTransactions)
      .where(visibleFinance(req, plaidTransactions, and(
        inArray(plaidTransactions.accountId, accountIds),
        lt(plaidTransactions.amount, 0),
      )))
      .orderBy(desc(plaidTransactions.date));

    const accountToLiability = new Map(liabilities.map(l => [l.accountId, l]));

    return txns.map(t => {
      const liability = accountToLiability.get(t.accountId)!;
      return {
        id: -t.id,
        liabilityType: "plaid",
        liabilityId: liability.id,
        amount: Math.abs(t.amount),
        date: t.date,
        fromAccountId: null,
        notes: t.merchantName || t.name,
        createdAt: t.createdAt,
        source: "auto" as const,
        merchantName: t.merchantName,
      };
    });
  }

  app.get("/api/finance/debt-payments", requireAuth, async (req: Request, res: Response) => {
    try {
      const liabilityType = req.query.liabilityType as string | undefined;
      const liabilityId = req.query.liabilityId ? parseInt(req.query.liabilityId as string) : undefined;

      let manualPayments;
      if (liabilityType && liabilityId) {
        manualPayments = await db.select().from(debtPayments)
          .where(visibleFinance(req, debtPayments, and(eq(debtPayments.liabilityType, liabilityType), eq(debtPayments.liabilityId, liabilityId))))
          .orderBy(desc(debtPayments.date));
      } else {
        manualPayments = await db.select().from(debtPayments).where(visibleFinance(req, debtPayments)).orderBy(desc(debtPayments.date));
      }

      const manualWithSource = manualPayments.map(p => ({ ...p, source: "manual" as const }));

      const autoFilterId = (liabilityType === "plaid" && liabilityId) ? liabilityId : undefined;
      const autoPayments = (liabilityType === "manual") ? [] : await getAutoDetectedPayments(req, autoFilterId);

      const payments = [...manualWithSource, ...autoPayments]
        .sort((a, b) => b.date.localeCompare(a.date));

      res.json({ payments });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list debt payments error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/debt-payments", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertDebtPaymentSchema.parse(req.body);
      if (parsed.liabilityType !== "plaid" && parsed.liabilityType !== "manual") {
        return res.status(400).json({ error: "liabilityType must be 'plaid' or 'manual'" });
      }
      const [payment] = await db.insert(debtPayments).values({ ...parsed, ...financeSensitiveValues(req) }).returning();

      if (parsed.liabilityType === "manual") {
        const [liability] = await db.select().from(manualLiabilities).where(writableFinance(req, manualLiabilities, eq(manualLiabilities.id, parsed.liabilityId)));
        if (liability) {
          const newBalance = Math.max(0, liability.balance - parsed.amount);
          await db.update(manualLiabilities)
            .set({ balance: newBalance, lastUpdated: new Date() })
            .where(writableFinance(req, manualLiabilities, eq(manualLiabilities.id, parsed.liabilityId)));
        }
      }

      res.status(201).json(payment);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("create debt payment error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/debt-payments/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const [deleted] = await db.delete(debtPayments).where(writableFinance(req, debtPayments, eq(debtPayments.id, id))).returning();
      if (!deleted) return res.status(404).json({ error: "Payment not found" });

      if (deleted.liabilityType === "manual") {
        const [liability] = await db.select().from(manualLiabilities).where(writableFinance(req, manualLiabilities, eq(manualLiabilities.id, deleted.liabilityId)));
        if (liability) {
          const restoredBalance = liability.balance + deleted.amount;
          await db.update(manualLiabilities)
            .set({ balance: restoredBalance, lastUpdated: new Date() })
            .where(writableFinance(req, manualLiabilities, eq(manualLiabilities.id, deleted.liabilityId)));
        }
      }

      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete debt payment error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/liabilities-summary", requireAuth, async (req: Request, res: Response) => {
    try {
      const [manual, plaid, manualPayments, autoPayments, financedAssetRows] = await Promise.all([
        db.select().from(manualLiabilities).where(visibleFinance(req, manualLiabilities)),
        db.select().from(plaidLiabilities).where(visibleFinance(req, plaidLiabilities)),
        db.select().from(debtPayments).where(visibleFinance(req, debtPayments)).orderBy(desc(debtPayments.date)),
        getAutoDetectedPayments(req),
        db.select().from(financedAssets).where(visibleFinance(req, financedAssets)),
      ]);

      const payments = [
        ...manualPayments.map(p => ({ ...p, source: "manual" as const })),
        ...autoPayments,
      ].sort((a, b) => b.date.localeCompare(a.date));

      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const lastMonth = now.getMonth() === 0
        ? `${now.getFullYear() - 1}-12`
        : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, "0")}`;

      const paymentsThisMonth = payments.filter(p => p.date.startsWith(currentMonth));
      const paymentsLastMonth = payments.filter(p => p.date.startsWith(lastMonth));

      const totalPaymentsThisMonth = paymentsThisMonth.reduce((s, p) => s + p.amount, 0);
      const totalPaymentsLastMonth = paymentsLastMonth.reduce((s, p) => s + p.amount, 0);

      const paymentsByLiability: Record<string, typeof payments> = {};
      for (const p of payments) {
        const key = `${p.liabilityType}:${p.liabilityId}`;
        if (!paymentsByLiability[key]) paymentsByLiability[key] = [];
        paymentsByLiability[key].push(p);
      }

      const financedLoanTotal = financedAssetRows.reduce((s, a) => s + (a.loanBalance || 0), 0);

      const totalDebt = manual.reduce((s, l) => s + l.balance, 0)
        + plaid.reduce((s, l) => s + (l.balance || 0), 0)
        + financedLoanTotal;

      const totalMinPayments = manual.reduce((s, l) => s + (l.minimumPayment || 0), 0)
        + plaid.reduce((s, l) => s + (l.minimumPayment || 0), 0)
        + financedAssetRows.reduce((s, a) => s + (a.monthlyPayment || 0), 0);

      res.json({
        totalDebt,
        totalMinPayments,
        totalPaymentsThisMonth,
        totalPaymentsLastMonth,
        paymentCount: payments.length,
        paymentsThisMonthCount: paymentsThisMonth.length,
        paymentsByLiability,
        manualLiabilities: manual,
        plaidLiabilities: plaid,
        financedAssets: financedAssetRows,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("liabilities summary error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/monthly-income", requireAuth, async (req: Request, res: Response) => {
    try {
      const sources = await db.select().from(incomeSources).where(visibleFinance(req, incomeSources));
      const deductions = await db.select().from(incomeDeductions).where(visibleFinance(req, incomeDeductions));

      let totalMonthlyNet = 0;
      let totalMonthlyGross = 0;

      for (const source of sources) {
        if (!source.isActive) continue;
        const multiplier = FREQUENCY_MULTIPLIERS[source.payFrequency] || 1;
        const srcDeductions = deductions.filter(d => d.sourceId === source.id);
        const totalDed = srcDeductions.reduce((s, d) => s + d.amount, 0);
        totalMonthlyGross += source.grossPay * multiplier;
        totalMonthlyNet += (source.grossPay - totalDed) * multiplier;
      }

      res.json({
        monthlyGross: Math.round(totalMonthlyGross * 100) / 100,
        monthlyNet: Math.round(totalMonthlyNet * 100) / 100,
        hasIncomeSources: sources.filter(s => s.isActive).length > 0,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("monthly income error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/forecast", requireAuth, async (req: Request, res: Response) => {
    try {
      const months = Math.min(Math.max(parseInt(req.query.months as string) || 12, 1), 60);
      const pastMonths = Math.min(Math.max(parseInt(req.query.pastMonths as string) || 3, 0), 12);
      const parsedGrowthRate = parseFloat(req.query.growthRate as string);
      const growthRate = isNaN(parsedGrowthRate) ? 7 : parsedGrowthRate;
      const startMonthParam = req.query.startMonth as string | undefined;

      const forecastData = await fetchAndComputeForecast({ months, pastMonths, growthRate, startMonth: startMonthParam });
      res.json(forecastData);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("forecast error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/manual-401k", requireAuth, async (req: Request, res: Response) => {
    try {
      const accounts = await db.select().from(manual401kAccounts).where(visibleFinance(req, manual401kAccounts));
      const deductionRows = await db.select().from(incomeDeductions).where(visibleFinance(req, incomeDeductions));
      const sourceRows = await db.select().from(incomeSources).where(visibleFinance(req, incomeSources));

      const deductionMap = new Map(deductionRows.map(d => [d.id, d]));
      const sourceMap = new Map(sourceRows.map(s => [s.id, s]));

      const enriched = accounts.map(acct => {
        const ded = acct.linkedDeductionId ? deductionMap.get(acct.linkedDeductionId) : null;
        const source = ded ? sourceMap.get(ded.sourceId) : null;
        const mult = source ? (FREQUENCY_MULTIPLIERS[source.payFrequency] || 1) : 1;
        return {
          ...acct,
          linkedDeductionName: ded?.name || null,
          linkedDeductionAmount: ded ? ded.amount : null,
          monthlyContribution: ded ? ded.amount * mult : 0,
        };
      });

      res.json({ accounts: enriched });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("manual-401k list error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/manual-401k", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertManual401kAccountSchema.parse(req.body);
      const [row] = await db.insert(manual401kAccounts).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      res.json(row);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("manual-401k create error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.put("/api/finance/manual-401k/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const parsed = insertManual401kAccountSchema.partial().parse(req.body);
      const [row] = await db.update(manual401kAccounts)
        .set({ ...parsed, updatedAt: new Date() })
        .where(writableFinance(req, manual401kAccounts, eq(manual401kAccounts.id, id)))
        .returning();
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("manual-401k update error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/manual-401k/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const [row] = await db.delete(manual401kAccounts).where(writableFinance(req, manual401kAccounts, eq(manual401kAccounts.id, id))).returning();
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ success: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("manual-401k delete error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/investments", requireAuth, async (req: Request, res: Response) => {
    try {
      const { getHoldingsList, getAccountsList, getPlaidItems, isPlaidConfigured } = await import("../plaid-service");

      const manual401kRows = await db.select().from(manual401kAccounts).where(visibleFinance(req, manual401kAccounts));
      const manual401kTotal = manual401kRows.reduce((s, a) => s + a.currentBalance, 0);

      if (!isPlaidConfigured()) {
        return res.json({
          accounts: [],
          totals: { totalValue: manual401kTotal, totalCostBasis: 0, totalGainLoss: 0, gainLossPercent: 0 },
          allocationByType: manual401kTotal > 0 ? { "401k": 100 } : {},
          manual401kAccounts: manual401kRows,
          manual401kTotal,
        });
      }

      const [holdings, accounts, items] = await Promise.all([
        getHoldingsList(),
        getAccountsList(),
        getPlaidItems(),
      ]);

      const itemMap = new Map(items.map(i => [i.itemId, i.institutionName]));
      const accountMap = new Map(accounts.map(a => [a.accountId, { name: a.name, type: a.type, subtype: a.subtype, itemId: a.itemId, institutionName: itemMap.get(a.itemId) || "Unknown" }]));

      const grouped: Record<string, {
        accountId: string;
        accountName: string;
        institutionName: string;
        holdings: Array<{
          securityId: string;
          securityName: string | null;
          tickerSymbol: string | null;
          securityType: string | null;
          quantity: number;
          costBasis: number | null;
          currentPrice: number | null;
          currentValue: number | null;
          gainLoss: number | null;
          gainLossPercent: number | null;
        }>;
        subtotal: number;
        subtotalCostBasis: number;
      }> = {};

      let totalValue = 0;
      let totalCostBasis = 0;
      const allocationByType: Record<string, number> = {};

      for (const h of holdings) {
        const acct = accountMap.get(h.accountId);
        const key = h.accountId;
        if (!grouped[key]) {
          grouped[key] = {
            accountId: h.accountId,
            accountName: acct?.name || h.accountId,
            institutionName: acct?.institutionName || "Unknown",
            holdings: [],
            subtotal: 0,
            subtotalCostBasis: 0,
          };
        }

        const value = h.institutionValue ?? (h.quantity * (h.institutionPrice ?? 0));
        const costBasis = h.costBasis ?? 0;
        const gainLoss = costBasis > 0 ? value - costBasis : null;
        const gainLossPercent = costBasis > 0 && gainLoss !== null ? (gainLoss / costBasis) * 100 : null;

        grouped[key].holdings.push({
          securityId: h.securityId,
          securityName: h.securityName,
          tickerSymbol: h.tickerSymbol,
          securityType: h.securityType,
          quantity: h.quantity,
          costBasis: h.costBasis,
          currentPrice: h.institutionPrice,
          currentValue: value,
          gainLoss,
          gainLossPercent,
        });

        grouped[key].subtotal += value;
        grouped[key].subtotalCostBasis += costBasis;
        totalValue += value;
        totalCostBasis += costBasis;

        const secType = h.securityType || "other";
        allocationByType[secType] = (allocationByType[secType] || 0) + value;
      }

      const combinedTotalValue = totalValue + manual401kTotal;
      const totalGainLoss = totalCostBasis > 0 ? totalValue - totalCostBasis : 0;
      const gainLossPercent = totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0;

      if (manual401kTotal > 0) {
        allocationByType["401k"] = (allocationByType["401k"] || 0) + manual401kTotal;
      }

      const allocationPct: Record<string, number> = {};
      if (combinedTotalValue > 0) {
        for (const [type, val] of Object.entries(allocationByType)) {
          allocationPct[type] = Math.round((val / combinedTotalValue) * 1000) / 10;
        }
      }

      res.json({
        accounts: Object.values(grouped),
        totals: { totalValue: combinedTotalValue, totalCostBasis, totalGainLoss, gainLossPercent },
        allocationByType: allocationPct,
        manual401kAccounts: manual401kRows,
        manual401kTotal,
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("investments error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/financed-assets", requireAuth, async (req: Request, res: Response) => {
    try {
      const rows = await db.select().from(financedAssets).where(visibleFinance(req, financedAssets));
      res.json(rows);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("financed-assets list error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/financed-assets", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertFinancedAssetSchema.parse(req.body);
      const [row] = await db.insert(financedAssets).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      res.json(row);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("financed-assets create error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.put("/api/finance/financed-assets/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const parsed = insertFinancedAssetSchema.partial().parse(req.body);
      const [row] = await db.update(financedAssets)
        .set({ ...parsed, updatedAt: new Date() })
        .where(writableFinance(req, financedAssets, eq(financedAssets.id, id)))
        .returning();
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("financed-assets update error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/financed-assets/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });
      const [row] = await db.delete(financedAssets)
        .where(writableFinance(req, financedAssets, eq(financedAssets.id, id)))
        .returning();
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ success: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("financed-assets delete error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  interface ColumnMapping {
    date: number;
    description: number;
    amount?: number;
    debit?: number;
    credit?: number;
  }

  function parseColumnMapping(raw: string): ColumnMapping | null {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.date !== "number" || typeof parsed.description !== "number") return null;
      if (typeof parsed.amount !== "number" && (typeof parsed.debit !== "number" || typeof parsed.credit !== "number")) return null;
      return parsed as unknown as ColumnMapping;
    } catch {
      return null;
    }
  }

  function getMulterFile(req: Request): { buffer: Buffer; originalname: string } | null {
    const fileRecord = req as Request & { file?: { buffer: Buffer; originalname: string } };
    return fileRecord.file || null;
  }

  app.post("/api/finance/import-csv", requireAuth, async (req: Request, res: Response) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

      upload.single("file")(req, res, (async (uploadErr: Error | null) => {
        if (uploadErr) {
          return res.status(400).json({ error: `Upload error: ${uploadErr.message}` });
        }
        try {
          const file = getMulterFile(req);
          if (!file) {
            return res.status(400).json({ error: "No file uploaded" });
          }

          const csvContent = file.buffer.toString("utf-8");
          const mappingStr = req.body.mapping as string | undefined;
          const accountId = req.body.accountId as string | undefined;
          const itemId = (req.body.itemId as string) || "csv-import";

          if (!mappingStr || !accountId) {
            return res.status(400).json({ error: "Missing mapping or accountId" });
          }

          const mapping = parseColumnMapping(mappingStr);
          if (!mapping) {
            return res.status(400).json({ error: "Invalid mapping: must include date, description, and amount (or debit+credit) as column indices" });
          }

          const { importCSVTransactions } = await import("../transaction-import");
          const result = await importCSVTransactions(csvContent, mapping as any, accountId, itemId);
          res.json(result);
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          log.error("CSV import processing error:", msg);
          res.status(500).json({ error: msg });
        }
      }) as any);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("CSV import error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/import-csv/preview", requireAuth, async (req: Request, res: Response) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

      upload.single("file")(req, res, (async (uploadErr: Error | null) => {
        if (uploadErr) {
          return res.status(400).json({ error: `Upload error: ${uploadErr.message}` });
        }
        try {
          const file = getMulterFile(req);
          if (!file) {
            return res.status(400).json({ error: "No file uploaded" });
          }

          const csvContent = file.buffer.toString("utf-8");
          const { parseCSV, previewCSVImport } = await import("../transaction-import");
          const { headers, rows } = parseCSV(csvContent);

          const mappingStr = req.body.mapping as string | undefined;
          let preview = null;
          if (mappingStr) {
            const mapping = parseColumnMapping(mappingStr);
            if (mapping) {
              preview = previewCSVImport(csvContent, mapping as any);
            }
          }

          res.json({
            headers,
            rowCount: rows.length,
            sampleRows: rows.slice(0, 5),
            preview,
          });
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          log.error("CSV preview error:", msg);
          res.status(500).json({ error: msg });
        }
      }) as any);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("CSV preview error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/finance/future-cash-events", requireAuth, async (req: Request, res: Response) => {
    try {
      const events = await db.select().from(futureCashEvents).where(visibleFinance(req, futureCashEvents));
      res.json({ events });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list future cash events error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/future-cash-events", requireAuth, async (req: Request, res: Response) => {
    try {
      const parsed = insertFutureCashEventSchema.parse(req.body);
      const [event] = await db.insert(futureCashEvents).values({ ...parsed, ...financeSensitiveValues(req) }).returning();
      res.status(201).json(event);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("create future cash event error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.put("/api/finance/future-cash-events/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const parsed = insertFutureCashEventSchema.partial().parse(req.body);
      const [updated] = await db.update(futureCashEvents)
        .set({ ...parsed, updatedAt: new Date() })
        .where(writableFinance(req, futureCashEvents, eq(futureCashEvents.id, id)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Event not found" });
      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("update future cash event error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/future-cash-events/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const [deleted] = await db.delete(futureCashEvents).where(writableFinance(req, futureCashEvents, eq(futureCashEvents.id, id))).returning();
      if (!deleted) return res.status(404).json({ error: "Event not found" });
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete future cash event error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  // ----- Transaction Amortizations -----

  app.get("/api/finance/amortizations", requireAuth, async (req: Request, res: Response) => {
    try {
      const activeOnly = req.query.activeOnly === "true";
      const { listAmortizationsWithTxn } = await import("../finance-amortization");
      const amortizations = await listAmortizationsWithTxn({ activeOnly });
      res.json({ amortizations });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("list amortizations error:", msg);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/finance/amortizations", requireAuth, async (req: Request, res: Response) => {
    try {
      const { insertTransactionAmortizationSchema } = await import("@shared/schema");
      const { createAmortization } = await import("../finance-amortization");
      const parsed = insertTransactionAmortizationSchema.parse(req.body);
      if (parsed.spreadMonths < 1 || parsed.spreadMonths > 120) {
        return res.status(400).json({ error: "spreadMonths must be between 1 and 120" });
      }
      if (!/^\d{4}-\d{2}$/.test(parsed.startMonth)) {
        return res.status(400).json({ error: "startMonth must be YYYY-MM" });
      }
      const row = await createAmortization(parsed);
      res.status(201).json(row);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("create amortization error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.patch("/api/finance/amortizations/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const { updateAmortization } = await import("../finance-amortization");
      const patch: Partial<{ spreadMonths: number; isActive: boolean; startMonth: string; category: string; notes: string | null }> = {};
      if (typeof req.body.spreadMonths === "number") {
        if (req.body.spreadMonths < 1 || req.body.spreadMonths > 120) {
          return res.status(400).json({ error: "spreadMonths must be between 1 and 120" });
        }
        patch.spreadMonths = req.body.spreadMonths;
      }
      if (typeof req.body.isActive === "boolean") patch.isActive = req.body.isActive;
      if (typeof req.body.startMonth === "string") {
        if (!/^\d{4}-\d{2}$/.test(req.body.startMonth)) {
          return res.status(400).json({ error: "startMonth must be YYYY-MM" });
        }
        patch.startMonth = req.body.startMonth;
      }
      if (typeof req.body.category === "string") patch.category = req.body.category;
      if (typeof req.body.notes === "string" || req.body.notes === null) patch.notes = req.body.notes;
      const updated = await updateAmortization(id, patch);
      if (!updated) return res.status(404).json({ error: "Amortization not found" });
      res.json(updated);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("update amortization error:", msg);
      res.status(400).json({ error: msg });
    }
  });

  app.delete("/api/finance/amortizations/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
      const { softDeleteAmortization } = await import("../finance-amortization");
      const ok = await softDeleteAmortization(id);
      if (!ok) return res.status(404).json({ error: "Amortization not found" });
      res.json({ deleted: true });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      log.error("delete amortization error:", msg);
      res.status(500).json({ error: msg });
    }
  });
}
