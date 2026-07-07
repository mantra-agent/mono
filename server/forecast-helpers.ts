import { createLogger } from "./log";
import type { PlaidLiability, ManualLiability, FinancedAsset, PlaidHolding, ManualAsset, PlaidTransaction, IncomeSource, IncomeDeduction, IncomeDeposit, BudgetEntry, BudgetMonthlyOverride, ExpenseCategory, MerchantCategoryOverride, PlaidAccount, Manual401kAccount, FutureCashEvent } from "@shared/schema";
import { getAmortizedSpendingForMonth, type AmortizationWithTxn } from "./finance-amortization";

const log = createLogger("ForecastHelpers");

export interface LiabilityItem {
  name: string;
  balance: number;
  apr: number;
  minPayment: number;
  manualPayment: number;
  effectivePayment: number;
}

export interface NetWorthComponents {
  plaidAssetTotal: number;
  manualAssetTotal: number;
  financedAssetValueTotal: number;
  investmentTotal: number;
  cashBalance: number;
  plaidLiabilityTotal: number;
  manualLiabilityTotal: number;
  financedLoanBalanceTotal: number;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
}

export function calculateNetWorthComponents(opts: {
  plaidAssetTotal: number;
  manualAssetTotal: number;
  financedAssetValueTotal: number;
  investmentTotal: number;
  cashBalance: number;
  plaidLiabilityTotal: number;
  manualLiabilityTotal: number;
  financedLoanBalanceTotal: number;
}): NetWorthComponents {
  const totalAssets = opts.plaidAssetTotal + opts.manualAssetTotal + opts.financedAssetValueTotal + opts.investmentTotal + opts.cashBalance;
  const totalLiabilities = opts.plaidLiabilityTotal + opts.manualLiabilityTotal + opts.financedLoanBalanceTotal;
  const netWorth = totalAssets - totalLiabilities;

  log.debug("calculateNetWorthComponents", {
    totalAssets,
    totalLiabilities,
    netWorth,
    breakdown: opts,
  });

  return { ...opts, totalAssets, totalLiabilities, netWorth };
}

export function buildLiabilityItems(
  plaidLiabilities: PlaidLiability[],
  manualLiabilitiesArr: ManualLiability[],
  accountNameMap?: Map<string, string>,
  financedAssetRows?: FinancedAsset[],
): LiabilityItem[] {
  const items: LiabilityItem[] = [];
  const accountIds: (string | null)[] = [];

  for (const pl of plaidLiabilities) {
    const minPay = pl.minimumPayment || 0;
    const manualPay = pl.manualPaymentAmount || 0;
    const acctName = accountNameMap?.get(pl.accountId) || pl.liabilityType;
    items.push({
      name: acctName,
      balance: pl.balance || 0,
      apr: pl.aprPercentage || pl.interestRatePercentage || 0,
      minPayment: minPay,
      manualPayment: manualPay,
      effectivePayment: manualPay > 0 ? manualPay : minPay,
    });
    accountIds.push(pl.accountId);
  }

  for (const ml of manualLiabilitiesArr) {
    const minPay = ml.minimumPayment || 0;
    const manualPay = ml.manualPaymentAmount || 0;
    items.push({
      name: ml.name,
      balance: ml.balance,
      apr: ml.aprPercentage || 0,
      minPayment: minPay,
      manualPayment: manualPay,
      effectivePayment: manualPay > 0 ? manualPay : minPay,
    });
    accountIds.push(null);
  }

  if (financedAssetRows) {
    for (const fa of financedAssetRows) {
      if (fa.loanBalance && fa.loanBalance > 0) {
        const payment = fa.monthlyPayment || 0;
        items.push({
          name: fa.name,
          balance: fa.loanBalance,
          apr: fa.loanApr || 0,
          minPayment: payment,
          manualPayment: 0,
          effectivePayment: payment,
        });
        accountIds.push(null);
      }
    }
  }

  const nameCount = new Map<string, number>();
  for (const item of items) {
    nameCount.set(item.name, (nameCount.get(item.name) || 0) + 1);
  }

  const nameSeen = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const original = items[i].name;
    if ((nameCount.get(original) || 0) > 1) {
      const idx = nameSeen.get(original) || 0;
      nameSeen.set(original, idx + 1);
      const acctId = accountIds[i];
      const suffix = acctId && acctId.length >= 4
        ? acctId.slice(-4)
        : String(idx + 1);
      items[i].name = `${original} (${suffix})`;
    }
  }

  const finalNames = new Set<string>();
  for (const item of items) {
    let name = item.name;
    let counter = 2;
    while (finalNames.has(name)) {
      name = `${item.name}-${counter}`;
      counter++;
    }
    item.name = name;
    finalNames.add(name);
  }

  return items;
}

