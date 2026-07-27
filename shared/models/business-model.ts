import { z } from "zod";

export const MODEL_VERSION = 2;
export const HORIZON_MIN = 1;
export const HORIZON_MAX = 120;
export const PHASE_KEYS = ["phase_0", "phase_1", "phase_2", "phase_3"] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];
export const FINANCING_KEYS = ["pre_seed", "seed", "series_a", "series_b"] as const;
export type FinancingKey = (typeof FINANCING_KEYS)[number];
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
  pre_seed: "Pre-Seed",
  seed: "Seed",
  series_a: "Series A",
  series_b: "Series B",
};

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
  phase_0: { startMonth: 0, endMonth: 0, fundedBy: "Bootstrap", productArrMin: 0, productArrMax: 0, annualNrrMinPct: 0, annualGlrMinPct: 0, accountExpansion90dMin: 0, cacPaybackMaxMonths: 0, productGrossMarginMinPct: 0 },
  phase_1: { startMonth: 1, endMonth: 18, fundedBy: "Pre-Seed", productArrMin: 1_000_000, productArrMax: 2_000_000, annualNrrMinPct: 150, annualGlrMinPct: 90, accountExpansion90dMin: 0, cacPaybackMaxMonths: 0, productGrossMarginMinPct: 0 },
  phase_2: { startMonth: 19, endMonth: 36, fundedBy: "Seed", productArrMin: 10_000_000, productArrMax: 0, annualNrrMinPct: 0, annualGlrMinPct: 0, accountExpansion90dMin: 1.5, cacPaybackMaxMonths: 12, productGrossMarginMinPct: 0 },
  phase_3: { startMonth: 37, endMonth: 60, fundedBy: "Series A", productArrMin: 30_000_000, productArrMax: 50_000_000, annualNrrMinPct: 0, annualGlrMinPct: 0, accountExpansion90dMin: 0, cacPaybackMaxMonths: 0, productGrossMarginMinPct: 80 },
};

const FINANCING_DEFAULTS: Record<FinancingKey, Omit<FinancingEvent, "key">> = {
  pre_seed: { month: 1, amount: 1_000_000, instrument: "post_money_safe", valuation: 8_000_000, optionPoolTopUpPct: 0 },
  seed: { month: 19, amount: 0, instrument: "priced_round", valuation: 20_000_000, optionPoolTopUpPct: 0 },
  series_a: { month: 37, amount: 0, instrument: "priced_round", valuation: 75_000_000, optionPoolTopUpPct: 0 },
  series_b: { month: 61, amount: 0, instrument: "priced_round", valuation: 250_000_000, optionPoolTopUpPct: 0 },
};

export function defaultPhases(): PhaseAssumption[] {
  return PHASE_KEYS.map((key) => ({ key, ...PHASE_DEFAULTS[key] }));
}

export function defaultFinancingEvents(): FinancingEvent[] {
  return FINANCING_KEYS.map((key) => ({ key, ...FINANCING_DEFAULTS[key] }));
}

export function defaultOperatingCosts(): OperatingCostEntry[] {
  return [
    { id: "founder", label: "Founder", startMonth: 1, endMonth: 120, monthlyAmount: 12_000, headcount: 1, classification: "opex" },
    { id: "founding-engineer", label: "Founding Engineer", startMonth: 1, endMonth: 120, monthlyAmount: 18_000, headcount: 1, classification: "opex" },
    { id: "ga", label: "G&A, tools, legal, security", startMonth: 1, endMonth: 120, monthlyAmount: 6_000, headcount: 0, classification: "opex" },
    { id: "customer-success", label: "Customer Success delivery", startMonth: 7, endMonth: 120, monthlyAmount: 12_000, headcount: 1, classification: "product_cogs" },
    { id: "second-engineer", label: "Second Engineer", startMonth: 13, endMonth: 120, monthlyAmount: 20_000, headcount: 1, classification: "opex" },
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
    phases: defaultPhases(),
    financingEvents: defaultFinancingEvents(),
    operatingCosts: defaultOperatingCosts(),
    monthlyCashLanes: defaultMonthlyCashLanes(horizonMonths),
  };
}

const phaseSchema = z.object({
  key: z.enum(PHASE_KEYS), startMonth: z.number().optional(), endMonth: z.number().optional(), fundedBy: z.string().max(80).optional(),
  productArrMin: z.number().optional(), productArrMax: z.number().optional(), annualNrrMinPct: z.number().optional(), annualGlrMinPct: z.number().optional(),
  accountExpansion90dMin: z.number().optional(), cacPaybackMaxMonths: z.number().optional(), productGrossMarginMinPct: z.number().optional(),
}).strict();

