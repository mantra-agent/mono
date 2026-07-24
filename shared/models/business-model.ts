import { z } from "zod";

// ── Stage identity ────────────────────────────────────────────────
// The financing stages are a fixed, ordered set in v1. No add/remove; all
// values editable. Order here is the canonical financing sequence and is the
// order in which dilution is applied across rounds.
export const STAGE_KEYS = ["pre_seed", "seed", "series_a", "series_b"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const STAGE_LABELS: Record<StageKey, string> = {
  pre_seed: "Pre-Seed",
  seed: "Seed",
  series_a: "Series A",
  series_b: "Series B",
};

// ── Data contracts ────────────────────────────────────────────────
export interface Stage {
  key: StageKey;
  roundMonth: number;
  investmentAmount: number;
  preMoneyValuation: number;
  /** Referral-driven logo growth: net-new account expansion multiple per 90 days. */
  referralCoefficient90d: number;
  /** Net revenue retention: annual in-account revenue growth (%), net of churn. */
  nrrAnnualPct: number;
  monthlyExpenses: number;
}

export interface Assumptions {
  horizonMonths: number;
  /** 'YYYY-MM' — used only for column labels. */
  startCalendarMonth: string;
  startingCash: number;
  /** Seed account count at month 0 (the starting cohort). */
  startingCustomers: number;
  /** Base ARPU: monthly revenue a brand-new account enters at, before NRR expansion. */
  revenuePerCustomerMonthly: number;
  /** Exactly 4 stages, canonical order (see STAGE_KEYS). */
  stages: Stage[];
}

export interface FinancialModel {
  id: string;
  name: string;
  assumptions: Assumptions;
  createdAt: string;
  updatedAt: string;
}

// ── Clamps / bounds ───────────────────────────────────────────────
export const HORIZON_MIN = 1;
export const HORIZON_MAX = 120;

/** Per-stage financing defaults, indexed by stage key. */
const STAGE_DEFAULTS: Record<StageKey, Omit<Stage, "key">> = {
  pre_seed: { roundMonth: 1, investmentAmount: 500_000, preMoneyValuation: 4_500_000, referralCoefficient90d: 1.5, nrrAnnualPct: 150, monthlyExpenses: 40_000 },
  seed: { roundMonth: 12, investmentAmount: 2_000_000, preMoneyValuation: 10_000_000, referralCoefficient90d: 1.5, nrrAnnualPct: 150, monthlyExpenses: 140_000 },
  series_a: { roundMonth: 24, investmentAmount: 8_000_000, preMoneyValuation: 32_000_000, referralCoefficient90d: 1.5, nrrAnnualPct: 150, monthlyExpenses: 400_000 },
  series_b: { roundMonth: 36, investmentAmount: 20_000_000, preMoneyValuation: 100_000_000, referralCoefficient90d: 1.5, nrrAnnualPct: 150, monthlyExpenses: 900_000 },
};

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function clampMin(value: number | undefined, min: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

function clampRange(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// ── Calendar helpers (label-only) ─────────────────────────────────
/** First 'YYYY-MM' after `from` (defaults to now). Used as the default start month. */
export function nextCalendarMonth(from: Date = new Date()): string {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  return `${next.getUTCFullYear()}-${mm}`;
}

/** Column label for 1-based month index derived from startCalendarMonth, e.g. "Aug '26". */
export function calendarMonthLabel(startCalendarMonth: string, monthIndex: number): string {
  const base = MONTH_PATTERN.test(startCalendarMonth) ? startCalendarMonth : nextCalendarMonth();
  const [yearStr, monthStr] = base.split("-");
  const d = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1 + (monthIndex - 1), 1));
  const yr = String(d.getUTCFullYear()).slice(-2);
  return `${MONTH_ABBR[d.getUTCMonth()]} '${yr}`;
}

// ── Defaults ──────────────────────────────────────────────────────
export function defaultStages(): Stage[] {
  return STAGE_KEYS.map((key) => ({ key, ...STAGE_DEFAULTS[key] }));
}

export function defaultAssumptions(): Assumptions {
  return {
    horizonMonths: 48,
    startCalendarMonth: nextCalendarMonth(),
    startingCash: 50_000,
    startingCustomers: 2,
    revenuePerCustomerMonthly: 500,
    stages: defaultStages(),
  };
}

// ── Zod schemas ───────────────────────────────────────────────────
// Raw, fully-optional shapes: partial patches and legacy/persisted blobs are
// tolerated, then folded through normalizeAssumptions into a canonical value.
const rawStageSchema = z.object({
  key: z.enum(STAGE_KEYS),
  roundMonth: z.number().optional(),
  investmentAmount: z.number().optional(),
  preMoneyValuation: z.number().optional(),
  referralCoefficient90d: z.number().optional(),
  nrrAnnualPct: z.number().optional(),
  monthlyExpenses: z.number().optional(),
});

const rawAssumptionsSchema = z.object({
  horizonMonths: z.number().optional(),
  startCalendarMonth: z.string().optional(),
  startingCash: z.number().optional(),
  startingCustomers: z.number().optional(),
  revenuePerCustomerMonthly: z.number().optional(),
  stages: z.array(rawStageSchema).optional(),
});

/** Partial assumptions update. Omitted fields mean "no change" (Safe Partial Updates). */
export const assumptionsPatchSchema = rawAssumptionsSchema;
export type AssumptionsPatch = z.infer<typeof assumptionsPatchSchema>;

/**
 * Fold arbitrary input over defaults and clamp every field into a canonical,
 * always-valid Assumptions. This is the single normalization boundary: the
 * stored jsonb, API input, and projection input all pass through here so
 * invalid states are unrepresentable downstream.
 */
export function normalizeAssumptions(input: unknown): Assumptions {
  const parsed = rawAssumptionsSchema.safeParse(input ?? {});
  const raw: AssumptionsPatch = parsed.success ? parsed.data : {};

  const byKey = new Map<StageKey, z.infer<typeof rawStageSchema>>();
  for (const stage of raw.stages ?? []) byKey.set(stage.key, stage);

  const stages: Stage[] = STAGE_KEYS.map((key) => {
    const def = STAGE_DEFAULTS[key];
    const override = byKey.get(key) ?? { key };
    return {
      key,
      roundMonth: Math.round(clampMin(override.roundMonth, 1, def.roundMonth)),
      investmentAmount: clampMin(override.investmentAmount, 0, def.investmentAmount),
      preMoneyValuation: clampMin(override.preMoneyValuation, 0, def.preMoneyValuation),
      referralCoefficient90d: clampMin(override.referralCoefficient90d, 0, def.referralCoefficient90d),
      nrrAnnualPct: clampMin(override.nrrAnnualPct, 0, def.nrrAnnualPct),
      monthlyExpenses: clampMin(override.monthlyExpenses, 0, def.monthlyExpenses),
    };
  });

  const startCalendarMonth = raw.startCalendarMonth && MONTH_PATTERN.test(raw.startCalendarMonth)
    ? raw.startCalendarMonth
    : nextCalendarMonth();

  return {
    horizonMonths: Math.round(clampRange(raw.horizonMonths, HORIZON_MIN, HORIZON_MAX, 48)),
    startCalendarMonth,
    startingCash: clampMin(raw.startingCash, 0, 50_000),
    startingCustomers: clampMin(raw.startingCustomers, 0, 2),
    revenuePerCustomerMonthly: clampMin(raw.revenuePerCustomerMonthly, 0, 500),
    stages,
  };
}

/** Merge a partial patch over current assumptions (field-level, stages by key), then normalize. */
export function mergeAssumptions(current: Assumptions, patch: AssumptionsPatch): Assumptions {
  const stageMap = new Map<StageKey, Stage>(current.stages.map((s) => [s.key, { ...s }]));
  for (const p of patch.stages ?? []) {
    const base = stageMap.get(p.key);
    if (!base) continue;
    stageMap.set(p.key, {
      ...base,
      ...(p.roundMonth !== undefined ? { roundMonth: p.roundMonth } : {}),
      ...(p.investmentAmount !== undefined ? { investmentAmount: p.investmentAmount } : {}),
      ...(p.preMoneyValuation !== undefined ? { preMoneyValuation: p.preMoneyValuation } : {}),
      ...(p.referralCoefficient90d !== undefined ? { referralCoefficient90d: p.referralCoefficient90d } : {}),
      ...(p.nrrAnnualPct !== undefined ? { nrrAnnualPct: p.nrrAnnualPct } : {}),
      ...(p.monthlyExpenses !== undefined ? { monthlyExpenses: p.monthlyExpenses } : {}),
    });
  }
  const merged = {
    horizonMonths: patch.horizonMonths ?? current.horizonMonths,
    startCalendarMonth: patch.startCalendarMonth ?? current.startCalendarMonth,
    startingCash: patch.startingCash ?? current.startingCash,
    startingCustomers: patch.startingCustomers ?? current.startingCustomers,
    revenuePerCustomerMonthly: patch.revenuePerCustomerMonthly ?? current.revenuePerCustomerMonthly,
    stages: STAGE_KEYS.map((k) => stageMap.get(k)!),
  };
  return normalizeAssumptions(merged);
}

// ── Projection ────────────────────────────────────────────────────
export interface MonthRow {
  month: number;
  label: string;
  stageKey: StageKey;
  stageLabel: string;
  /** Cumulative active accounts (referral-driven; never churned in v1). */
  accounts: number;
  /** Net-new accounts (logos) that entered this month, at base ARPU. */
  newAccounts: number;
  revenue: number;
  /** Blended revenue ÷ accounts — visualizes NRR expansion over the base ARPU. */
  blendedArpu: number;
  expenses: number;
  netCashFlow: number;
  investmentIn: number;
  cashBalance: number;
  isRoundMonth: boolean;
}

export interface StageSummary {
  key: StageKey;
  label: string;
  roundMonth: number;
  roundMonthLabel: string;
  investment: number;
  preMoney: number;
  postMoney: number;
  /** New investor ownership at this round, 0..1. */
  newInvestorOwnership: number;
  /** Pre-Seed investor ownership after this round, 0..1. */
  preSeedOwnership: number;
  /** Pre-Seed stake value at this round's post-money. */
  preSeedStakeValue: number;
  /** Pre-Seed stake value / Pre-Seed investment. */
  preSeedReturnMultiple: number;
}

export interface Projection {
  assumptions: Assumptions;
  months: MonthRow[];
  stages: StageSummary[];
}

/** Latest stage whose roundMonth has been reached by month m, else the first stage. */
function activeStageForMonth(stages: Stage[], m: number): Stage {
  let active: Stage | null = null;
  for (const stage of stages) {
    if (stage.roundMonth <= m && (!active || stage.roundMonth > active.roundMonth)) {
      active = stage;
    }
  }
  return active ?? stages[0];
}

/** Pure projection engine. Accepts raw or normalized input; always normalizes first. */
export function computeProjection(input: Assumptions | unknown): Projection {
  const assumptions = normalizeAssumptions(input);
  const { stages, horizonMonths } = assumptions;

  // ── Cohort revenue engine (v1) ──────────────────────────────────
  // Two orthogonal per-stage dials that never touch the same dollar:
  //   • Referral coefficient grows the NUMBER OF ACCOUNTS (net-new logos).
  //     Monthly multiplier = referral^(1/3), since referral is a per-90-day
  //     (three-month) expansion multiple. New logos always enter at base ARPU.
  //   • NRR grows REVENUE WITHIN each existing account via deeper usage.
  //     Monthly multiplier = (nrr/100)^(1/12), applied to every live cohort each
  //     month using the active stage's rate. NRR is net of churn/contraction.
  //
  // A cohort that entered at month τ earns, per account at month t:
  //   arpu0 × Π_{k=τ+1..t} nrrMonthly(k) = arpu0 × P(t)/P(τ),
  // where P(t) is the cumulative NRR product. Total revenue is therefore
  //   arpu0 × P(t) × Σ_{τ≤t} newAccounts(τ)/P(τ),
  // so the whole book collapses to two running accumulators (P and S) instead
  // of retaining every cohort — O(months), exact.
  //
  // v1 definition (intentional, not a bug): the ACCOUNT COUNT is never churned.
  // Churn/contraction is represented on the revenue line via NRR, which is net
  // of churn. Do not add a separate churn dial without revisiting this comment.
  const arpu0 = assumptions.revenuePerCustomerMonthly;
  const months: MonthRow[] = [];
  let accounts = assumptions.startingCustomers; // seed cohort at τ=0, enters at arpu0
  let cumulativeNrr = 1; // P(t): product of monthly NRR multipliers through month t
  let cohortSum = accounts; // S(t) = Σ_{τ≤t} newAccounts(τ)/P(τ); seed enters at P(0)=1
  let cashBalance = assumptions.startingCash;

  for (let m = 1; m <= horizonMonths; m++) {
    const stage = activeStageForMonth(stages, m);
    const referralMonthly = Math.pow(stage.referralCoefficient90d, 1 / 3);
    const nrrMonthly = Math.pow(stage.nrrAnnualPct / 100, 1 / 12);

    // Referral grows the account base; the delta is this month's new-logo cohort.
    const prevAccounts = accounts;
    accounts = prevAccounts * referralMonthly;
    const newAccounts = accounts - prevAccounts;

    // NRR expands every live cohort; the new cohort enters at the current P(m).
    cumulativeNrr *= nrrMonthly;
    cohortSum += newAccounts / cumulativeNrr;
    const revenue = arpu0 * cumulativeNrr * cohortSum;
    const blendedArpu = accounts > 0 ? revenue / accounts : 0;

    const expenses = stage.monthlyExpenses;
    const netCashFlow = revenue - expenses;
    const investmentIn = stages
      .filter((s) => s.roundMonth === m)
      .reduce((sum, s) => sum + s.investmentAmount, 0);
    cashBalance = cashBalance + netCashFlow + investmentIn;

    months.push({
      month: m,
      label: calendarMonthLabel(assumptions.startCalendarMonth, m),
      stageKey: stage.key,
      stageLabel: STAGE_LABELS[stage.key],
      accounts,
      newAccounts,
      revenue,
      blendedArpu,
      expenses,
      netCashFlow,
      investmentIn,
      cashBalance,
      isRoundMonth: stages.some((s) => s.roundMonth === m),
    });
  }

  // Cap table across rounds, processed in canonical financing order. Valuation
  // marks only at round events; existing holders dilute by preMoney/postMoney
  // at each subsequent round. We track the Pre-Seed investor across rounds.
  const preSeedInvestment = stages[0].investmentAmount;
  let preSeedOwnership = 0;
  const summaries: StageSummary[] = stages.map((stage, i) => {
    const postMoney = stage.preMoneyValuation + stage.investmentAmount;
    const newInvestorOwnership = postMoney > 0 ? stage.investmentAmount / postMoney : 0;
    const dilutionFactor = postMoney > 0 ? stage.preMoneyValuation / postMoney : 1;
    preSeedOwnership = i === 0 ? newInvestorOwnership : preSeedOwnership * dilutionFactor;
    const preSeedStakeValue = preSeedOwnership * postMoney;
    const preSeedReturnMultiple = preSeedInvestment > 0 ? preSeedStakeValue / preSeedInvestment : 0;
    return {
      key: stage.key,
      label: STAGE_LABELS[stage.key],
      roundMonth: stage.roundMonth,
      roundMonthLabel: calendarMonthLabel(assumptions.startCalendarMonth, stage.roundMonth),
      investment: stage.investmentAmount,
      preMoney: stage.preMoneyValuation,
      postMoney,
      newInvestorOwnership,
      preSeedOwnership,
      preSeedStakeValue,
      preSeedReturnMultiple,
    };
  });

  return { assumptions, months, stages: summaries };
}