export function getTotalLiabilityPayments(items: LiabilityItem[]): number {
  const total = items.reduce((s, l) => s + l.effectivePayment, 0);
  log.debug("getTotalLiabilityPayments", { total, count: items.length });
  return total;
}

export function simulateLiabilityPaydown(
  items: LiabilityItem[],
  _month: string,
): { breakdown: Record<string, number>; totalLiab: number; totalPayments: number } {
  let totalLiab = 0;
  let totalPayments = 0;
  const breakdown: Record<string, number> = {};

  for (const li of items) {
    if (li.balance > 0 && li.effectivePayment > 0) {
      const interest = (li.balance * li.apr / 100) / 12;
      const principal = Math.max(0, li.effectivePayment - interest);
      li.balance = Math.max(0, li.balance - principal);
      totalPayments += li.effectivePayment;
    }
    breakdown[li.name] = Math.round(li.balance * 100) / 100;
    totalLiab += li.balance;
  }

  log.debug("simulateLiabilityPaydown", { month: _month, totalLiab: Math.round(totalLiab * 100) / 100, totalPayments: Math.round(totalPayments * 100) / 100 });
  return { breakdown, totalLiab, totalPayments };
}

export function projectInvestmentGrowth(
  balance: number,
  monthlyContribution: number,
  monthlyGrowthRate: number,
): number {
  const grown = balance * (1 + monthlyGrowthRate) + monthlyContribution;
  log.debug("projectInvestmentGrowth", {
    inputBalance: Math.round(balance * 100) / 100,
    contribution: Math.round(monthlyContribution * 100) / 100,
    growthRate: monthlyGrowthRate,
    result: Math.round(grown * 100) / 100,
  });
  return grown;
}

export interface FinancedAssetProjection {
  name: string;
  currentValue: number;
  loanBalance: number;
}

export function projectFinancedAssets(
  assets: FinancedAssetProjection[],
  _month: string,
): { totalValue: number; totalLoanBalance: number; breakdown: Record<string, { value: number; loan: number }> } {
  let totalValue = 0;
  let totalLoanBalance = 0;
  const breakdown: Record<string, { value: number; loan: number }> = {};

  for (const asset of assets) {
    totalValue += asset.currentValue;
    totalLoanBalance += asset.loanBalance;
    breakdown[asset.name] = {
      value: Math.round(asset.currentValue * 100) / 100,
      loan: Math.round(asset.loanBalance * 100) / 100,
    };
  }

  log.debug("projectFinancedAssets", { month: _month, totalValue: Math.round(totalValue * 100) / 100, totalLoanBalance: Math.round(totalLoanBalance * 100) / 100 });
  return { totalValue, totalLoanBalance, breakdown };
}

export function depreciateAsset(
  currentValue: number,
  depreciationMethod: string | null,
  usefulLifeMonths: number | null,
  salvageValue: number | null,
  purchasePrice: number,
): number {
  if (!depreciationMethod || depreciationMethod === "none" || !usefulLifeMonths || usefulLifeMonths <= 0) {
    return currentValue;
  }

  const sv = salvageValue || 0;

  if (depreciationMethod === "straight_line") {
    const monthlyDep = (purchasePrice - sv) / usefulLifeMonths;
    return Math.max(sv, currentValue - monthlyDep);
  }

  return currentValue;
}

export function amortizeLoan(
  loanBalance: number,
  loanApr: number | null,
  monthlyPayment: number | null,
): number {
  if (!loanBalance || loanBalance <= 0 || !monthlyPayment || monthlyPayment <= 0) return loanBalance;
  const apr = loanApr || 0;
  const monthlyRate = apr / 100 / 12;
  const interest = loanBalance * monthlyRate;
  const principal = Math.max(0, monthlyPayment - interest);
  return Math.max(0, loanBalance - principal);
}

