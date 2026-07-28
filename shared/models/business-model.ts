import { z } from "zod";
import type { JobRole } from "./job-roles";

export const MODEL_VERSION = 3;
export const HORIZON_MIN = 1;
export const HORIZON_MAX = 120;
export const LOADED_COST_MULTIPLIER_MIN = 0.5;
export const LOADED_COST_MULTIPLIER_MAX = 3;
export const PHASE_KEYS = ["phase_0", "phase_1", "phase_2", "phase_3"] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];
export const FINANCING_KEYS = ["seed", "series_a", "series_b"] as const;
export type FinancingKey = (typeof FINANCING_KEYS)[number];
export type OpexCategory = "staff" | "marketing" | "g_and_a";
export type PeriodMode = "monthly" | "quarterly" | "annually";

/** Maps each phase to the round that funds it (phase_0 bootstrap shares the Seed band). */
export const PHASE_FINANCING: Record<PhaseKey, FinancingKey> = {
  phase_0: "seed",
  phase_1: "seed",
  phase_2: "series_a",
  phase_3: "series_b",
};
export type FinancingInstrument = "post_money_safe" | "priced_round";
export type CostClassification = "opex" | "product_cogs";
export type GateStatus = "achieved" | "missed" | "not_yet_observable";

export const PHASE_LABELS: Record<PhaseKey, string> = {
  phase_0: "External Willingness to Pay",
  phase_1: "Premium Demand & Retention",
  phase_2: "Repeatable Acquisition",
  phase_3: "Durable Category Economics",
};

export const FINANCING_LABELS: Record<FinancingKey, string> = {
  seed: "Seed",
  series_a: "Series A",
  series_b: "Series B",
};

export interface StageKeyHire {
  roleId: string;
  startMonth?: number;
  headcount?: number;
}

export interface PhaseAssumption {
  key: PhaseKey;
  startMonth: number;
  endMonth: number;
  fundedBy: string;
  productArrMin: number;
  productArrMax: number;
  annualNrrMinPct: number;
  annualGlrMinPct: number;
  accountExpansion90dMin: number;
  cacPaybackMaxMonths: number;
  productGrossMarginMinPct: number;
  keyHires: StageKeyHire[];
}

export interface FinancingEvent {
  key: FinancingKey;
  month: number;
  amount: number;
  instrument: FinancingInstrument;
  valuation: number;
  optionPoolTopUpPct: number;
}

export interface MonthlyCashLane {
  month: number;
  consultingRevenue: number;
  consultingCogs: number;
  capex: number;
}

export interface OperatingCostEntry {
  id: string;
  label: string;
  startMonth: number;
  endMonth: number;
  monthlyAmount: number;
  headcount: number;
  classification: CostClassification;
  opexCategory?: OpexCategory;
}

export interface Assumptions {
  modelVersion: number;
  horizonMonths: number;
  startCalendarMonth: string;
  openingCash: number;
  startingAccounts: number;
  quarterOneNewAccounts: number;
  accountExpansion90d: number;
  annualGrossLogoRetentionPct: number;
  annualNrrPct: number;
  maxSubscriptionMonthly: number;
  maxIncludedTokensMillions: number;
  blendedTokenCostPerMillion: number;
  overageMarkupPct: number;
  infrastructurePerActiveAccount: number;
  supportPerActiveAccount: number;
  paymentProcessingPct: number;
  onboardingCostPerNewAccount: number;
  plgSharePct: number;
  plgCac: number;
  topDownCac: number;
  reserveAtNextGate: number;
  roundIncrement: number;
  fundraisingLeadMonths: number;
  trailingBurnMonths: number;
  loadedCostMultiplier: number;
  phases: PhaseAssumption[];
  financingEvents: FinancingEvent[];
  operatingCosts: OperatingCostEntry[];
  monthlyCashLanes: MonthlyCashLane[];
}

