import { createLogger } from "./log";
import { fetchAndComputeForecast } from "./routes/finance";

const log = createLogger("Finance");

export type TrajectoryStatus = "on_track" | "drifting" | "off_track";

export interface CategoryDivergence {
  category: string;
  expected: number;
  actual: number;
  deltaAbs: number;
  deltaPct: number | null;
}

export interface LastCompletedMonth {
  month: string;
  expectedIncome: number;
  actualIncome: number;
  expectedSpending: number;
  actualSpending: number;
  expectedNetCashFlow: number;
  actualNetCashFlow: number;
  netCashFlowDeviationPct: number | null;
  expectedNetWorth: number;
  actualNetWorth: number;
  netWorthDeviationPct: number | null;
  topDivergentCategories: CategoryDivergence[];
}

export interface TrajectorySnapshot {
  currentMonth: string;
  currentNetWorth: number;
  projectedNetWorth12mo: number;
  monthlyNetCashFlow: number;
  liquidCash: number;
  totalLiabilities: number;
  trajectoryStatus: TrajectoryStatus;
  lastCompletedMonth: LastCompletedMonth | null;
  generatedAt: string;
}

function pctDelta(actual: number, expected: number): number | null {
  if (Math.abs(expected) < 0.005) return null;
  return ((actual - expected) / Math.abs(expected)) * 100;
}

export async function getTrajectorySnapshot(): Promise<TrajectorySnapshot> {
  const forecast = await fetchAndComputeForecast({ months: 12, pastMonths: 3 });

  const current = forecast.months.find(m => m.isCurrent);
  if (!current) {
    throw new Error("Forecast did not include the current month");
  }

  // Projected NW 12 months out — last future month with isPast=false and isCurrent=false up to 12 ahead
  const futureMonths = forecast.months.filter(m => !m.isPast && !m.isCurrent);
  const projected = futureMonths.length > 0 ? futureMonths[Math.min(11, futureMonths.length - 1)] : current;

  const currentNetWorth = current.cumulativeNetWorth;
  const projectedNetWorth12mo = projected.cumulativeNetWorth;
  const monthlyNetCashFlow = current.netCashFlow;
  const liquidCash = current.cashBalance;
  const totalLiabilities = current.liabilities;

  // Last completed month — most recent past month
  const pastMonths = forecast.months.filter(m => m.isPast);
  const lastPast = pastMonths.length > 0 ? pastMonths[pastMonths.length - 1] : null;

  let lastCompletedMonth: LastCompletedMonth | null = null;
  let trajectoryStatus: TrajectoryStatus = "on_track";

  if (lastPast) {
    // Expected baseline for the LAST COMPLETED MONTH (not the current month) —
    // forecast now exposes per-month planned baselines as `expectedExpenses`,
    // so income/spending and net-worth deviations measure last month against
    // last month's plan.
    const expectedIncome = lastPast.income.net;
    const actualIncome = lastPast.income.actual ?? lastPast.income.net;
    const actualSpending = lastPast.totalExpenses;

    const expectedSpendingByCat = lastPast.expectedExpenses;
    const expectedSpending = lastPast.expectedTotalExpenses;
    const actualSpendingByCat = lastPast.expenses;

    const expectedNetCashFlow = expectedIncome - expectedSpending;
    const actualNetCashFlow = lastPast.netCashFlow;

    const allCats = new Set<string>([...Object.keys(expectedSpendingByCat), ...Object.keys(actualSpendingByCat)]);
    const divergences: CategoryDivergence[] = [];
    for (const cat of allCats) {
      const expected = expectedSpendingByCat[cat] || 0;
      const actual = actualSpendingByCat[cat] || 0;
      const deltaAbs = actual - expected;
      if (Math.abs(deltaAbs) < 1) continue;
      divergences.push({ category: cat, expected, actual, deltaAbs, deltaPct: pctDelta(actual, expected) });
    }
    divergences.sort((a, b) => Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs));

    // Expected net worth at end of last completed month = month-prior NW + planned net cash flow.
    // If we don't have a prior past month, fall back to (actual NW − actual netCash + expected netCash).
    const priorIdx = pastMonths.length - 2;
    const priorNetWorth = priorIdx >= 0 ? pastMonths[priorIdx].cumulativeNetWorth : (lastPast.cumulativeNetWorth - lastPast.netCashFlow);
    const expectedNetWorth = priorNetWorth + expectedNetCashFlow;
    const actualNetWorth = lastPast.cumulativeNetWorth;
    const netWorthDeviationPct = pctDelta(actualNetWorth, expectedNetWorth);

    lastCompletedMonth = {
      month: lastPast.month,
      expectedIncome: Math.round(expectedIncome * 100) / 100,
      actualIncome: Math.round(actualIncome * 100) / 100,
      expectedSpending: Math.round(expectedSpending * 100) / 100,
      actualSpending: Math.round(actualSpending * 100) / 100,
      expectedNetCashFlow: Math.round(expectedNetCashFlow * 100) / 100,
      actualNetCashFlow: Math.round(actualNetCashFlow * 100) / 100,
      netCashFlowDeviationPct: pctDelta(actualNetCashFlow, expectedNetCashFlow),
      expectedNetWorth: Math.round(expectedNetWorth * 100) / 100,
      actualNetWorth: Math.round(actualNetWorth * 100) / 100,
      netWorthDeviationPct,
      topDivergentCategories: divergences.slice(0, 3).map(d => ({
        category: d.category,
        expected: Math.round(d.expected * 100) / 100,
        actual: Math.round(d.actual * 100) / 100,
        deltaAbs: Math.round(d.deltaAbs * 100) / 100,
        deltaPct: d.deltaPct !== null ? Math.round(d.deltaPct * 100) / 100 : null,
      })),
    };

    const dev = netWorthDeviationPct !== null ? Math.abs(netWorthDeviationPct) : 0;
    if (dev > 25) trajectoryStatus = "off_track";
    else if (dev > 10) trajectoryStatus = "drifting";
    else trajectoryStatus = "on_track";
  }

  log.log(`[Finance] Trajectory snapshot: NW $${currentNetWorth.toFixed(0)} → $${projectedNetWorth12mo.toFixed(0)} (12mo), cashflow $${monthlyNetCashFlow.toFixed(0)}/mo, status=${trajectoryStatus}`);

  return {
    currentMonth: forecast.currentMonth,
    currentNetWorth: Math.round(currentNetWorth * 100) / 100,
    projectedNetWorth12mo: Math.round(projectedNetWorth12mo * 100) / 100,
    monthlyNetCashFlow: Math.round(monthlyNetCashFlow * 100) / 100,
    liquidCash: Math.round(liquidCash * 100) / 100,
    totalLiabilities: Math.round(totalLiabilities * 100) / 100,
    trajectoryStatus,
    lastCompletedMonth,
    generatedAt: new Date().toISOString(),
  };
}