export interface FinancedAssetProjectionFull extends FinancedAssetProjection {
  depreciationMethod: string | null;
  usefulLifeMonths: number | null;
  salvageValue: number;
  purchasePrice: number;
  loanApr: number;
  monthlyPayment: number;
}

export function buildFinancedAssetProjectionsFull(rows: FinancedAsset[]): FinancedAssetProjectionFull[] {
  return rows.map(a => ({
    name: a.name,
    currentValue: a.currentValue || 0,
    loanBalance: a.loanBalance || 0,
    depreciationMethod: a.depreciationMethod || "none",
    usefulLifeMonths: a.usefulLifeMonths || null,
    salvageValue: a.salvageValue || 0,
    purchasePrice: a.purchasePrice || 0,
    loanApr: a.loanApr || 0,
    monthlyPayment: a.monthlyPayment || 0,
  }));
}

export function simulateFinancedAssetsMonth(assets: FinancedAssetProjectionFull[], month: string): void {
  for (const asset of assets) {
    asset.currentValue = depreciateAsset(
      asset.currentValue,
      asset.depreciationMethod,
      asset.usefulLifeMonths,
      asset.salvageValue,
      asset.purchasePrice,
    );
    asset.loanBalance = amortizeLoan(asset.loanBalance, asset.loanApr, asset.monthlyPayment);
  }
  log.debug("simulateFinancedAssetsMonth", { month, assetCount: assets.length });
}

export interface InvestmentAccountProjection {
  name: string;
  value: number;
}

export function buildInvestmentAccounts(
  holdings: PlaidHolding[],
  accountNameMap?: Map<string, string>,
): InvestmentAccountProjection[] {
  const accountMap = new Map<string, number>();
  for (const h of holdings) {
    const key = h.accountId || "Unknown";
    accountMap.set(key, (accountMap.get(key) || 0) + (h.institutionValue || 0));
  }
  return Array.from(accountMap.entries()).map(([id, value]) => ({
    name: accountNameMap?.get(id) || id,
    value,
  }));
}

export interface ForecastMonth {
  month: string;
  isPast: boolean;
  isCurrent: boolean;
  income: { gross: number; net: number; actual: number | null };
  taxes: number;
  retirement401k: number;
  deductions: Record<string, number>;
  deposits: Record<string, number>;
  expenses: Record<string, number>;
  totalExpenses: number;
  expectedExpenses: Record<string, number>;
  expectedTotalExpenses: number;
  investments: number;
  investmentBreakdown: Record<string, number>;
  manual401kBalance: number;
  manual401kBreakdown: Record<string, number>;
  assets: number;
  manualAssetValue: number;
  financedAssetValue: number;
  cashBalance: number;
  liabilities: number;
  liabilityBreakdown: Record<string, number>;
  financedLoanBalance: number;
  totalDebtPayments: number;
  netCashFlow: number;
  cumulativeNetWorth: number;
}

export interface ForecastResult {
  currentMonth: string;
  months: ForecastMonth[];
  categories: string[];
  growthRate: number;
  deductionTypes: string[];
  depositAccounts: string[];
  liabilityNames: string[];
  investmentAccountNames: string[];
  manual401kAccountNames: string[];
  monthly401kContribution: number;
  monthlyInvestmentContribution: number;
  totalLiabilityPayments: number;
}

const FREQUENCY_MULTIPLIERS: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  semimonthly: 2,
  monthly: 1,
  annually: 1 / 12,
};

export interface ComputeForecastInput {
  months?: number;
  pastMonths?: number;
  growthRate?: number;
  startMonth?: string;
  txns: PlaidTransaction[];
  sources: IncomeSource[];
  deductionRows: IncomeDeduction[];
  depositRows: IncomeDeposit[];
  budgetRows: BudgetEntry[];
  overrideRows: BudgetMonthlyOverride[];
  catRows: ExpenseCategory[];
  merchantRows: MerchantCategoryOverride[];
  holdings: PlaidHolding[];
  manualAssetRows: ManualAsset[];
  plaidLiabilityRows: PlaidLiability[];
  manualLiabilityRows: ManualLiability[];
  financedAssetRows: FinancedAsset[];
  accountRows: PlaidAccount[];
  manual401kRows: Manual401kAccount[];
  futureCashEventRows: FutureCashEvent[];
  amortizations?: import("./finance-amortization").AmortizationWithTxn[];
}