export interface FinancialModel {
  id: string;
  name: string;
  assumptions: Assumptions;
  createdAt: string;
  updatedAt: string;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegative(value: unknown, fallback: number): number {
  return finite(value) ? Math.max(0, value) : fallback;
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  return finite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function whole(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(bounded(value, min, max, fallback));
}

export function nextCalendarMonth(from: Date = new Date()): string {
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function calendarMonthLabel(startCalendarMonth: string, monthIndex: number): string {
  const base = MONTH_PATTERN.test(startCalendarMonth) ? startCalendarMonth : nextCalendarMonth();
  const [year, month] = base.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1 + monthIndex - 1, 1));
  return `${MONTH_ABBR[value.getUTCMonth()]} '${String(value.getUTCFullYear()).slice(-2)}`;
}

const PHASE_DEFAULTS: Record<PhaseKey, Omit<PhaseAssumption, "key">> = {
  phase_0: { startMonth: 0, endMonth: 0, fundedBy: "Bootstrap", productArrMin: 0, productArrMax: 0, annualNrrMinPct: 0, annualGlrMinPct: 0, accountExpansion90dMin: 0, cacPaybackMaxMonths: 0, productGrossMarginMinPct: 0, keyHires: [] },
  phase_1: { startMonth: 1, endMonth: 18, fundedBy: "Seed", productArrMin: 1_000_000, productArrMax: 2_000_000, annualNrrMinPct: 150, annualGlrMinPct: 90, accountExpansion90dMin: 0, cacPaybackMaxMonths: 0, productGrossMarginMinPct: 0, keyHires: [
    { roleId: "18d90c4f05e92d7d", startMonth: 1 },
    { roleId: "ac66ad0dcbcc671f", startMonth: 1 },
    { roleId: "bb87b49068593dc8", startMonth: 7 },
    { roleId: "e8fc275fa51a38d2", startMonth: 13 },
  ] },
  phase_2: { startMonth: 19, endMonth: 36, fundedBy: "Series A", productArrMin: 10_000_000, productArrMax: 0, annualNrrMinPct: 0, annualGlrMinPct: 0, accountExpansion90dMin: 1.5, cacPaybackMaxMonths: 12, productGrossMarginMinPct: 0, keyHires: [] },
  phase_3: { startMonth: 37, endMonth: 60, fundedBy: "Series B", productArrMin: 30_000_000, productArrMax: 50_000_000, annualNrrMinPct: 0, annualGlrMinPct: 0, accountExpansion90dMin: 0, cacPaybackMaxMonths: 0, productGrossMarginMinPct: 80, keyHires: [] },
};

const FINANCING_DEFAULTS: Record<FinancingKey, Omit<FinancingEvent, "key">> = {
  seed: { month: 1, amount: 1_000_000, instrument: "post_money_safe", valuation: 8_000_000, optionPoolTopUpPct: 0 },
  series_a: { month: 19, amount: 8_000_000, instrument: "priced_round", valuation: 40_000_000, optionPoolTopUpPct: 0 },
  series_b: { month: 37, amount: 0, instrument: "priced_round", valuation: 150_000_000, optionPoolTopUpPct: 0 },
};

export function defaultPhases(): PhaseAssumption[] {
  return PHASE_KEYS.map((key) => ({ key, ...PHASE_DEFAULTS[key] }));
}

export function defaultFinancingEvents(): FinancingEvent[] {
  return FINANCING_KEYS.map((key) => ({ key, ...FINANCING_DEFAULTS[key] }));
}

export function defaultOperatingCosts(): OperatingCostEntry[] {
  return [
    { id: "ga", label: "G&A, tools, legal, security", startMonth: 1, endMonth: 120, monthlyAmount: 6_000, headcount: 0, classification: "opex", opexCategory: "g_and_a" },
  ];
}

export function defaultMonthlyCashLanes(horizonMonths = 48): MonthlyCashLane[] {
  return Array.from({ length: horizonMonths }, (_, index) => ({ month: index + 1, consultingRevenue: 0, consultingCogs: 0, capex: 0 }));
}

export function defaultAssumptions(): Assumptions {
  const horizonMonths = 48;
  return {
    modelVersion: MODEL_VERSION,
    horizonMonths,
    startCalendarMonth: nextCalendarMonth(),
    openingCash: 12_500,
    startingAccounts: 0,
    quarterOneNewAccounts: 10,
    accountExpansion90d: 1.5,
    annualGrossLogoRetentionPct: 90,
    annualNrrPct: 150,
    maxSubscriptionMonthly: 500,
    maxIncludedTokensMillions: 12,
    blendedTokenCostPerMillion: 3,
    overageMarkupPct: 400,
    infrastructurePerActiveAccount: 25,
    supportPerActiveAccount: 50,
    paymentProcessingPct: 3,
    onboardingCostPerNewAccount: 200,
    plgSharePct: 65,
    plgCac: 750,
    topDownCac: 4_500,
    reserveAtNextGate: 200_000,
    roundIncrement: 100_000,
    fundraisingLeadMonths: 4,
    trailingBurnMonths: 3,
    loadedCostMultiplier: 1.25,
    phases: defaultPhases(),
    financingEvents: defaultFinancingEvents(),
    operatingCosts: defaultOperatingCosts(),
    monthlyCashLanes: defaultMonthlyCashLanes(horizonMonths),
  };
}

const keyHireSchema = z.object({
  roleId: z.string().min(1).max(64),
  startMonth: z.number().optional(),
  headcount: z.number().optional(),
}).strict();

const phaseSchema = z.object({
  key: z.enum(PHASE_KEYS), startMonth: z.number().optional(), endMonth: z.number().optional(), fundedBy: z.string().max(80).optional(),
  productArrMin: z.number().optional(), productArrMax: z.number().optional(), annualNrrMinPct: z.number().optional(), annualGlrMinPct: z.number().optional(),
  accountExpansion90dMin: z.number().optional(), cacPaybackMaxMonths: z.number().optional(), productGrossMarginMinPct: z.number().optional(),
  keyHires: z.array(keyHireSchema).max(40).optional(),
}).strict();

const financingSchema = z.object({
  key: z.enum(FINANCING_KEYS), month: z.number().optional(), amount: z.number().optional(), instrument: z.enum(["post_money_safe", "priced_round"]).optional(),
  valuation: z.number().optional(), optionPoolTopUpPct: z.number().optional(),
}).strict();

const operatingCostSchema = z.object({
  id: z.string().min(1).max(80), label: z.string().min(1).max(120), startMonth: z.number(), endMonth: z.number(), monthlyAmount: z.number(), headcount: z.number(), classification: z.enum(["opex", "product_cogs"]),
  opexCategory: z.enum(["staff", "marketing", "g_and_a"]).optional(),
}).strict();

const cashLaneSchema = z.object({ month: z.number(), consultingRevenue: z.number().optional(), consultingCogs: z.number().optional(), capex: z.number().optional() }).strict();
const legacyStageSchema = z.object({
  key: z.enum(FINANCING_KEYS), roundMonth: z.number().optional(), investmentAmount: z.number().optional(), preMoneyValuation: z.number().optional(),
  referralCoefficient90d: z.number().optional(), nrrAnnualPct: z.number().optional(), monthlyExpenses: z.number().optional(),
}).strict();

const rawAssumptionsSchema = z.object({
  modelVersion: z.number().optional(), horizonMonths: z.number().optional(), startCalendarMonth: z.string().optional(), openingCash: z.number().optional(), startingCash: z.number().optional(),
  startingAccounts: z.number().optional(), startingCustomers: z.number().optional(), quarterOneNewAccounts: z.number().optional(), accountExpansion90d: z.number().optional(),
  annualGrossLogoRetentionPct: z.number().optional(), annualNrrPct: z.number().optional(), maxSubscriptionMonthly: z.number().optional(), revenuePerCustomerMonthly: z.number().optional(),
  maxIncludedTokensMillions: z.number().optional(), blendedTokenCostPerMillion: z.number().optional(), overageMarkupPct: z.number().optional(),
  infrastructurePerActiveAccount: z.number().optional(), supportPerActiveAccount: z.number().optional(), paymentProcessingPct: z.number().optional(), onboardingCostPerNewAccount: z.number().optional(),
  plgSharePct: z.number().optional(), plgCac: z.number().optional(), topDownCac: z.number().optional(), reserveAtNextGate: z.number().optional(), roundIncrement: z.number().optional(),
  fundraisingLeadMonths: z.number().optional(), trailingBurnMonths: z.number().optional(), loadedCostMultiplier: z.number().optional(), phases: z.array(phaseSchema).max(4).optional(), financingEvents: z.array(financingSchema).max(4).optional(),
  operatingCosts: z.array(operatingCostSchema).max(40).optional(), monthlyCashLanes: z.array(cashLaneSchema).max(HORIZON_MAX).optional(), stages: z.array(legacyStageSchema).max(4).optional(),
}).strict();

export const assumptionsPatchSchema = rawAssumptionsSchema;
export type AssumptionsPatch = z.infer<typeof assumptionsPatchSchema>;

function legacyCompatibility(raw: AssumptionsPatch, defaults: Assumptions) {
  const legacyStages = raw.stages ?? [];
  const first = legacyStages[0];
  const legacyOperatingCosts = legacyStages.length > 0 && raw.operatingCosts === undefined
    ? legacyStages.map((stage, index) => ({
        id: `legacy-${stage.key}`, label: `${FINANCING_LABELS[stage.key]} operating plan`, startMonth: whole(stage.roundMonth, 1, HORIZON_MAX, FINANCING_DEFAULTS[stage.key].month),
        endMonth: index < legacyStages.length - 1 ? whole(legacyStages[index + 1].roundMonth, 1, HORIZON_MAX, HORIZON_MAX) - 1 : HORIZON_MAX,
        monthlyAmount: nonNegative(stage.monthlyExpenses, 0), headcount: 0, classification: "opex" as const,
      }))
    : defaults.operatingCosts;
  return {
    openingCash: raw.openingCash ?? raw.startingCash,
    startingAccounts: raw.startingAccounts ?? raw.startingCustomers,
    maxSubscriptionMonthly: raw.maxSubscriptionMonthly ?? raw.revenuePerCustomerMonthly,
    accountExpansion90d: raw.accountExpansion90d ?? first?.referralCoefficient90d,
    annualNrrPct: raw.annualNrrPct ?? first?.nrrAnnualPct,
    operatingCosts: legacyOperatingCosts,
    financingEvents: raw.financingEvents ?? (legacyStages.length > 0 ? FINANCING_KEYS.map((key) => {
      const legacy = legacyStages.find((stage) => stage.key === key);
      const def = FINANCING_DEFAULTS[key];
      const amount = nonNegative(legacy?.investmentAmount, def.amount);
      const preMoney = nonNegative(legacy?.preMoneyValuation, Math.max(0, def.valuation - def.amount));
      return { key, month: whole(legacy?.roundMonth, 1, HORIZON_MAX, def.month), amount, instrument: key === "seed" ? "post_money_safe" as const : "priced_round" as const, valuation: key === "seed" ? preMoney + amount : preMoney, optionPoolTopUpPct: 0 };
    }) : defaults.financingEvents),
  };
}

const FUNDED_BY_REMAP: Record<string, string> = { "Pre-Seed": "Seed", "Seed": "Series A", "Series A": "Series B" };
const LEGACY_STAFF_COST_IDS = new Set(["founder", "founding-engineer", "second-engineer", "customer-success"]);

/**
 * Migrate a stored v2 model to v3 before schema validation. v2 carried four
 * financing keys (pre_seed/seed/series_a/series_b) and hand-entered staff
 * operating costs; v3 keeps three institutional rounds and derives staff cost
 * from Key Hires. The remap is additive and lossless for the surviving rounds:
 * the real pre_seed round becomes Seed, and Series A/B fall back to defaults.
 */
function migrateLegacyModel(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const raw = input as Record<string, unknown>;
  const version = typeof raw.modelVersion === "number" ? raw.modelVersion : 0;
  const financingEvents = Array.isArray(raw.financingEvents) ? raw.financingEvents : [];
  const hasLegacyFinancing = financingEvents.some((event) => (event as { key?: string })?.key === "pre_seed");
  if (version >= MODEL_VERSION && !hasLegacyFinancing) return input;

  const next: Record<string, unknown> = { ...raw };
  // Carry the real founding round (old pre_seed) onto Seed; let Series A/B use v3 defaults.
  next.financingEvents = financingEvents
    .filter((event) => (event as { key?: string })?.key === "pre_seed")
    .map((event) => ({ ...(event as object), key: "seed" }));
  if (Array.isArray(raw.phases)) {
    next.phases = raw.phases.map((phase) => {
      const value = phase as Record<string, unknown>;
      const fundedBy = typeof value.fundedBy === "string" ? (FUNDED_BY_REMAP[value.fundedBy] ?? value.fundedBy) : value.fundedBy;
      const { keyHires: _drop, ...rest } = value;
      return { ...rest, fundedBy };
    });
  }
  if (Array.isArray(raw.operatingCosts)) {
    next.operatingCosts = raw.operatingCosts
      .filter((cost) => !LEGACY_STAFF_COST_IDS.has((cost as { id?: string })?.id ?? ""))
      .map((cost) => (cost as { id?: string })?.id === "ga" ? { ...(cost as object), opexCategory: "g_and_a" } : cost);
  }
  next.modelVersion = MODEL_VERSION;
  return next;
}

export function normalizeAssumptions(input: unknown): Assumptions {
  const parsed = rawAssumptionsSchema.safeParse(migrateLegacyModel(input) ?? {});
  const raw: AssumptionsPatch = parsed.success ? parsed.data : {};
  const defaults = defaultAssumptions();
  const compatibility = legacyCompatibility(raw, defaults);
  const horizonMonths = whole(raw.horizonMonths, HORIZON_MIN, HORIZON_MAX, defaults.horizonMonths);
  const phaseByKey = new Map((raw.phases ?? []).map((phase) => [phase.key, phase]));
  const phases = PHASE_KEYS.map((key) => {
    const value = phaseByKey.get(key) ?? { key };
    const def = PHASE_DEFAULTS[key];
    const keyHires = (value.keyHires ?? def.keyHires)
      .map((hire) => ({
        roleId: hire.roleId.trim(),
        startMonth: whole(hire.startMonth, 1, HORIZON_MAX, def.startMonth || 1),
        headcount: Math.max(1, Math.round(nonNegative(hire.headcount, 1))),
      }))
      .filter((hire) => hire.roleId.length > 0);
    return {
      key,
      startMonth: whole(value.startMonth, 0, HORIZON_MAX, def.startMonth), endMonth: whole(value.endMonth, 0, HORIZON_MAX, def.endMonth), fundedBy: value.fundedBy?.trim() || def.fundedBy,
      productArrMin: nonNegative(value.productArrMin, def.productArrMin), productArrMax: nonNegative(value.productArrMax, def.productArrMax),
      annualNrrMinPct: nonNegative(value.annualNrrMinPct, def.annualNrrMinPct), annualGlrMinPct: bounded(value.annualGlrMinPct, 0, 100, def.annualGlrMinPct),
      accountExpansion90dMin: nonNegative(value.accountExpansion90dMin, def.accountExpansion90dMin), cacPaybackMaxMonths: nonNegative(value.cacPaybackMaxMonths, def.cacPaybackMaxMonths),
      productGrossMarginMinPct: bounded(value.productGrossMarginMinPct, 0, 100, def.productGrossMarginMinPct),
      keyHires,
    };
  });
  const financingByKey = new Map((compatibility.financingEvents ?? []).map((event) => [event.key, event]));
  const financingEvents = FINANCING_KEYS.map((key) => {
    const value = financingByKey.get(key) ?? { key };
    const def = FINANCING_DEFAULTS[key];
    return { key, month: whole(value.month, 1, HORIZON_MAX + 24, def.month), amount: nonNegative(value.amount, def.amount), instrument: value.instrument ?? def.instrument, valuation: nonNegative(value.valuation, def.valuation), optionPoolTopUpPct: bounded(value.optionPoolTopUpPct, 0, 100, def.optionPoolTopUpPct) };
  });
  const operatingCosts = (raw.operatingCosts ?? compatibility.operatingCosts).map((entry) => ({
    id: entry.id, label: entry.label.trim(), startMonth: whole(entry.startMonth, 1, HORIZON_MAX, 1), endMonth: whole(entry.endMonth, 1, HORIZON_MAX, HORIZON_MAX),
    monthlyAmount: nonNegative(entry.monthlyAmount, 0), headcount: nonNegative(entry.headcount, 0), classification: entry.classification,
    opexCategory: entry.classification === "opex" ? ((entry as OperatingCostEntry).opexCategory ?? "g_and_a") : undefined,
  })).map((entry) => ({ ...entry, endMonth: Math.max(entry.startMonth, entry.endMonth) }));
  const laneByMonth = new Map((raw.monthlyCashLanes ?? []).map((lane) => [whole(lane.month, 1, horizonMonths, 1), lane]));
  const monthlyCashLanes = Array.from({ length: horizonMonths }, (_, index) => {
    const month = index + 1; const value = laneByMonth.get(month);
    return { month, consultingRevenue: nonNegative(value?.consultingRevenue, 0), consultingCogs: nonNegative(value?.consultingCogs, 0), capex: nonNegative(value?.capex, 0) };
  });
  return {
    modelVersion: MODEL_VERSION, horizonMonths,
    startCalendarMonth: raw.startCalendarMonth && MONTH_PATTERN.test(raw.startCalendarMonth) ? raw.startCalendarMonth : defaults.startCalendarMonth,
    openingCash: nonNegative(compatibility.openingCash, defaults.openingCash), startingAccounts: nonNegative(compatibility.startingAccounts, defaults.startingAccounts),
    quarterOneNewAccounts: nonNegative(raw.quarterOneNewAccounts, defaults.quarterOneNewAccounts), accountExpansion90d: nonNegative(compatibility.accountExpansion90d, defaults.accountExpansion90d),
    annualGrossLogoRetentionPct: bounded(raw.annualGrossLogoRetentionPct, 0, 100, defaults.annualGrossLogoRetentionPct), annualNrrPct: nonNegative(compatibility.annualNrrPct, defaults.annualNrrPct),
    maxSubscriptionMonthly: nonNegative(compatibility.maxSubscriptionMonthly, defaults.maxSubscriptionMonthly), maxIncludedTokensMillions: nonNegative(raw.maxIncludedTokensMillions, defaults.maxIncludedTokensMillions),
    blendedTokenCostPerMillion: nonNegative(raw.blendedTokenCostPerMillion, defaults.blendedTokenCostPerMillion), overageMarkupPct: nonNegative(raw.overageMarkupPct, defaults.overageMarkupPct),
    infrastructurePerActiveAccount: nonNegative(raw.infrastructurePerActiveAccount, defaults.infrastructurePerActiveAccount), supportPerActiveAccount: nonNegative(raw.supportPerActiveAccount, defaults.supportPerActiveAccount),
    paymentProcessingPct: bounded(raw.paymentProcessingPct, 0, 100, defaults.paymentProcessingPct), onboardingCostPerNewAccount: nonNegative(raw.onboardingCostPerNewAccount, defaults.onboardingCostPerNewAccount),
    plgSharePct: bounded(raw.plgSharePct, 0, 100, defaults.plgSharePct), plgCac: nonNegative(raw.plgCac, defaults.plgCac), topDownCac: nonNegative(raw.topDownCac, defaults.topDownCac),
    reserveAtNextGate: nonNegative(raw.reserveAtNextGate, defaults.reserveAtNextGate), roundIncrement: Math.max(1, nonNegative(raw.roundIncrement, defaults.roundIncrement)),
    fundraisingLeadMonths: whole(raw.fundraisingLeadMonths, 0, 24, defaults.fundraisingLeadMonths), trailingBurnMonths: whole(raw.trailingBurnMonths, 1, 12, defaults.trailingBurnMonths),
    loadedCostMultiplier: bounded(raw.loadedCostMultiplier, LOADED_COST_MULTIPLIER_MIN, LOADED_COST_MULTIPLIER_MAX, defaults.loadedCostMultiplier),
    phases, financingEvents, operatingCosts, monthlyCashLanes,
  };
}

export function mergeAssumptions(current: Assumptions, patch: AssumptionsPatch): Assumptions {
  const phases = new Map(current.phases.map((phase) => [phase.key, phase]));
  for (const phase of patch.phases ?? []) phases.set(phase.key, { ...phases.get(phase.key)!, ...phase });
  const financingEvents = new Map(current.financingEvents.map((event) => [event.key, event]));
  for (const event of patch.financingEvents ?? []) financingEvents.set(event.key, { ...financingEvents.get(event.key)!, ...event });
  const operatingCosts = new Map(current.operatingCosts.map((cost) => [cost.id, cost]));
  for (const cost of patch.operatingCosts ?? []) operatingCosts.set(cost.id, { ...operatingCosts.get(cost.id), ...cost });
  const monthlyCashLanes = new Map(current.monthlyCashLanes.map((lane) => [lane.month, lane]));
  for (const lane of patch.monthlyCashLanes ?? []) monthlyCashLanes.set(lane.month, { ...monthlyCashLanes.get(lane.month), ...lane });
  return normalizeAssumptions({
    ...current,
    ...patch,
    phases: [...phases.values()],
    financingEvents: [...financingEvents.values()],
    operatingCosts: [...operatingCosts.values()],
    monthlyCashLanes: [...monthlyCashLanes.values()],
  });
}

interface Cohort { birthMonth: number; accounts: number; }

export interface MonthRow {
  month: number; label: string; phaseKey: PhaseKey; phaseLabel: string;
  newAccounts: number; newPlgAccounts: number; newTopDownAccounts: number; activeAccounts: number;
  sameCohortRecurringRevenue: number; subscriptionRevenue: number; overageRevenue: number; productRevenue: number; productArr: number;
  consultingRevenue: number; totalCashRevenue: number; includedTokenCogs: number; overageTokenCogs: number; requiredOverageTokensMillions: number; totalTokenUsageMillions: number; overageGrossMargin: number;
  variableProductCogs: number; fixedProductCogs: number; productCogs: number; consultingCogs: number; productGrossMargin: number; consultingGrossMargin: number; blendedCompanyGrossMargin: number;
  acquisitionSpend: number; blendedCac: number; cacPaybackMonths: number; headcount: number; operatingExpense: number; capex: number;
  grossProfit: number; staffOpex: number; marketingOpex: number; gaOpex: number; totalOpex: number; operatingIncome: number;
  netCashChange: number; financingCash: number; endingCash: number; trailingBurn: number; runwayMonths: number;
}

export interface PeriodRow {
  key: string; label: string; startMonth: number; endMonth: number; monthCount: number;
  phaseKey: PhaseKey; phaseLabel: string; financingKey: FinancingKey;
  activeAccounts: number; newAccounts: number;
  totalCashRevenue: number; productRevenue: number; consultingRevenue: number; productCogs: number; consultingCogs: number; cogs: number; grossProfit: number;
  staffOpex: number; marketingOpex: number; gaOpex: number; totalOpex: number; operatingIncome: number;
  acquisitionSpend: number; netCashChange: number; financingCash: number; endingCash: number;
}

export interface GateSummary {
  phaseKey: PhaseKey; label: string; targetMonth: number; status: GateStatus; firstAchievedMonth: number | null;
}

export interface FinancingSummary {
  key: FinancingKey; label: string; month: number; instrument: FinancingInstrument; investment: number; valuation: number; postMoneyValuation: number;
  newInvestorOwnership: number; foundingOwnership: number; foundingPaperValue: number; foundingReturnMultiple: number;
}

export interface FinancingNeed {
  phaseKey: PhaseKey; gateMonth: number; raiseRequired: number; plannedRaise: number; fundingMonth: number; nextFundraiseStartMonth: number;
  cashAtGateWithoutRaise: number; confirmedConsultingNetCash: number; reserveAtGate: number;
}

export interface Projection {
  assumptions: Assumptions; months: MonthRow[]; gates: GateSummary[]; financing: FinancingSummary[]; financingNeed: FinancingNeed;
  impliedRetainedAccountArpaExpansionPct: number; entryContributionGrossMargin: number; baselineCacPaybackMonths: number;
}

function phaseForMonth(phases: PhaseAssumption[], month: number): PhaseAssumption {
  return [...phases].reverse().find((phase) => phase.startMonth <= month) ?? phases[0];
}

function activeCost(cost: OperatingCostEntry, month: number): boolean {
  return cost.startMonth <= month && cost.endMonth >= month;
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function roundUp(value: number, increment: number): number {
  return Math.ceil(Math.max(0, value) / increment) * increment;
}

interface DerivedHire { startMonth: number; monthlyCost: number; isDelivery: boolean; headcount: number; }

/** Loaded monthly cost for one role: base-midpoint × (1 + target bonus) × loaded multiplier ÷ 12. */
function loadedMonthlyForRole(role: JobRole, loadedCostMultiplier: number): number {
  const baseMidpoint = (role.annualSalaryMin + role.annualSalaryMax) / 2;
  const annualLoaded = baseMidpoint * (1 + role.targetBonusPercent / 100) * loadedCostMultiplier;
  return annualLoaded / 12;
}

export function computeProjection(input: Assumptions | unknown, roles: JobRole[] = []): Projection {
  const assumptions = normalizeAssumptions(input);
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const derivedHires: DerivedHire[] = [];
  for (const phase of assumptions.phases) {
    for (const hire of phase.keyHires) {
      const role = roleById.get(hire.roleId);
      if (!role) continue;
      const headcount = Math.max(1, hire.headcount ?? 1);
      derivedHires.push({
        startMonth: hire.startMonth ?? phase.startMonth ?? 1,
        monthlyCost: loadedMonthlyForRole(role, assumptions.loadedCostMultiplier) * headcount,
        isDelivery: role.team === "Customer Success",
        headcount,
      });
    }
  }
  const logoRetentionMonthly = Math.pow(assumptions.annualGrossLogoRetentionPct / 100, 1 / 12);
  const nrrMonthly = Math.pow(assumptions.annualNrrPct / 100, 1 / 12);
  const overagePriceMultiple = 1 + assumptions.overageMarkupPct / 100;
  const overageGrossMargin = overagePriceMultiple > 0 ? 1 - 1 / overagePriceMultiple : 0;
  const includedInferencePerAccount = assumptions.maxIncludedTokensMillions * assumptions.blendedTokenCostPerMillion;
  const entryVariableCogsPerAccount = includedInferencePerAccount + assumptions.infrastructurePerActiveAccount + assumptions.supportPerActiveAccount + assumptions.maxSubscriptionMonthly * assumptions.paymentProcessingPct / 100;
  const entryContributionGrossMargin = assumptions.maxSubscriptionMonthly > 0 ? 1 - entryVariableCogsPerAccount / assumptions.maxSubscriptionMonthly : 0;
  const blendedEntryCac = assumptions.plgSharePct / 100 * assumptions.plgCac + (1 - assumptions.plgSharePct / 100) * assumptions.topDownCac;
  const baselineCacPaybackMonths = assumptions.maxSubscriptionMonthly * entryContributionGrossMargin > 0 ? blendedEntryCac / (assumptions.maxSubscriptionMonthly * entryContributionGrossMargin) : 0;
  const cohorts: Cohort[] = assumptions.startingAccounts > 0 ? [{ birthMonth: 0, accounts: assumptions.startingAccounts }] : [];
  const months: MonthRow[] = [];
  let endingCash = assumptions.openingCash;

  for (let month = 1; month <= assumptions.horizonMonths; month++) {
    const quarter = Math.floor((month - 1) / 3);
    const newAccounts = assumptions.quarterOneNewAccounts * Math.pow(assumptions.accountExpansion90d, quarter) / 3;
    cohorts.push({ birthMonth: month, accounts: newAccounts });
    let activeAccounts = 0;
    let sameCohortRecurringRevenue = 0;
    for (const cohort of cohorts) {
      const age = month - cohort.birthMonth;
      activeAccounts += cohort.accounts * Math.pow(logoRetentionMonthly, age);
      sameCohortRecurringRevenue += cohort.accounts * assumptions.maxSubscriptionMonthly * Math.pow(nrrMonthly, age);
    }
    const baseSubscriptionCapacity = activeAccounts * assumptions.maxSubscriptionMonthly;
    const subscriptionRevenue = Math.min(baseSubscriptionCapacity, sameCohortRecurringRevenue);
    const overageRevenue = Math.max(0, sameCohortRecurringRevenue - subscriptionRevenue);
    const productRevenue = subscriptionRevenue + overageRevenue;
    const overageTokenCogs = overagePriceMultiple > 0 ? overageRevenue / overagePriceMultiple : 0;
    const requiredOverageTokensMillions = assumptions.blendedTokenCostPerMillion > 0 ? overageTokenCogs / assumptions.blendedTokenCostPerMillion : 0;
    const includedTokenCogs = activeAccounts * includedInferencePerAccount;
    const activeHires = derivedHires.filter((hire) => hire.startMonth <= month);
    const keyHireStaffOpex = activeHires.filter((hire) => !hire.isDelivery).reduce((sum, hire) => sum + hire.monthlyCost, 0);
    const keyHireDeliveryCogs = activeHires.filter((hire) => hire.isDelivery).reduce((sum, hire) => sum + hire.monthlyCost, 0);
    const keyHireHeadcount = activeHires.reduce((sum, hire) => sum + hire.headcount, 0);
    const fixedProductCogs = assumptions.operatingCosts.filter((cost) => cost.classification === "product_cogs" && activeCost(cost, month)).reduce((sum, cost) => sum + cost.monthlyAmount, 0) + keyHireDeliveryCogs;
    const variableProductCogs = includedTokenCogs + overageTokenCogs + activeAccounts * (assumptions.infrastructurePerActiveAccount + assumptions.supportPerActiveAccount) + productRevenue * assumptions.paymentProcessingPct / 100 + newAccounts * assumptions.onboardingCostPerNewAccount;
    const productCogs = variableProductCogs + fixedProductCogs;
    const lane = assumptions.monthlyCashLanes[month - 1];
    const consultingRevenue = lane.consultingRevenue;
    const consultingCogs = lane.consultingCogs;
    const totalCashRevenue = productRevenue + consultingRevenue;
    const acquisitionSpend = newAccounts * blendedEntryCac;
    const manualOpex = (category: OpexCategory) => assumptions.operatingCosts.filter((cost) => cost.classification === "opex" && (cost.opexCategory ?? "g_and_a") === category && activeCost(cost, month)).reduce((sum, cost) => sum + cost.monthlyAmount, 0);
    const staffOpex = keyHireStaffOpex + manualOpex("staff");
    const marketingOpex = manualOpex("marketing") + acquisitionSpend;
    const gaOpex = manualOpex("g_and_a");
    const totalOpex = staffOpex + marketingOpex + gaOpex;
    // Cash operating expense excludes acquisitionSpend, which is subtracted as its own cash line below.
    const operatingExpense = staffOpex + manualOpex("marketing") + gaOpex;
    const headcount = assumptions.operatingCosts.filter((cost) => activeCost(cost, month)).reduce((sum, cost) => sum + cost.headcount, 0) + keyHireHeadcount;
    const grossProfit = totalCashRevenue - productCogs - consultingCogs;
    const operatingIncome = grossProfit - totalOpex;
    const netCashChange = totalCashRevenue - productCogs - consultingCogs - acquisitionSpend - operatingExpense - lane.capex;
    const financingCash = assumptions.financingEvents.filter((event) => event.month === month).reduce((sum, event) => sum + event.amount, 0);
    endingCash += netCashChange + financingCash;
    const burnWindow = [...months.slice(-(assumptions.trailingBurnMonths - 1)).map((row) => row.netCashChange), netCashChange];
    const trailingBurn = Math.max(0, -burnWindow.reduce((sum, value) => sum + value, 0) / burnWindow.length);
    const newPlgAccounts = newAccounts * assumptions.plgSharePct / 100;
    months.push({
      month, label: calendarMonthLabel(assumptions.startCalendarMonth, month), phaseKey: phaseForMonth(assumptions.phases, month).key, phaseLabel: PHASE_LABELS[phaseForMonth(assumptions.phases, month).key],
      newAccounts, newPlgAccounts, newTopDownAccounts: newAccounts - newPlgAccounts, activeAccounts, sameCohortRecurringRevenue, subscriptionRevenue, overageRevenue, productRevenue, productArr: productRevenue * 12,
      consultingRevenue, totalCashRevenue, includedTokenCogs, overageTokenCogs, requiredOverageTokensMillions, totalTokenUsageMillions: activeAccounts * assumptions.maxIncludedTokensMillions + requiredOverageTokensMillions, overageGrossMargin,
      variableProductCogs, fixedProductCogs, productCogs, consultingCogs, productGrossMargin: safeRatio(productRevenue - productCogs, productRevenue), consultingGrossMargin: safeRatio(consultingRevenue - consultingCogs, consultingRevenue),
      blendedCompanyGrossMargin: safeRatio(totalCashRevenue - productCogs - consultingCogs, totalCashRevenue), acquisitionSpend, blendedCac: newAccounts > 0 ? acquisitionSpend / newAccounts : blendedEntryCac,
      cacPaybackMonths: baselineCacPaybackMonths, headcount, operatingExpense, capex: lane.capex, grossProfit, staffOpex, marketingOpex, gaOpex, totalOpex, operatingIncome, netCashChange, financingCash, endingCash, trailingBurn, runwayMonths: trailingBurn > 0 ? Math.max(0, endingCash) / trailingBurn : Number.POSITIVE_INFINITY,
    });
  }

  const gates = assumptions.phases.map((phase) => {
    if (phase.key === "phase_0") return { phaseKey: phase.key, label: PHASE_LABELS[phase.key], targetMonth: 0, status: "achieved" as GateStatus, firstAchievedMonth: 0 };
    const achieved = months.find((row) => row.month >= phase.startMonth && row.productArr >= phase.productArrMin && (phase.productArrMax <= 0 || row.productArr <= phase.productArrMax) && assumptions.annualNrrPct >= phase.annualNrrMinPct && assumptions.annualGrossLogoRetentionPct >= phase.annualGlrMinPct && assumptions.accountExpansion90d >= phase.accountExpansion90dMin && (phase.cacPaybackMaxMonths <= 0 || row.cacPaybackMonths <= phase.cacPaybackMaxMonths) && row.productGrossMargin * 100 >= phase.productGrossMarginMinPct);
    const status: GateStatus = achieved ? "achieved" : assumptions.horizonMonths >= phase.endMonth ? "missed" : "not_yet_observable";
    return { phaseKey: phase.key, label: PHASE_LABELS[phase.key], targetMonth: phase.endMonth, status, firstAchievedMonth: achieved?.month ?? null };
  });

  const foundingInvestment = assumptions.financingEvents[0].amount;
  let foundingOwnership = 0;
  const financing = assumptions.financingEvents.map((event, index) => {
    const postMoneyValuation = event.instrument === "post_money_safe" ? event.valuation : event.valuation + event.amount;
    const newInvestorOwnership = postMoneyValuation > 0 ? event.amount / postMoneyValuation : 0;
    foundingOwnership = index === 0 ? newInvestorOwnership : foundingOwnership * Math.max(0, 1 - newInvestorOwnership - event.optionPoolTopUpPct / 100);
    const foundingPaperValue = foundingOwnership * postMoneyValuation;
    return { key: event.key, label: FINANCING_LABELS[event.key], month: event.month, instrument: event.instrument, investment: event.amount, valuation: event.valuation, postMoneyValuation, newInvestorOwnership, foundingOwnership, foundingPaperValue, foundingReturnMultiple: foundingInvestment > 0 ? foundingPaperValue / foundingInvestment : 0 };
  });

  const nextGate = assumptions.phases.find((phase) => phase.key === "phase_1")!;
  const throughGate = months.filter((row) => row.month <= nextGate.endMonth);
  let cashWithoutRaise = assumptions.openingCash;
  let minimumCashWithoutRaise = cashWithoutRaise;
  for (const row of throughGate) { cashWithoutRaise += row.netCashChange; minimumCashWithoutRaise = Math.min(minimumCashWithoutRaise, cashWithoutRaise); }
  const requiredForSolvency = Math.max(0, -minimumCashWithoutRaise);
  const requiredForReserve = Math.max(0, assumptions.reserveAtNextGate - cashWithoutRaise);
  const raiseRequired = roundUp(Math.max(requiredForSolvency, requiredForReserve), assumptions.roundIncrement);
  const founding = assumptions.financingEvents[0];
  const financingNeed: FinancingNeed = {
    phaseKey: nextGate.key, gateMonth: nextGate.endMonth, raiseRequired, plannedRaise: founding.amount, fundingMonth: founding.month,
    nextFundraiseStartMonth: Math.max(1, nextGate.endMonth - assumptions.fundraisingLeadMonths), cashAtGateWithoutRaise: cashWithoutRaise,
    confirmedConsultingNetCash: throughGate.reduce((sum, row) => sum + row.consultingRevenue - row.consultingCogs, 0), reserveAtGate: assumptions.reserveAtNextGate,
  };

  return { assumptions, months, gates, financing, financingNeed, impliedRetainedAccountArpaExpansionPct: assumptions.annualGrossLogoRetentionPct > 0 ? assumptions.annualNrrPct / assumptions.annualGrossLogoRetentionPct * 100 : 0, entryContributionGrossMargin, baselineCacPaybackMonths };
}

/**
 * Roll monthly rows up into the requested period. Monthly is the source of
 * truth: flows are summed, balances (accounts, ending cash) are period-end,
 * and no ratio is averaged — margins are recomputed from summed numerators
 * and denominators by the consumer.
 */
export function aggregateMonths(months: MonthRow[], mode: PeriodMode): PeriodRow[] {
  if (months.length === 0) return [];
  const size = mode === "annually" ? 12 : mode === "quarterly" ? 3 : 1;
  const rows: PeriodRow[] = [];
  for (let index = 0; index < months.length; index += size) {
    const slice = months.slice(index, index + size);
    const first = slice[0];
    const last = slice[slice.length - 1];
    const sum = (pick: (row: MonthRow) => number) => slice.reduce((acc, row) => acc + pick(row), 0);
    rows.push({
      key: `${first.month}-${last.month}`,
      label: size === 1 ? last.label : `${first.label}–${last.label}`,
      startMonth: first.month,
      endMonth: last.month,
      monthCount: slice.length,
      phaseKey: last.phaseKey,
      phaseLabel: last.phaseLabel,
      financingKey: PHASE_FINANCING[last.phaseKey],
      activeAccounts: last.activeAccounts,
      newAccounts: sum((row) => row.newAccounts),
      totalCashRevenue: sum((row) => row.totalCashRevenue),
      productRevenue: sum((row) => row.productRevenue),
      consultingRevenue: sum((row) => row.consultingRevenue),
      productCogs: sum((row) => row.productCogs),
      consultingCogs: sum((row) => row.consultingCogs),
      cogs: sum((row) => row.productCogs + row.consultingCogs),
      grossProfit: sum((row) => row.grossProfit),
      staffOpex: sum((row) => row.staffOpex),
      marketingOpex: sum((row) => row.marketingOpex),
      gaOpex: sum((row) => row.gaOpex),
      totalOpex: sum((row) => row.totalOpex),
      operatingIncome: sum((row) => row.operatingIncome),
      acquisitionSpend: sum((row) => row.acquisitionSpend),
      netCashChange: sum((row) => row.netCashChange),
      financingCash: sum((row) => row.financingCash),
      endingCash: last.endingCash,
    });
  }
  return rows;
}