const financingSchema = z.object({
  key: z.enum(FINANCING_KEYS), month: z.number().optional(), amount: z.number().optional(), instrument: z.enum(["post_money_safe", "priced_round"]).optional(),
  valuation: z.number().optional(), optionPoolTopUpPct: z.number().optional(),
}).strict();

const operatingCostSchema = z.object({
  id: z.string().min(1).max(80), label: z.string().min(1).max(120), startMonth: z.number(), endMonth: z.number(), monthlyAmount: z.number(), headcount: z.number(), classification: z.enum(["opex", "product_cogs"]),
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
  fundraisingLeadMonths: z.number().optional(), trailingBurnMonths: z.number().optional(), phases: z.array(phaseSchema).max(4).optional(), financingEvents: z.array(financingSchema).max(4).optional(),
  operatingCosts: z.array(operatingCostSchema).max(40).optional(), monthlyCashLanes: z.array(cashLaneSchema).max(HORIZON_MAX).optional(), stages: z.array(legacyStageSchema).max(4).optional(),
}).strict();

export const assumptionsPatchSchema = rawAssumptionsSchema;
export type AssumptionsPatch = z.infer<typeof assumptionsPatchSchema>;

function legacyCompatibility(raw: AssumptionsPatch, defaults: Assumptions) {
  const legacyStages = raw.stages ?? [];
  const first = legacyStages.find((stage) => stage.key === "pre_seed");
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
      return { key, month: whole(legacy?.roundMonth, 1, HORIZON_MAX, def.month), amount, instrument: key === "pre_seed" ? "post_money_safe" as const : "priced_round" as const, valuation: key === "pre_seed" ? preMoney + amount : preMoney, optionPoolTopUpPct: 0 };
    }) : defaults.financingEvents),
  };
}