export function computeForecastGrid(input: ComputeForecastInput): ForecastResult {
  const months = Math.min(Math.max(input.months || 12, 1), 60);
  const pastMonths = Math.min(Math.max(input.pastMonths ?? 3, 0), 12);
  const growthRate = input.growthRate ?? 7;
  const monthlyGrowthRate = Math.pow(1 + growthRate / 100, 1 / 12) - 1;

  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  let rangeStartDate: Date;
  let rangeEndDate: Date;
  if (input.startMonth && /^\d{4}-\d{2}$/.test(input.startMonth)) {
    const [sy, sm] = input.startMonth.split("-").map(Number);
    rangeStartDate = new Date(sy, sm - 1, 1);
    rangeEndDate = new Date(sy, sm - 1 + months - 1, 28);
  } else {
    rangeStartDate = new Date(now.getFullYear(), now.getMonth() - pastMonths, 1);
    rangeEndDate = new Date(now.getFullYear(), now.getMonth() + months - 1, 28);
  }

  const {
    txns, sources, deductionRows, depositRows, budgetRows, overrideRows,
    catRows, merchantRows, holdings, manualAssetRows,
    plaidLiabilityRows, manualLiabilityRows, financedAssetRows, accountRows,
    manual401kRows, futureCashEventRows,
  } = input;

  const catById = new Map(catRows.map(c => [c.id, c]));
  const merchantMap = new Map(merchantRows.map(o => [o.merchantName.toLowerCase(), o.categoryId]));

  const futureCashByMonth: Record<string, Record<string, number>> = {};
  for (const evt of futureCashEventRows) {
    const m = evt.date.substring(0, 7);
    const displayCat = catRows.find(c => c.plaidCategory === evt.category || c.name === evt.category)?.name || evt.category;
    if (!futureCashByMonth[m]) futureCashByMonth[m] = {};
    futureCashByMonth[m][displayCat] = (futureCashByMonth[m][displayCat] || 0) + evt.amount;
  }

  let totalMonthlyGross = 0;
  let totalMonthlyNet = 0;
  let monthlyTaxes = 0;
  let monthly401k = 0;
  const incomeDeductionsByType: Record<string, number> = {};
  const depositsByAccount: Record<string, number> = {};

  for (const source of sources) {
    if (!source.isActive) continue;
    const mult = FREQUENCY_MULTIPLIERS[source.payFrequency] || 1;
    const srcDeds = deductionRows.filter(d => d.sourceId === source.id);
    const totalDed = srcDeds.reduce((s, d) => s + d.amount, 0);
    totalMonthlyGross += source.grossPay * mult;
    totalMonthlyNet += (source.grossPay - totalDed) * mult;

    for (const ded of srcDeds) {
      const label = ded.name.toLowerCase();
      const monthlyAmt = ded.amount * mult;
      if (label.includes("401k") || label.includes("retirement")) {
        monthly401k += monthlyAmt;
        incomeDeductionsByType["401k"] = (incomeDeductionsByType["401k"] || 0) + monthlyAmt;
      } else if (label.includes("tax") || label.includes("federal") || label.includes("state") || label.includes("fica") || label.includes("medicare") || label.includes("social security")) {
        monthlyTaxes += monthlyAmt;
        incomeDeductionsByType["taxes"] = (incomeDeductionsByType["taxes"] || 0) + monthlyAmt;
      } else if (label.includes("insurance") || label.includes("health") || label.includes("dental") || label.includes("vision")) {
        incomeDeductionsByType["insurance"] = (incomeDeductionsByType["insurance"] || 0) + monthlyAmt;
      } else {
        incomeDeductionsByType["other_deductions"] = (incomeDeductionsByType["other_deductions"] || 0) + monthlyAmt;
      }
    }

    const srcDeposits = depositRows.filter(d => d.sourceId === source.id);
    for (const dep of srcDeposits) {
      const label = dep.accountLabel || dep.accountId || "Unallocated";
      depositsByAccount[label] = (depositsByAccount[label] || 0) + dep.amount * mult;
    }
  }

  const FALLBACK_LABELS: Record<string, string> = {
    FOOD_AND_DRINK: "Food & Drink",
    TRANSPORTATION: "Transportation",
    RENT_AND_UTILITIES: "Rent & Utilities",
    GENERAL_MERCHANDISE: "Shopping",
    ENTERTAINMENT: "Entertainment",
    PERSONAL_CARE: "Personal Care",
    GENERAL_SERVICES: "Services",
    HOME_IMPROVEMENT: "Home",
    TRAVEL: "Travel",
    MEDICAL: "Medical",
    LOAN_PAYMENTS: "Loan Payments",
    TRANSFER_OUT: "Transfer Out",
    TRANSFER_IN: "Transfer In",
    BANK_FEES: "Bank Fees",
    OTHER: "Other",
    UNCATEGORIZED: "Other",
  };
  function normalizeCat(raw: string): string {
    const fromDb = catRows.find(c => c.plaidCategory === raw);
    if (fromDb) return fromDb.name;
    if (FALLBACK_LABELS[raw]) return FALLBACK_LABELS[raw];
    return raw;
  }

  const budgetByCategory: Record<string, number> = {};
  for (const b of budgetRows) {
    const key = normalizeCat(b.category);
    budgetByCategory[key] = (budgetByCategory[key] || 0) + b.monthlyAmount;
  }
  const overridesByMonth: Record<string, Record<string, number>> = {};
  for (const o of overrideRows) {
    if (!overridesByMonth[o.month]) overridesByMonth[o.month] = {};
    const key = normalizeCat(o.category);
    overridesByMonth[o.month][key] = o.amount;
  }

  const txnsByMonth: Record<string, Record<string, number>> = {};
  const incomeByMonth: Record<string, number> = {};
  for (const txn of txns) {
    if (txn.isInternalTransfer) continue;
    const m = txn.date.substring(0, 7);
    if (txn.amount < 0) {
      incomeByMonth[m] = (incomeByMonth[m] || 0) + Math.abs(txn.amount);
      continue;
    }
    let cat = txn.categoryPrimary || "UNCATEGORIZED";
    const merchant = (txn.merchantName || txn.name || "").toLowerCase();
    const overrideCatId = merchantMap.get(merchant);
    if (overrideCatId !== undefined) {
      const catObj = catById.get(overrideCatId);
      cat = catObj?.plaidCategory || catObj?.name || cat;
    }
    const displayCat = normalizeCat(cat);
    if (!txnsByMonth[m]) txnsByMonth[m] = {};
    txnsByMonth[m][displayCat] = (txnsByMonth[m][displayCat] || 0) + txn.amount;
  }

  let depositoryBalance = 0;
  let plaidAssetTotal = 0;
  let plaidLiabilityTotal = 0;
  for (const acct of accountRows) {
    const bal = acct.currentBalance || 0;
    if (acct.type === "depository") {
      depositoryBalance += bal;
    }
    if (acct.type === "depository" || acct.type === "investment") {
      plaidAssetTotal += bal;
    } else if (acct.type === "credit" || acct.type === "loan") {
      plaidLiabilityTotal += Math.abs(bal);
    }
  }

  let totalInvestmentValue = 0;
  for (const h of holdings) {
    totalInvestmentValue += h.institutionValue || 0;
  }

  const totalManualAssetValue = manualAssetRows.reduce((s, a) => s + a.currentValue, 0);
  const totalManualLiabilityValue = manualLiabilityRows.reduce((s, l) => s + (l.balance || 0), 0);

  const accountNameMap = new Map<string, string>();
  for (const acct of accountRows) {
    accountNameMap.set(acct.accountId, acct.officialName || acct.name);
  }

  const liabilityItems = buildLiabilityItems(plaidLiabilityRows, manualLiabilityRows, accountNameMap);
  const totalLiabilityPayments = getTotalLiabilityPayments(liabilityItems);

  const financedProjections = buildFinancedAssetProjectionsFull(financedAssetRows);
  const initialFinancedAssetValue = financedProjections.reduce((s, a) => s + a.currentValue, 0);
  const initialFinancedLoanBalance = financedProjections.reduce((s, a) => s + a.loanBalance, 0);
  const financedAssetMonthlyPayments = financedProjections.reduce((s, a) => s + (a.monthlyPayment || 0), 0);

  const investmentAccounts = buildInvestmentAccounts(holdings, accountNameMap);

  const deductionMap = new Map(deductionRows.map(d => [d.id, d]));
  const sourceMap = new Map(sources.map(s => [s.id, s]));
  const manual401kProjections = manual401kRows.map(acct => {
    const ded = acct.linkedDeductionId ? deductionMap.get(acct.linkedDeductionId) : null;
    const source = ded ? sourceMap.get(ded.sourceId) : null;
    const mult = source && source.isActive ? (FREQUENCY_MULTIPLIERS[source.payFrequency] || 1) : 1;
    const monthlyContrib = ded && source?.isActive ? ded.amount * mult : 0;
    return {
      name: acct.name,
      balance: acct.currentBalance,
      monthlyContribution: monthlyContrib,
    };
  });

  let monthlyInvestmentContribution = 0;
  for (const b of budgetRows) {
    const catLower = b.category.toLowerCase();
    if (catLower === "investment" || catLower === "investments") {
      monthlyInvestmentContribution += b.monthlyAmount;
    }
  }

  const allCategories = new Set<string>();
  for (const b of budgetRows) {
    const catLower = b.category.toLowerCase();
    if (catLower === "investment" || catLower === "investments") continue;
    const displayCat = normalizeCat(b.category);
    if (displayCat === "Loan Payments" && totalLiabilityPayments > 0) continue;
    allCategories.add(displayCat);
  }
  for (const m in txnsByMonth) {
    for (const cat in txnsByMonth[m]) {
      if (cat === "Loan Payments" && totalLiabilityPayments > 0) continue;
      allCategories.add(cat);
    }
  }
  if (totalLiabilityPayments > 0) {
    allCategories.add("Loan Payments");
  }

  const monthList: string[] = [];
  const rangeStartMonth = rangeStartDate.getMonth();
  const rangeStartYear = rangeStartDate.getFullYear();
  const totalMonthsInRange = (rangeEndDate.getFullYear() - rangeStartYear) * 12 + (rangeEndDate.getMonth() - rangeStartMonth) + 1;
  for (let i = 0; i < totalMonthsInRange; i++) {
    const d = new Date(rangeStartYear, rangeStartMonth + i, 1);
    monthList.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }

  let runningInvestments = totalInvestmentValue;
  let runningCash = depositoryBalance;
  const investmentAccountValues = new Map<string, number>();
  for (const acct of investmentAccounts) {
    investmentAccountValues.set(acct.name, acct.value);
  }

  const grid: ForecastMonth[] = [];

  for (const month of monthList) {
    const isPast = month < currentMonth;
    const isCurrent = month === currentMonth;
    const isFuture = month > currentMonth;

    const actualTxnIncome = incomeByMonth[month] ?? null;
    const incomeGross = totalMonthlyGross;
    const incomeNet = totalMonthlyNet;

    let dynamicLiabilityPayments = totalLiabilityPayments;
    let dynamicFinancedPayments = financedAssetMonthlyPayments;

    if (isFuture) {
      const liabResult = simulateLiabilityPaydown(liabilityItems, month);
      dynamicLiabilityPayments = liabResult.totalPayments;

      dynamicFinancedPayments = financedProjections.reduce(
        (s, a) => s + (a.loanBalance > 0 ? (a.monthlyPayment || 0) : 0), 0,
      );
      simulateFinancedAssetsMonth(financedProjections, month);
    }

    const totalAllDebtPayments = dynamicLiabilityPayments + dynamicFinancedPayments;

    const expenses: Record<string, number> = {};
    let totalExp = 0;

    // Always compute the planned baseline (what the user's budget says) so past
    // months expose both actuals (`expenses`) and the plan they were measured
    // against (`expectedExpenses`). For current/future months these are identical.
    const expectedExpenses: Record<string, number> = {};
    let expectedTotalExp = 0;
    {
      const monthOverrides = overridesByMonth[month] || {};
      for (const cat of allCategories) {
        const amount = monthOverrides[cat] ?? budgetByCategory[cat] ?? 0;
        if (amount > 0) {
          expectedExpenses[cat] = amount;
          expectedTotalExp += amount;
        }
      }
      if (dynamicLiabilityPayments > 0) {
        expectedExpenses["Loan Payments"] = (expectedExpenses["Loan Payments"] || 0) + Math.round(dynamicLiabilityPayments * 100) / 100;
        expectedTotalExp += dynamicLiabilityPayments;
      }
    }

    if (isPast && txnsByMonth[month]) {
      for (const cat in txnsByMonth[month]) {
        expenses[cat] = txnsByMonth[month][cat];
        totalExp += txnsByMonth[month][cat];
      }
    } else {
      for (const cat of Object.keys(expectedExpenses)) {
        expenses[cat] = expectedExpenses[cat];
        totalExp += expectedExpenses[cat];
      }
    }

    if (!isPast && futureCashByMonth[month]) {
      for (const cat in futureCashByMonth[month]) {
        const amt = futureCashByMonth[month][cat];
        expenses[cat] = (expenses[cat] || 0) + amt;
        totalExp += amt;
        allCategories.add(cat);
      }
    }

    // Apply amortization overlay using the shared single-source-of-truth helper.
    // Amortization rows store raw plaid categories; the forecast expenses dict uses
    // normalized display names — so we pre-normalize each amortization's category to
    // match the expense key space before calling the helper.
    if (input.amortizations && input.amortizations.length > 0) {
      const normalizedAmorts: AmortizationWithTxn[] = input.amortizations.map(a => ({
        ...a,
        category: normalizeCat(a.category),
      }));
      for (const na of normalizedAmorts) {
        if (na.isActive && !na.orphaned) allCategories.add(na.category);
      }
      const before = { ...expenses };
      const adjusted = getAmortizedSpendingForMonth(month, before, normalizedAmorts);
      let delta = 0;
      const allKeys = new Set([...Object.keys(before), ...Object.keys(adjusted)]);
      for (const k of allKeys) {
        delta += (adjusted[k] || 0) - (before[k] || 0);
      }
      for (const k of Object.keys(expenses)) {
        if (!(k in adjusted)) delete expenses[k];
      }
      for (const k of Object.keys(adjusted)) {
        expenses[k] = adjusted[k];
      }
      totalExp += delta;
    }

    const effectiveIncome = (isPast && actualTxnIncome !== null) ? actualTxnIncome : incomeNet;
    const investmentDeduction = isPast ? 0 : monthlyInvestmentContribution;
    const financedPaymentDeduction = isPast ? 0 : dynamicFinancedPayments;
    const netCash = effectiveIncome - totalExp - investmentDeduction - financedPaymentDeduction;

    if (isFuture) {
      runningInvestments = projectInvestmentGrowth(runningInvestments, monthlyInvestmentContribution, monthlyGrowthRate);

      const totalAccountValue = Array.from(investmentAccountValues.values()).reduce((s, v) => s + v, 0);
      for (const [name, value] of investmentAccountValues) {
        const share = totalAccountValue > 0 ? value / totalAccountValue : 1 / investmentAccountValues.size;
        const acctContribution = monthlyInvestmentContribution * share;
        investmentAccountValues.set(name, value * (1 + monthlyGrowthRate) + acctContribution);
      }

      for (const proj of manual401kProjections) {
        proj.balance = proj.balance * (1 + monthlyGrowthRate) + proj.monthlyContribution;
      }

      runningCash += netCash;
    }

    const liabilityBreakdown: Record<string, number> = {};
    let totalLiab = 0;
    for (const li of liabilityItems) {
      liabilityBreakdown[li.name] = Math.round(li.balance * 100) / 100;
      totalLiab += li.balance;
    }

    const financedTotals = projectFinancedAssets(financedProjections, month);
    const currentFinancedValue = financedTotals.totalValue;
    const currentFinancedLoan = financedTotals.totalLoanBalance;

    for (const fp of financedProjections) {
      if (fp.loanBalance > 0) {
        liabilityBreakdown[fp.name] = Math.round(fp.loanBalance * 100) / 100;
      }
    }

    const investmentBreakdown: Record<string, number> = {};
    for (const [name, value] of investmentAccountValues) {
      investmentBreakdown[name] = Math.round(value * 100) / 100;
    }

    const current401kBalance = manual401kProjections.reduce((s, a) => s + a.balance, 0);
    const manual401kBreakdown: Record<string, number> = {};
    for (const proj of manual401kProjections) {
      manual401kBreakdown[proj.name] = Math.round(proj.balance * 100) / 100;
    }

    const nwc = isFuture
      ? calculateNetWorthComponents({
          plaidAssetTotal: 0,
          manualAssetTotal: totalManualAssetValue,
          financedAssetValueTotal: currentFinancedValue,
          investmentTotal: runningInvestments + current401kBalance,
          cashBalance: runningCash,
          plaidLiabilityTotal: 0,
          manualLiabilityTotal: totalLiab,
          financedLoanBalanceTotal: currentFinancedLoan,
        })
      : calculateNetWorthComponents({
          plaidAssetTotal,
          manualAssetTotal: totalManualAssetValue,
          financedAssetValueTotal: currentFinancedValue,
          investmentTotal: current401kBalance,
          cashBalance: 0,
          plaidLiabilityTotal,
          manualLiabilityTotal: totalManualLiabilityValue,
          financedLoanBalanceTotal: currentFinancedLoan,
        });
    const netWorth = nwc.netWorth;

    grid.push({
      month,
      isPast,
      isCurrent,
      income: { gross: Math.round(incomeGross * 100) / 100, net: Math.round(incomeNet * 100) / 100, actual: actualTxnIncome !== null ? Math.round(actualTxnIncome * 100) / 100 : null },
      taxes: Math.round(monthlyTaxes * 100) / 100,
      retirement401k: Math.round(monthly401k * 100) / 100,
      deductions: Object.fromEntries(Object.entries(incomeDeductionsByType).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      deposits: Object.fromEntries(Object.entries(depositsByAccount).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      expenses,
      totalExpenses: Math.round(totalExp * 100) / 100,
      expectedExpenses,
      expectedTotalExpenses: Math.round(expectedTotalExp * 100) / 100,
      investments: Math.round(runningInvestments * 100) / 100,
      investmentBreakdown,
      manual401kBalance: Math.round(current401kBalance * 100) / 100,
      manual401kBreakdown,
      assets: Math.round((runningCash + currentFinancedValue + totalManualAssetValue) * 100) / 100,
      manualAssetValue: Math.round(totalManualAssetValue * 100) / 100,
      financedAssetValue: Math.round(currentFinancedValue * 100) / 100,
      cashBalance: Math.round(runningCash * 100) / 100,
      liabilities: Math.round((totalLiab + currentFinancedLoan) * 100) / 100,
      liabilityBreakdown,
      financedLoanBalance: Math.round(currentFinancedLoan * 100) / 100,
      totalDebtPayments: Math.round(totalAllDebtPayments * 100) / 100,
      netCashFlow: Math.round(netCash * 100) / 100,
      cumulativeNetWorth: Math.round(netWorth * 100) / 100,
    });
  }

  const categories = Array.from(allCategories).sort();
  const investmentAccountNames = Array.from(investmentAccountValues.keys());
  const manual401kAccountNames = manual401kProjections.map(a => a.name);
  const monthly401kContribution = manual401kProjections.reduce((s, a) => s + a.monthlyContribution, 0);

  return {
    currentMonth,
    months: grid,
    categories,
    growthRate,
    deductionTypes: Object.keys(incomeDeductionsByType),
    depositAccounts: Object.keys(depositsByAccount),
    liabilityNames: liabilityItems.map(l => l.name),
    investmentAccountNames,
    manual401kAccountNames,
    monthly401kContribution: Math.round(monthly401kContribution * 100) / 100,
    monthlyInvestmentContribution: Math.round(monthlyInvestmentContribution * 100) / 100,
    totalLiabilityPayments: Math.round(totalLiabilityPayments * 100) / 100,
  };
}