export function normalizeAssumptions(input: unknown): Assumptions {
  const parsed = rawAssumptionsSchema.safeParse(input ?? {});
  const raw: AssumptionsPatch = parsed.success ? parsed.data : {};
  const defaults = defaultAssumptions();
  const compatibility = legacyCompatibility(raw, defaults);
  const horizonMonths = whole(raw.horizonMonths, HORIZON_MIN, HORIZON_MAX, defaults.horizonMonths);
  const phaseByKey = new Map((raw.phases ?? []).map((phase) => [phase.key, phase]));
  const phases = PHASE_KEYS.map((key) => {
    const value = phaseByKey.get(key) ?? { key };
    const def = PHASE_DEFAULTS[key];
    return {
      key,
      startMonth: whole(value.startMonth, 0, HORIZON_MAX, def.startMonth), endMonth: whole(value.endMonth, 0, HORIZON_MAX, def.endMonth), fundedBy: value.fundedBy?.trim() || def.fundedBy,
      productArrMin: nonNegative(value.productArrMin, def.productArrMin), productArrMax: nonNegative(value.productArrMax, def.productArrMax),
      annualNrrMinPct: nonNegative(value.annualNrrMinPct, def.annualNrrMinPct), annualGlrMinPct: bounded(value.annualGlrMinPct, 0, 100, def.annualGlrMinPct),
      accountExpansion90dMin: nonNegative(value.accountExpansion90dMin, def.accountExpansion90dMin), cacPaybackMaxMonths: nonNegative(value.cacPaybackMaxMonths, def.cacPaybackMaxMonths),
      productGrossMarginMinPct: bounded(value.productGrossMarginMinPct, 0, 100, def.productGrossMarginMinPct),
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
  netCashChange: number; financingCash: number; endingCash: number; trailingBurn: number; runwayMonths: number;
}

export interface GateSummary {
  phaseKey: PhaseKey; label: string; targetMonth: number; status: GateStatus; firstAchievedMonth: number | null;
}

export interface FinancingSummary {
  key: FinancingKey; label: string; month: number; instrument: FinancingInstrument; investment: number; valuation: number; postMoneyValuation: number;
  newInvestorOwnership: number; preSeedOwnership: number; preSeedPaperValue: number; preSeedReturnMultiple: number;
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

export function computeProjection(input: Assumptions | unknown): Projection {
  const assumptions = normalizeAssumptions(input);
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
    const fixedProductCogs = assumptions.operatingCosts.filter((cost) => cost.classification === "product_cogs" && activeCost(cost, month)).reduce((sum, cost) => sum + cost.monthlyAmount, 0);
    const variableProductCogs = includedTokenCogs + overageTokenCogs + activeAccounts * (assumptions.infrastructurePerActiveAccount + assumptions.supportPerActiveAccount) + productRevenue * assumptions.paymentProcessingPct / 100 + newAccounts * assumptions.onboardingCostPerNewAccount;
    const productCogs = variableProductCogs + fixedProductCogs;
    const lane = assumptions.monthlyCashLanes[month - 1];
    const consultingRevenue = lane.consultingRevenue;
    const consultingCogs = lane.consultingCogs;
    const totalCashRevenue = productRevenue + consultingRevenue;
    const acquisitionSpend = newAccounts * blendedEntryCac;
    const operatingExpense = assumptions.operatingCosts.filter((cost) => cost.classification === "opex" && activeCost(cost, month)).reduce((sum, cost) => sum + cost.monthlyAmount, 0);
    const headcount = assumptions.operatingCosts.filter((cost) => activeCost(cost, month)).reduce((sum, cost) => sum + cost.headcount, 0);
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
      cacPaybackMonths: baselineCacPaybackMonths, headcount, operatingExpense, capex: lane.capex, netCashChange, financingCash, endingCash, trailingBurn, runwayMonths: trailingBurn > 0 ? Math.max(0, endingCash) / trailingBurn : Number.POSITIVE_INFINITY,
    });
  }

  const gates = assumptions.phases.map((phase) => {
    if (phase.key === "phase_0") return { phaseKey: phase.key, label: PHASE_LABELS[phase.key], targetMonth: 0, status: "achieved" as GateStatus, firstAchievedMonth: 0 };
    const achieved = months.find((row) => row.month >= phase.startMonth && row.productArr >= phase.productArrMin && (phase.productArrMax <= 0 || row.productArr <= phase.productArrMax) && assumptions.annualNrrPct >= phase.annualNrrMinPct && assumptions.annualGrossLogoRetentionPct >= phase.annualGlrMinPct && assumptions.accountExpansion90d >= phase.accountExpansion90dMin && (phase.cacPaybackMaxMonths <= 0 || row.cacPaybackMonths <= phase.cacPaybackMaxMonths) && row.productGrossMargin * 100 >= phase.productGrossMarginMinPct);
    const status: GateStatus = achieved ? "achieved" : assumptions.horizonMonths >= phase.endMonth ? "missed" : "not_yet_observable";
    return { phaseKey: phase.key, label: PHASE_LABELS[phase.key], targetMonth: phase.endMonth, status, firstAchievedMonth: achieved?.month ?? null };
  });

  const preSeedInvestment = assumptions.financingEvents[0].amount;
  let preSeedOwnership = 0;
  const financing = assumptions.financingEvents.map((event, index) => {
    const postMoneyValuation = event.instrument === "post_money_safe" ? event.valuation : event.valuation + event.amount;
    const newInvestorOwnership = postMoneyValuation > 0 ? event.amount / postMoneyValuation : 0;
    preSeedOwnership = index === 0 ? newInvestorOwnership : preSeedOwnership * Math.max(0, 1 - newInvestorOwnership - event.optionPoolTopUpPct / 100);
    const preSeedPaperValue = preSeedOwnership * postMoneyValuation;
    return { key: event.key, label: FINANCING_LABELS[event.key], month: event.month, instrument: event.instrument, investment: event.amount, valuation: event.valuation, postMoneyValuation, newInvestorOwnership, preSeedOwnership, preSeedPaperValue, preSeedReturnMultiple: preSeedInvestment > 0 ? preSeedPaperValue / preSeedInvestment : 0 };
  });

  const nextGate = assumptions.phases.find((phase) => phase.key === "phase_1")!;
  const throughGate = months.filter((row) => row.month <= nextGate.endMonth);
  let cashWithoutRaise = assumptions.openingCash;
  let minimumCashWithoutRaise = cashWithoutRaise;
  for (const row of throughGate) { cashWithoutRaise += row.netCashChange; minimumCashWithoutRaise = Math.min(minimumCashWithoutRaise, cashWithoutRaise); }
  const requiredForSolvency = Math.max(0, -minimumCashWithoutRaise);
  const requiredForReserve = Math.max(0, assumptions.reserveAtNextGate - cashWithoutRaise);
  const raiseRequired = roundUp(Math.max(requiredForSolvency, requiredForReserve), assumptions.roundIncrement);
  const preSeed = assumptions.financingEvents[0];
  const financingNeed: FinancingNeed = {
    phaseKey: nextGate.key, gateMonth: nextGate.endMonth, raiseRequired, plannedRaise: preSeed.amount, fundingMonth: preSeed.month,
    nextFundraiseStartMonth: Math.max(1, nextGate.endMonth - assumptions.fundraisingLeadMonths), cashAtGateWithoutRaise: cashWithoutRaise,
    confirmedConsultingNetCash: throughGate.reduce((sum, row) => sum + row.consultingRevenue - row.consultingCogs, 0), reserveAtGate: assumptions.reserveAtNextGate,
  };

  return { assumptions, months, gates, financing, financingNeed, impliedRetainedAccountArpaExpansionPct: assumptions.annualGrossLogoRetentionPct > 0 ? assumptions.annualNrrPct / assumptions.annualGrossLogoRetentionPct * 100 : 0, entryContributionGrossMargin, baselineCacPaybackMonths };
}
