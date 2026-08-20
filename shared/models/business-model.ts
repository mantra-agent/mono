import { z } from "zod";
import { budgetMonthlyTotal, departmentMonthlyTotal, type BudgetDepartment } from "./business-budgets";
import type { JobRole } from "./job-roles";
import {
  baseMonthlyForRole,
  EMPTY_STAFF_COST_COMPONENTS,
  monthOffset,
  staffCostComponentsForBase,
  totalStaffCostComponents,
  type BusinessHiringSlot,
  type StaffCostComponents,
  type StaffLoadAssumptions,
} from "./business-hiring";
import type { BusinessPricing, PricingPackageKey, PricingPackageView } from "./business-pricing";
import {
  FORECAST_METRIC_CATALOG,
  type ProjectedMetricSeries,
} from "./metrics";

export const MODEL_VERSION = 6;
export const HORIZON_MIN = 1;
export const HORIZON_MAX = 120;
export const LOADED_COST_MULTIPLIER_MIN = 0.5;
export const LOADED_COST_MULTIPLIER_MAX = 3;
export const MATCH_RATE_PCT_MIN = 0;
export const MATCH_RATE_PCT_MAX = 25;
export const HEALTHCARE_COVERAGE_RATE_PCT_MIN = 0;
export const HEALTHCARE_COVERAGE_RATE_PCT_MAX = 100;
export const EMPLOYER_TAX_RATE_PCT_MIN = 0;
export const EMPLOYER_TAX_RATE_PCT_MAX = 25;
export const MONTHLY_HDV_PREMIUM_PER_EMPLOYEE_MIN = 0;
export const MONTHLY_HDV_PREMIUM_PER_EMPLOYEE_MAX = 5_000;
export const STAFF_COST_COMPONENT_LABELS = {
  salary: "Salary",
  match: "401k Matching",
  hdv: "Health/Dental/Vision",
  taxes: "Taxes",
} as const;
export const PHASE_KEYS = ["phase_0", "phase_1", "phase_2", "phase_3"] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];
export const FINANCING_KEYS = ["pre_seed", "seed", "series_a"] as const;
export type FinancingKey = (typeof FINANCING_KEYS)[number];
export type OpexCategory = "staff" | "marketing" | "g_and_a";
export type PeriodMode = "monthly" | "quarterly" | "annually";

/** Maps each operating phase to the financing band that funds its projection (Phase 0 is bootstrap-only). */
export const PHASE_FINANCING: Record<PhaseKey, FinancingKey> = {
  phase_0: "pre_seed",
  phase_1: "pre_seed",
  phase_2: "seed",
  phase_3: "series_a",
};
export type FinancingInstrument = "post_money_safe" | "priced_round";
export type CostClassification = "opex" | "product_cogs";
export type HireCostAllocation = "opex" | "product_cogs" | "acquisition_split";
export type HireActivation = "scheduled" | "evidence_triggered";
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
};

export interface StageKeyHire {
  roleId: string;
  startMonth?: number;
  headcount?: number;
  costAllocation?: HireCostAllocation;
  acquisitionAllocationPct?: number;
  activation?: HireActivation;
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
  startingUsers: number;
  quarterOneNewAccounts: number;
  averageUsersPerNewAccount: number;
  accountExpansion90d: number;
  downsideAccountExpansion90d: number;
  annualAccountChurnPct: number;
  annualExistingAccountUserGrowthPct: number;
  annualExistingAccountUserContractionPct: number;
  annualAccountUpgradePct: number;
  /** @deprecated Compatibility projection derived from account churn. */
  annualGrossLogoRetentionPct: number;
  /** @deprecated Compatibility input. NRR is now calculated from cohort revenue. */
  annualNrrPct: number;
  individualEntrySharePct: number;
  maxSubscriptionMonthly: number;
  maxPlusSubscriptionMonthly: number;
  enterpriseSubscriptionMonthly: number;
  participantSeatMonthly: number;
  averageEntrySeatsPerTeamAccount: number;
  maxIncludedParticipants: number;
  maxPlusIncludedParticipants: number;
  enterpriseIncludedParticipants: number;
  maxIncludedTokensMillions: number;
  maxPlusIncludedTokensMillions: number;
  enterpriseIncludedTokensMillions: number;
  /** Factory+ entry volume share. Default 0 keeps the book on Max / Max+. */
  factoryPlusEntrySharePct: number;
  /** Max entry volume share. Absent on legacy rows so 100 − Factory+ stays Max. */
  maxEntrySharePct: number;
  /** Max+ entry volume share. Absent on legacy rows stays 0. */
  maxPlusEntrySharePct: number;
  /** @deprecated Compatibility alias for factoryPlusEntrySharePct. */
  enterpriseEntrySharePct: number;
  hoursUsedPerActiveUser: number;
  meetingsPerHour: number;
  internalMeetingSharePct: number;
  newAccountsPerExternalMeeting: number;
  expandedUsersPerInternalMeeting: number;
  tokensUsedPerHour: number;
  blendedTokenCostPerMillion: number;
  overageMarkupPct: number;
  nrrSeatSharePct: number;
  nrrTierSharePct: number;
  nrrOverageSharePct: number;
  infrastructurePerActiveAccount: number;
  supportPerActiveAccount: number;
  seatInferenceAndSupportCost: number;
  paymentProcessingPct: number;
  onboardingCostPerNewAccount: number;
  productizedOnboardingMonth: number;
  productizedOnboardingCostPerNewAccount: number;
  plgSharePct: number;
  plgCac: number;
  topDownCac: number;
  reserveAtNextGate: number;
  roundIncrement: number;
  fundraisingLeadMonths: number;
  trailingBurnMonths: number;
  /** @deprecated Compatibility only — derived from explicit staff load rates when absent. */
  loadedCostMultiplier: number;
  matchRatePct: number;
  healthcareCoverageRatePct: number;
  employerTaxRatePct: number;
  monthlyHdvPremiumPerEmployee: number;
  phases: PhaseAssumption[];
  financingEvents: FinancingEvent[];
  operatingCosts: OperatingCostEntry[];
  monthlyCashLanes: MonthlyCashLane[];
  /** KPI id per assumption key. Missing or unmeasured samples keep the custom number. */
  assumptionKpis: Record<string, string>;
}

export interface FinancialModel {
  id: string;
  businessId: string;
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

function calendarMonthAt(startCalendarMonth: string, monthIndex: number): string {
  const base = MONTH_PATTERN.test(startCalendarMonth) ? startCalendarMonth : nextCalendarMonth();
  const [year, month] = base.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1 + monthIndex - 1, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function calendarMonthLabel(startCalendarMonth: string, monthIndex: number): string {
  const calendarMonth = calendarMonthAt(startCalendarMonth, monthIndex);
  const [year, month] = calendarMonth.split("-").map(Number);
  return `${MONTH_ABBR[month - 1]} '${String(year).slice(-2)}`;
}

const PHASE_DEFAULTS: Record<PhaseKey, Omit<PhaseAssumption, "key">> = {
  phase_0: { startMonth: 0, endMonth: 0, fundedBy: "Bootstrap", productArrMin: 0, productArrMax: 0, annualNrrMinPct: 0, annualGlrMinPct: 0, accountExpansion90dMin: 0, cacPaybackMaxMonths: 0, productGrossMarginMinPct: 0, keyHires: [] },
  phase_1: { startMonth: 1, endMonth: 18, fundedBy: "Pre-Seed", productArrMin: 1_000_000, productArrMax: 2_000_000, annualNrrMinPct: 150, annualGlrMinPct: 90, accountExpansion90dMin: 0, cacPaybackMaxMonths: 0, productGrossMarginMinPct: 0, keyHires: [
    { roleId: "18d90c4f05e92d7d", startMonth: 1, costAllocation: "opex", activation: "scheduled" },
    { roleId: "ac66ad0dcbcc671f", startMonth: 1, costAllocation: "opex", activation: "scheduled" },
    { roleId: "e1a648d46196d359", startMonth: 9, costAllocation: "acquisition_split", acquisitionAllocationPct: 70, activation: "evidence_triggered" },
  ] },
  phase_2: { startMonth: 19, endMonth: 36, fundedBy: "Seed", productArrMin: 2_000_000, productArrMax: 10_000_000, annualNrrMinPct: 0, annualGlrMinPct: 0, accountExpansion90dMin: 1.5, cacPaybackMaxMonths: 12, productGrossMarginMinPct: 0, keyHires: [] },
  phase_3: { startMonth: 37, endMonth: 54, fundedBy: "Series A", productArrMin: 30_000_000, productArrMax: 50_000_000, annualNrrMinPct: 0, annualGlrMinPct: 0, accountExpansion90dMin: 0, cacPaybackMaxMonths: 0, productGrossMarginMinPct: 80, keyHires: [] },
};

const FINANCING_DEFAULTS: Record<FinancingKey, Omit<FinancingEvent, "key">> = {
  pre_seed: { month: 1, amount: 1_250_000, instrument: "post_money_safe", valuation: 10_000_000, optionPoolTopUpPct: 0 },
  seed: { month: 19, amount: 8_000_000, instrument: "priced_round", valuation: 40_000_000, optionPoolTopUpPct: 0 },
  series_a: { month: 37, amount: 0, instrument: "priced_round", valuation: 150_000_000, optionPoolTopUpPct: 0 },
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
  return Array.from({ length: horizonMonths }, (_, index) => ({ month: index + 1, capex: 0 }));
}

export function defaultAssumptions(): Assumptions {
  const horizonMonths = 48;
  return {
    modelVersion: MODEL_VERSION,
    horizonMonths,
    startCalendarMonth: nextCalendarMonth(),
    openingCash: 12_500,
    startingAccounts: 0,
    startingUsers: 0,
    quarterOneNewAccounts: 10,
    averageUsersPerNewAccount: 1,
    accountExpansion90d: 1.5,
    downsideAccountExpansion90d: 1.35,
    annualAccountChurnPct: 10,
    annualExistingAccountUserGrowthPct: 35,
    annualExistingAccountUserContractionPct: 0,
    annualAccountUpgradePct: 20,
    annualGrossLogoRetentionPct: 90,
    annualNrrPct: 150,
    individualEntrySharePct: 85,
    maxSubscriptionMonthly: 500,
    maxPlusSubscriptionMonthly: 1_000,
    enterpriseSubscriptionMonthly: 5_000,
    participantSeatMonthly: 200,
    averageEntrySeatsPerTeamAccount: 5,
    maxIncludedParticipants: 0,
    maxPlusIncludedParticipants: 3,
    enterpriseIncludedParticipants: 10,
    maxIncludedTokensMillions: 12,
    maxPlusIncludedTokensMillions: 30,
    enterpriseIncludedTokensMillions: 330,
    factoryPlusEntrySharePct: 20,
    maxEntrySharePct: 50,
    maxPlusEntrySharePct: 30,
    enterpriseEntrySharePct: 20,
    hoursUsedPerActiveUser: 20,
    meetingsPerHour: 0.5,
    internalMeetingSharePct: 70,
    newAccountsPerExternalMeeting: 0,
    expandedUsersPerInternalMeeting: 0,
    tokensUsedPerHour: 600_000,
    blendedTokenCostPerMillion: 3,
    overageMarkupPct: 400,
    nrrSeatSharePct: 50,
    nrrTierSharePct: 30,
    nrrOverageSharePct: 20,
    infrastructurePerActiveAccount: 25,
    supportPerActiveAccount: 50,
    seatInferenceAndSupportCost: 30,
    paymentProcessingPct: 3,
    onboardingCostPerNewAccount: 200,
    productizedOnboardingMonth: 12,
    productizedOnboardingCostPerNewAccount: 75,
    plgSharePct: 55,
    plgCac: 750,
    topDownCac: 4_500,
    reserveAtNextGate: 300_000,
    roundIncrement: 100_000,
    fundraisingLeadMonths: 4,
    trailingBurnMonths: 3,
    loadedCostMultiplier: 1,
    matchRatePct: 4,
    healthcareCoverageRatePct: 100,
    employerTaxRatePct: 8,
    monthlyHdvPremiumPerEmployee: 1_880,
    phases: defaultPhases(),
    financingEvents: defaultFinancingEvents(),
    operatingCosts: defaultOperatingCosts(),
    monthlyCashLanes: defaultMonthlyCashLanes(horizonMonths),
    assumptionKpis: {},
  };
}

export function staffLoadFromAssumptions(assumptions: Pick<
  Assumptions,
  "matchRatePct" | "healthcareCoverageRatePct" | "employerTaxRatePct" | "monthlyHdvPremiumPerEmployee"
>): StaffLoadAssumptions {
  return {
    matchRatePct: assumptions.matchRatePct,
    healthcareCoverageRatePct: assumptions.healthcareCoverageRatePct,
    employerTaxRatePct: assumptions.employerTaxRatePct,
    monthlyHdvPremiumPerEmployee: assumptions.monthlyHdvPremiumPerEmployee,
  };
}

export function deriveLoadedCostMultiplier(load: StaffLoadAssumptions): number {
  // Approximate portfolio load for compatibility consumers: taxes + match on wages, plus HDV as a share of a $185k mid salary.
  const wageLoad = 1 + Math.max(0, load.matchRatePct) / 100 + Math.max(0, load.employerTaxRatePct) / 100;
  const hdvShare = (Math.max(0, load.monthlyHdvPremiumPerEmployee) * 12 * Math.max(0, load.healthcareCoverageRatePct) / 100) / 185_000;
  return Math.min(LOADED_COST_MULTIPLIER_MAX, Math.max(LOADED_COST_MULTIPLIER_MIN, wageLoad + hdvShare));
}

const keyHireSchema = z.object({
  roleId: z.string().min(1).max(64),
  startMonth: z.number().optional(),
  headcount: z.number().optional(),
  costAllocation: z.enum(["opex", "product_cogs", "acquisition_split"]).optional(),
  acquisitionAllocationPct: z.number().optional(),
  activation: z.enum(["scheduled", "evidence_triggered"]).optional(),
}).strict();

const phaseSchema = z.object({
  key: z.enum(PHASE_KEYS), startMonth: z.number().optional(), endMonth: z.number().optional(), fundedBy: z.string().max(80).optional(),
  productArrMin: z.number().optional(), productArrMax: z.number().optional(), annualNrrMinPct: z.number().optional(), annualGlrMinPct: z.number().optional(),
  accountExpansion90dMin: z.number().optional(), cacPaybackMaxMonths: z.number().optional(), productGrossMarginMinPct: z.number().optional(),
  keyHires: z.array(keyHireSchema).max(40).optional(),
}).strict();

const financingSchema = z.object({
  key: z.enum(["pre_seed", "seed", "series_a", "series_b"]), month: z.number().optional(), amount: z.number().optional(), instrument: z.enum(["post_money_safe", "priced_round"]).optional(),
  valuation: z.number().optional(), optionPoolTopUpPct: z.number().optional(),
}).strict();

const operatingCostSchema = z.object({
  id: z.string().min(1).max(80), label: z.string().min(1).max(120), startMonth: z.number(), endMonth: z.number(), monthlyAmount: z.number(), headcount: z.number(), classification: z.enum(["opex", "product_cogs"]),
  opexCategory: z.enum(["staff", "marketing", "g_and_a"]).optional(),
}).strict();

const cashLaneSchema = z.object({ month: z.number(), capex: z.number().optional() }).strict();
const legacyStageSchema = z.object({
  key: z.enum(["pre_seed", "seed", "series_a", "series_b"]), roundMonth: z.number().optional(), investmentAmount: z.number().optional(), preMoneyValuation: z.number().optional(),
  referralCoefficient90d: z.number().optional(), nrrAnnualPct: z.number().optional(), monthlyExpenses: z.number().optional(),
}).strict();

const rawAssumptionsSchema = z.object({
  modelVersion: z.number().optional(), horizonMonths: z.number().optional(), startCalendarMonth: z.string().optional(), openingCash: z.number().optional(), startingCash: z.number().optional(),
  startingAccounts: z.number().optional(), startingCustomers: z.number().optional(), startingUsers: z.number().optional(), quarterOneNewAccounts: z.number().optional(), averageUsersPerNewAccount: z.number().optional(), accountExpansion90d: z.number().optional(), downsideAccountExpansion90d: z.number().optional(),
  annualAccountChurnPct: z.number().optional(), annualExistingAccountUserGrowthPct: z.number().optional(), annualExistingAccountUserContractionPct: z.number().optional(), annualAccountUpgradePct: z.number().optional(),
  annualGrossLogoRetentionPct: z.number().optional(), annualNrrPct: z.number().optional(), individualEntrySharePct: z.number().optional(), maxSubscriptionMonthly: z.number().optional(), revenuePerCustomerMonthly: z.number().optional(),
  maxPlusSubscriptionMonthly: z.number().optional(), enterpriseSubscriptionMonthly: z.number().optional(), participantSeatMonthly: z.number().optional(), averageEntrySeatsPerTeamAccount: z.number().optional(),
  maxIncludedParticipants: z.number().optional(), maxPlusIncludedParticipants: z.number().optional(), enterpriseIncludedParticipants: z.number().optional(),
  maxIncludedTokensMillions: z.number().optional(), maxPlusIncludedTokensMillions: z.number().optional(), enterpriseIncludedTokensMillions: z.number().optional(), factoryPlusEntrySharePct: z.number().optional(), maxEntrySharePct: z.number().optional(), maxPlusEntrySharePct: z.number().optional(), enterpriseEntrySharePct: z.number().optional(),
  hoursUsedPerActiveUser: z.number().optional(), meetingsPerHour: z.number().optional(), internalMeetingSharePct: z.number().optional(), newAccountsPerExternalMeeting: z.number().optional(), expandedUsersPerInternalMeeting: z.number().optional(), tokensUsedPerHour: z.number().optional(), blendedTokenCostPerMillion: z.number().optional(), overageMarkupPct: z.number().optional(),
  nrrSeatSharePct: z.number().optional(), nrrTierSharePct: z.number().optional(), nrrOverageSharePct: z.number().optional(),
  infrastructurePerActiveAccount: z.number().optional(), supportPerActiveAccount: z.number().optional(), seatInferenceAndSupportCost: z.number().optional(), paymentProcessingPct: z.number().optional(), onboardingCostPerNewAccount: z.number().optional(),
  productizedOnboardingMonth: z.number().optional(), productizedOnboardingCostPerNewAccount: z.number().optional(),
  plgSharePct: z.number().optional(), plgCac: z.number().optional(), topDownCac: z.number().optional(), reserveAtNextGate: z.number().optional(), roundIncrement: z.number().optional(),
  fundraisingLeadMonths: z.number().optional(), trailingBurnMonths: z.number().optional(), loadedCostMultiplier: z.number().optional(),
  matchRatePct: z.number().optional(), healthcareCoverageRatePct: z.number().optional(), employerTaxRatePct: z.number().optional(), monthlyHdvPremiumPerEmployee: z.number().optional(),
  phases: z.array(phaseSchema).max(4).optional(), financingEvents: z.array(financingSchema).max(4).optional(),
  operatingCosts: z.array(operatingCostSchema).max(40).optional(), monthlyCashLanes: z.array(cashLaneSchema).max(HORIZON_MAX).optional(), stages: z.array(legacyStageSchema).max(4).optional(),
  assumptionKpis: z.record(z.string()).optional(),
}).strict();

export const assumptionsPatchSchema = rawAssumptionsSchema;
export type AssumptionsPatch = z.infer<typeof assumptionsPatchSchema>;

const LEGACY_FINANCING_LABELS: Record<string, string> = {
  pre_seed: "Pre-Seed",
  seed: "Seed",
  series_a: "Series A",
  series_b: "Series B",
};
const LEGACY_STAFF_COST_IDS = new Set(["founder", "founding-engineer", "second-engineer", "customer-success"]);
const V3_FINANCING_REMAP: Record<string, FinancingKey> = { seed: "pre_seed", series_a: "seed", series_b: "series_a" };
const V3_FUNDED_BY_REMAP: Record<string, string> = { Seed: "Pre-Seed", "Series A": "Seed", "Series B": "Series A" };
const V3_GENERATED_BASELINE = {
  seedAmount: 1_000_000,
  seedValuation: 8_000_000,
  reserveAtNextGate: 200_000,
  plgSharePct: 65,
  loadedCostMultiplier: 1.25,
};
const HIRE_ALLOCATION_DEFAULTS: Record<string, Pick<StageKeyHire, "costAllocation" | "acquisitionAllocationPct">> = {
  bb87b49068593dc8: { costAllocation: "product_cogs", acquisitionAllocationPct: 0 },
  e1a648d46196d359: { costAllocation: "acquisition_split", acquisitionAllocationPct: 70 },
};
const V4_GENERATED_PHASE_ONE_HIRES: StageKeyHire[] = [
  { roleId: "18d90c4f05e92d7d", startMonth: 1, costAllocation: "opex" },
  { roleId: "ac66ad0dcbcc671f", startMonth: 1, costAllocation: "opex" },
  { roleId: "bb87b49068593dc8", startMonth: 7, costAllocation: "product_cogs" },
  { roleId: "e1a648d46196d359", startMonth: 9, costAllocation: "acquisition_split", acquisitionAllocationPct: 70 },
  { roleId: "e8fc275fa51a38d2", startMonth: 13, costAllocation: "opex" },
];

function matchesGeneratedHireBaseline(value: unknown, baseline: StageKeyHire[]): boolean {
  if (!Array.isArray(value) || value.length !== baseline.length) return false;
  const expectedByRole = new Map(baseline.map((hire) => [hire.roleId, hire]));
  return value.every((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const hire = candidate as Record<string, unknown>;
    const expected = expectedByRole.get(typeof hire.roleId === "string" ? hire.roleId : "");
    return Boolean(expected)
      && (hire.startMonth ?? expected!.startMonth) === expected!.startMonth
      && (hire.headcount ?? 1) === 1
      && (hire.costAllocation ?? "opex") === expected!.costAllocation
      && (hire.acquisitionAllocationPct ?? (expected!.costAllocation === "acquisition_split" ? 70 : 0)) === (expected!.acquisitionAllocationPct ?? 0)
      && (hire.activation === undefined || hire.activation === "scheduled");
  });
}

function legacyCompatibility(raw: AssumptionsPatch, defaults: Assumptions) {
  const legacyStages = raw.stages ?? [];
  const first = legacyStages[0];
  const legacyOperatingCosts = legacyStages.length > 0 && raw.operatingCosts === undefined
    ? legacyStages.map((stage, index) => ({
        id: `legacy-${stage.key}`,
        label: `${LEGACY_FINANCING_LABELS[stage.key] ?? stage.key} operating plan`,
        startMonth: whole(stage.roundMonth, 1, HORIZON_MAX, 1),
        endMonth: index < legacyStages.length - 1 ? whole(legacyStages[index + 1].roundMonth, 1, HORIZON_MAX, HORIZON_MAX) - 1 : HORIZON_MAX,
        monthlyAmount: nonNegative(stage.monthlyExpenses, 0),
        headcount: 0,
        classification: "opex" as const,
      }))
    : defaults.operatingCosts;
  const stageFinancing = legacyStages.length > 0
    ? FINANCING_KEYS.map((key) => {
        const legacyKey = key === "pre_seed" ? "pre_seed" : key;
        const legacy = legacyStages.find((stage) => stage.key === legacyKey);
        const def = FINANCING_DEFAULTS[key];
        const amount = nonNegative(legacy?.investmentAmount, def.amount);
        const preMoney = nonNegative(legacy?.preMoneyValuation, Math.max(0, def.valuation - amount));
        return {
          key,
          month: whole(legacy?.roundMonth, 1, HORIZON_MAX, def.month),
          amount,
          instrument: key === "pre_seed" ? "post_money_safe" as const : "priced_round" as const,
          valuation: key === "pre_seed" ? preMoney + amount : preMoney,
          optionPoolTopUpPct: 0,
        };
      })
    : defaults.financingEvents;
  return {
    openingCash: raw.openingCash ?? raw.startingCash,
    startingAccounts: raw.startingAccounts ?? raw.startingCustomers,
    maxSubscriptionMonthly: raw.maxSubscriptionMonthly ?? raw.revenuePerCustomerMonthly,
    accountExpansion90d: raw.accountExpansion90d ?? first?.referralCoefficient90d,
    annualNrrPct: raw.annualNrrPct ?? first?.nrrAnnualPct,
    operatingCosts: legacyOperatingCosts,
    financingEvents: (raw.financingEvents ?? stageFinancing) as FinancingEvent[],
  };
}

/**
 * Migrate old stored shapes before strict validation. v3 mislabeled the real
 * Pre-Seed/Seed/Series A sequence as Seed/Series A/Series B. v4 translates
 * those identities. v5 replaces only the exact generated Phase 1 hire set;
 * explicit amounts, months, valuations, thresholds, and customized hires stay intact.
 */
function migrateLegacyModel(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const raw = input as Record<string, unknown>;
  const version = typeof raw.modelVersion === "number" ? raw.modelVersion : 0;
  if (version >= MODEL_VERSION) return input;

  const next: Record<string, unknown> = { ...raw };
  if (Array.isArray(raw.financingEvents)) {
    next.financingEvents = raw.financingEvents.map((event) => {
      const value = event as Record<string, unknown>;
      const legacyKey = typeof value.key === "string" ? value.key : "";
      const key = version === 3 ? (V3_FINANCING_REMAP[legacyKey] ?? legacyKey) : value.key;
      const isGeneratedV3PreSeed = version === 3
        && legacyKey === "seed"
        && value.amount === V3_GENERATED_BASELINE.seedAmount
        && value.valuation === V3_GENERATED_BASELINE.seedValuation;
      return isGeneratedV3PreSeed ? { ...value, key, ...FINANCING_DEFAULTS.pre_seed } : { ...value, key };
    });
  }
  if (Array.isArray(raw.phases)) {
    next.phases = raw.phases.map((phase) => {
      const value = phase as Record<string, unknown>;
      const fundedBy = typeof value.fundedBy === "string" && version === 3 ? (V3_FUNDED_BY_REMAP[value.fundedBy] ?? value.fundedBy) : value.fundedBy;
      const hires = Array.isArray(value.keyHires) ? [...value.keyHires] : [];
      if (version === 3 && value.key === "phase_1" && !hires.some((hire) => (hire as { roleId?: string })?.roleId === "e1a648d46196d359")) {
        hires.push({ roleId: "e1a648d46196d359", startMonth: 9, costAllocation: "acquisition_split", acquisitionAllocationPct: 70 });
      }
      if (version >= 3 && version <= 4 && value.key === "phase_1" && matchesGeneratedHireBaseline(hires, V4_GENERATED_PHASE_ONE_HIRES)) {
        return { ...value, fundedBy, keyHires: PHASE_DEFAULTS.phase_1.keyHires };
      }
      return { ...value, fundedBy, keyHires: hires };
    });
  }
  if (Array.isArray(raw.operatingCosts)) {
    next.operatingCosts = raw.operatingCosts
      .filter((cost) => !LEGACY_STAFF_COST_IDS.has((cost as { id?: string })?.id ?? ""))
      .map((cost) => (cost as { id?: string })?.id === "ga" ? { ...(cost as object), opexCategory: "g_and_a" } : cost);
  }
  if (version === 3 && raw.reserveAtNextGate === V3_GENERATED_BASELINE.reserveAtNextGate) next.reserveAtNextGate = defaultAssumptions().reserveAtNextGate;
  if (version === 3 && raw.plgSharePct === V3_GENERATED_BASELINE.plgSharePct) next.plgSharePct = defaultAssumptions().plgSharePct;
  if (version === 3 && raw.loadedCostMultiplier === V3_GENERATED_BASELINE.loadedCostMultiplier) next.loadedCostMultiplier = defaultAssumptions().loadedCostMultiplier;
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
      .map((hire) => {
        const allocationDefault = HIRE_ALLOCATION_DEFAULTS[hire.roleId] ?? { costAllocation: "opex" as const, acquisitionAllocationPct: 0 };
        const costAllocation = hire.costAllocation ?? allocationDefault.costAllocation ?? "opex";
        return {
          roleId: hire.roleId.trim(),
          startMonth: whole(hire.startMonth, 1, HORIZON_MAX, def.startMonth || 1),
          headcount: Math.max(1, Math.round(nonNegative(hire.headcount, 1))),
          costAllocation,
          acquisitionAllocationPct: bounded(hire.acquisitionAllocationPct, 0, 100, costAllocation === "acquisition_split" ? allocationDefault.acquisitionAllocationPct ?? 70 : 0),
          activation: hire.activation ?? "scheduled",
        };
      })
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
    return { month, capex: nonNegative(value?.capex, 0) };
  });
  const next: Assumptions = {
    modelVersion: MODEL_VERSION, horizonMonths,
    startCalendarMonth: raw.startCalendarMonth && MONTH_PATTERN.test(raw.startCalendarMonth) ? raw.startCalendarMonth : defaults.startCalendarMonth,
    openingCash: nonNegative(compatibility.openingCash, defaults.openingCash), startingAccounts: nonNegative(compatibility.startingAccounts, defaults.startingAccounts),
    startingUsers: nonNegative(raw.startingUsers, Math.max(nonNegative(compatibility.startingAccounts, defaults.startingAccounts), defaults.startingUsers)),
    quarterOneNewAccounts: nonNegative(raw.quarterOneNewAccounts, defaults.quarterOneNewAccounts), averageUsersPerNewAccount: Math.max(1, nonNegative(raw.averageUsersPerNewAccount, defaults.averageUsersPerNewAccount)),
    accountExpansion90d: nonNegative(compatibility.accountExpansion90d, defaults.accountExpansion90d), downsideAccountExpansion90d: nonNegative(raw.downsideAccountExpansion90d, defaults.downsideAccountExpansion90d),
    annualAccountChurnPct: bounded(raw.annualAccountChurnPct, 0, 100, 100 - bounded(raw.annualGrossLogoRetentionPct, 0, 100, defaults.annualGrossLogoRetentionPct)),
    annualExistingAccountUserGrowthPct: nonNegative(raw.annualExistingAccountUserGrowthPct, defaults.annualExistingAccountUserGrowthPct),
    annualExistingAccountUserContractionPct: bounded(raw.annualExistingAccountUserContractionPct, 0, 100, defaults.annualExistingAccountUserContractionPct),
    annualAccountUpgradePct: bounded(raw.annualAccountUpgradePct, 0, 100, defaults.annualAccountUpgradePct),
    annualGrossLogoRetentionPct: 100 - bounded(raw.annualAccountChurnPct, 0, 100, 100 - bounded(raw.annualGrossLogoRetentionPct, 0, 100, defaults.annualGrossLogoRetentionPct)), annualNrrPct: nonNegative(compatibility.annualNrrPct, defaults.annualNrrPct),
    individualEntrySharePct: bounded(raw.individualEntrySharePct, 0, 100, defaults.individualEntrySharePct),
    maxSubscriptionMonthly: nonNegative(compatibility.maxSubscriptionMonthly, defaults.maxSubscriptionMonthly), maxPlusSubscriptionMonthly: nonNegative(raw.maxPlusSubscriptionMonthly, defaults.maxPlusSubscriptionMonthly),
    enterpriseSubscriptionMonthly: nonNegative(raw.enterpriseSubscriptionMonthly, defaults.enterpriseSubscriptionMonthly),
    participantSeatMonthly: nonNegative(raw.participantSeatMonthly, defaults.participantSeatMonthly), averageEntrySeatsPerTeamAccount: nonNegative(raw.averageEntrySeatsPerTeamAccount, defaults.averageEntrySeatsPerTeamAccount),
    maxIncludedParticipants: nonNegative(raw.maxIncludedParticipants, defaults.maxIncludedParticipants),
    maxPlusIncludedParticipants: nonNegative(raw.maxPlusIncludedParticipants, defaults.maxPlusIncludedParticipants),
    enterpriseIncludedParticipants: nonNegative(raw.enterpriseIncludedParticipants, defaults.enterpriseIncludedParticipants),
    maxIncludedTokensMillions: nonNegative(raw.maxIncludedTokensMillions, defaults.maxIncludedTokensMillions), maxPlusIncludedTokensMillions: nonNegative(raw.maxPlusIncludedTokensMillions, defaults.maxPlusIncludedTokensMillions),
    enterpriseIncludedTokensMillions: nonNegative(raw.enterpriseIncludedTokensMillions, defaults.enterpriseIncludedTokensMillions),
    factoryPlusEntrySharePct: (() => {
      const storedFactory = raw.factoryPlusEntrySharePct ?? raw.enterpriseEntrySharePct;
      const hasNewMix = raw.maxEntrySharePct != null || raw.maxPlusEntrySharePct != null;
      if (!hasNewMix && (storedFactory == null || storedFactory === 0)) return defaults.factoryPlusEntrySharePct;
      return bounded(storedFactory, 0, 100, defaults.factoryPlusEntrySharePct);
    })(),
    maxEntrySharePct: (() => {
      const storedFactory = raw.factoryPlusEntrySharePct ?? raw.enterpriseEntrySharePct;
      const hasNewMix = raw.maxEntrySharePct != null || raw.maxPlusEntrySharePct != null;
      if (!hasNewMix && (storedFactory == null || storedFactory === 0)) return defaults.maxEntrySharePct;
      return bounded(raw.maxEntrySharePct, 0, 100, hasNewMix ? defaults.maxEntrySharePct : Math.max(0, 100 - bounded(storedFactory, 0, 100, defaults.factoryPlusEntrySharePct)));
    })(),
    maxPlusEntrySharePct: (() => {
      const storedFactory = raw.factoryPlusEntrySharePct ?? raw.enterpriseEntrySharePct;
      const hasNewMix = raw.maxEntrySharePct != null || raw.maxPlusEntrySharePct != null;
      if (!hasNewMix && (storedFactory == null || storedFactory === 0)) return defaults.maxPlusEntrySharePct;
      return bounded(raw.maxPlusEntrySharePct, 0, 100, hasNewMix ? defaults.maxPlusEntrySharePct : 0);
    })(),
    enterpriseEntrySharePct: (() => {
      const storedFactory = raw.factoryPlusEntrySharePct ?? raw.enterpriseEntrySharePct;
      const hasNewMix = raw.maxEntrySharePct != null || raw.maxPlusEntrySharePct != null;
      if (!hasNewMix && (storedFactory == null || storedFactory === 0)) return defaults.enterpriseEntrySharePct;
      return bounded(storedFactory, 0, 100, defaults.enterpriseEntrySharePct);
    })(),
    hoursUsedPerActiveUser: nonNegative(raw.hoursUsedPerActiveUser, defaults.hoursUsedPerActiveUser),
    meetingsPerHour: nonNegative(raw.meetingsPerHour, defaults.meetingsPerHour),
    internalMeetingSharePct: bounded(raw.internalMeetingSharePct, 0, 100, defaults.internalMeetingSharePct),
    newAccountsPerExternalMeeting: nonNegative(raw.newAccountsPerExternalMeeting, defaults.newAccountsPerExternalMeeting),
    expandedUsersPerInternalMeeting: nonNegative(raw.expandedUsersPerInternalMeeting, defaults.expandedUsersPerInternalMeeting),
    tokensUsedPerHour: nonNegative(raw.tokensUsedPerHour, defaults.tokensUsedPerHour),
    blendedTokenCostPerMillion: nonNegative(raw.blendedTokenCostPerMillion, defaults.blendedTokenCostPerMillion), overageMarkupPct: nonNegative(raw.overageMarkupPct, defaults.overageMarkupPct),
    nrrSeatSharePct: bounded(raw.nrrSeatSharePct, 0, 100, defaults.nrrSeatSharePct), nrrTierSharePct: bounded(raw.nrrTierSharePct, 0, 100, defaults.nrrTierSharePct), nrrOverageSharePct: bounded(raw.nrrOverageSharePct, 0, 100, defaults.nrrOverageSharePct),
    infrastructurePerActiveAccount: nonNegative(raw.infrastructurePerActiveAccount, defaults.infrastructurePerActiveAccount), supportPerActiveAccount: nonNegative(raw.supportPerActiveAccount, defaults.supportPerActiveAccount),
    seatInferenceAndSupportCost: nonNegative(raw.seatInferenceAndSupportCost, defaults.seatInferenceAndSupportCost), paymentProcessingPct: bounded(raw.paymentProcessingPct, 0, 100, defaults.paymentProcessingPct),
    onboardingCostPerNewAccount: nonNegative(raw.onboardingCostPerNewAccount, defaults.onboardingCostPerNewAccount), productizedOnboardingMonth: whole(raw.productizedOnboardingMonth, 1, HORIZON_MAX, defaults.productizedOnboardingMonth),
    productizedOnboardingCostPerNewAccount: nonNegative(raw.productizedOnboardingCostPerNewAccount, defaults.productizedOnboardingCostPerNewAccount),
    plgSharePct: bounded(raw.plgSharePct, 0, 100, defaults.plgSharePct), plgCac: nonNegative(raw.plgCac, defaults.plgCac), topDownCac: nonNegative(raw.topDownCac, defaults.topDownCac),
    reserveAtNextGate: nonNegative(raw.reserveAtNextGate, defaults.reserveAtNextGate), roundIncrement: Math.max(1, nonNegative(raw.roundIncrement, defaults.roundIncrement)),
    fundraisingLeadMonths: whole(raw.fundraisingLeadMonths, 0, 24, defaults.fundraisingLeadMonths), trailingBurnMonths: whole(raw.trailingBurnMonths, 1, 12, defaults.trailingBurnMonths),
    matchRatePct: bounded(raw.matchRatePct, MATCH_RATE_PCT_MIN, MATCH_RATE_PCT_MAX, defaults.matchRatePct),
    healthcareCoverageRatePct: bounded(raw.healthcareCoverageRatePct, HEALTHCARE_COVERAGE_RATE_PCT_MIN, HEALTHCARE_COVERAGE_RATE_PCT_MAX, defaults.healthcareCoverageRatePct),
    employerTaxRatePct: bounded(
      raw.employerTaxRatePct,
      EMPLOYER_TAX_RATE_PCT_MIN,
      EMPLOYER_TAX_RATE_PCT_MAX,
      raw.employerTaxRatePct == null && raw.loadedCostMultiplier != null
        ? Math.max(0, (Number(raw.loadedCostMultiplier) - 1) * 100)
        : defaults.employerTaxRatePct,
    ),
    monthlyHdvPremiumPerEmployee: bounded(raw.monthlyHdvPremiumPerEmployee, MONTHLY_HDV_PREMIUM_PER_EMPLOYEE_MIN, MONTHLY_HDV_PREMIUM_PER_EMPLOYEE_MAX, defaults.monthlyHdvPremiumPerEmployee),
    loadedCostMultiplier: bounded(raw.loadedCostMultiplier, LOADED_COST_MULTIPLIER_MIN, LOADED_COST_MULTIPLIER_MAX, defaults.loadedCostMultiplier),
    phases, financingEvents, operatingCosts, monthlyCashLanes,
    assumptionKpis: normalizeAssumptionKpis(raw.assumptionKpis),
  };
  next.loadedCostMultiplier = deriveLoadedCostMultiplier(staffLoadFromAssumptions(next));
  return next;
}

function normalizeAssumptionKpis(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, kpiId]) => (
    typeof key === "string" && key.length > 0 && typeof kpiId === "string" && kpiId.trim().length > 0
      ? [[key, kpiId.trim()]]
      : []
  )));
}

/** Overlay measured KPI samples onto custom assumption numbers. Unmeasured links keep the typed fallback. */
export function applyAssumptionSamples(assumptions: Assumptions, samples: Record<string, number>): Assumptions {
  const links = assumptions.assumptionKpis ?? {};
  const financingEvents = assumptions.financingEvents.map((event) => {
    const kpiId = links[event.key];
    const sample = kpiId ? samples[kpiId] : undefined;
    return Number.isFinite(sample) ? { ...event, amount: sample as number } : event;
  });
  const next: Assumptions = { ...assumptions, assumptionKpis: links, financingEvents };
  for (const [key, kpiId] of Object.entries(links)) {
    if ((FINANCING_KEYS as readonly string[]).includes(key)) continue;
    const sample = samples[kpiId];
    if (!Number.isFinite(sample) || !(key in next)) continue;
    const current = (next as unknown as Record<string, unknown>)[key];
    if (typeof current !== "number") continue;
    (next as unknown as Record<string, number>)[key] = sample as number;
  }
  return next;
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

interface Cohort {
  birthMonth: number;
  accounts: number;
  usersPerAccount: number;
}

export interface MonthRow {
  month: number; calendarMonth: string; label: string; phaseKey: PhaseKey; phaseLabel: string;
  newAccounts: number; newPlgAccounts: number; newTopDownAccounts: number; churnedAccounts: number; activeAccounts: number;
  maxAccounts: number; maxPlusAccounts: number; factoryPlusAccounts: number;
  newUsers: number; expandedUsers: number; contractedUsers: number; existingAccountUsers: number; activeUsers: number;
  principals: number; participants: number; agents: number;
  meetings: number; internalMeetings: number; externalMeetings: number; newAccountsFromMeetings: number; newAccountsFromSales: number; expandedUsersFromMeetings: number;
  hoursUsed: number; activationHours: number; checkInHours: number; tokensUsed: number; tokenCost: number;
  startingCohortRevenue: number; churnedRevenue: number; userExpansionRevenue: number; userContractionRevenue: number; tierExpansionRevenue: number; sameCohortRecurringRevenue: number; cohortNrr: number;
  subscriptionRevenue: number; seatExpansionRevenue: number; overageRevenue: number; productRevenue: number; productArr: number;
  activeSeats: number; requiredTierUpgrades: number; overageDominant: boolean;
  totalCashRevenue: number; includedTokenCogs: number; seatCogs: number; supportCogs: number; supportActivationCogs: number; supportCheckInCogs: number; overageTokenCogs: number; requiredOverageTokensMillions: number; totalTokenUsageMillions: number; overageGrossMargin: number;
  productCogs: number; productGrossMargin: number; blendedCompanyGrossMargin: number;
  acquisitionSpend: number; blendedCac: number; cacPaybackMonths: number; headcount: number; operatingExpense: number; capex: number;
  grossProfit: number; staffOpex: number; staffByComponent: StaffCostComponents; staffByRole: Record<string, number>; acquisitionOpex: number; budgetOpex: number; departmentOpex: Record<string, number>;
  totalOpex: number; operatingIncome: number;
  netCashChange: number; financingCash: number; endingCash: number; trailingBurn: number; runwayMonths: number;
}

export interface PeriodRow {
  key: string; label: string; startMonth: number; endMonth: number; monthCount: number;
  phaseKey: PhaseKey; phaseLabel: string; financingKey: FinancingKey;
  activeAccounts: number; maxAccounts: number; maxPlusAccounts: number; factoryPlusAccounts: number;
  newAccounts: number; newAccountsFromMeetings: number; newAccountsFromSales: number; churnedAccounts: number; activeUsers: number; newUsers: number; expandedUsers: number; contractedUsers: number;
  principals: number; participants: number; agents: number;
  meetings: number; internalMeetings: number; externalMeetings: number; expandedUsersFromMeetings: number;
  hoursUsed: number; activationHours: number; checkInHours: number; tokensUsed: number; tokenCost: number; supportActivationCogs: number; supportCheckInCogs: number;
  startingCohortRevenue: number; churnedRevenue: number; userExpansionRevenue: number; userContractionRevenue: number; tierExpansionRevenue: number; cohortNrr: number;
  totalCashRevenue: number; productRevenue: number; productCogs: number; supportCogs: number; cogs: number; mrr: number; arr: number; grossProfit: number;
  staffOpex: number; staffByComponent: StaffCostComponents; staffByRole: Record<string, number>; acquisitionOpex: number; budgetOpex: number; departmentOpex: Record<string, number>;
  totalOpex: number; operatingIncome: number;
  acquisitionSpend: number; netCashChange: number; financingCash: number; endingCash: number; runwayMonths: number;
}

export interface GateSummary {
  phaseKey: PhaseKey; label: string; targetMonth: number; status: GateStatus; firstAchievedMonth: number | null;
}

export interface FinancingSummary {
  key: FinancingKey; label: string; month: number; instrument: FinancingInstrument; investment: number; valuation: number; postMoneyValuation: number;
  newInvestorOwnership: number; cumulativeInvestorOwnership: number; founderOwnershipRemaining: number; investorPaperValue: number; investorReturnMultiple: number;
}

export interface FinancingNeed {
  phaseKey: PhaseKey; gateMonth: number; raiseRequired: number; plannedRaise: number; fundingMonth: number; nextFundraiseStartMonth: number;
  cashAtGateWithoutRaise: number; reserveAtGate: number;
}

export interface PhaseOneFinancingScenario {
  amount: number;
  baselineCashAtGate: number;
  downsideCashAtGate: number;
  baselineReserveGap: number;
  downsideReserveGap: number;
  baselineNextFundraiseStartMonth: number;
  downsideNextFundraiseStartMonth: number;
}

export const PHASE_ONE_FIRST_CLOSE_AMOUNT = 750_000;

export interface Projection {
  assumptions: Assumptions; months: MonthRow[]; gates: GateSummary[]; financing: FinancingSummary[]; financingNeed: FinancingNeed;
  metricSeries: ProjectedMetricSeries[];
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

/**
 * Billable extra Participants after the package include.
 * People count stays on averageUsersPerNewAccount; only max(people − included, 0) bills.
 * Null catalog include means unlimited / no seat fee.
 */
export function billableExtraParticipants(peopleCount: number, includedParticipants: number): number {
  if (!Number.isFinite(includedParticipants)) return 0;
  return Math.max(0, Math.max(0, peopleCount) - Math.max(0, includedParticipants));
}

/** Package numbers live on BusinessPricing. Forecast may still persist these keys for one-release reads. */
export const RETIRED_PACKAGE_ASSUMPTION_KEYS = [
  "maxSubscriptionMonthly",
  "maxPlusSubscriptionMonthly",
  "enterpriseSubscriptionMonthly",
  "participantSeatMonthly",
  "maxIncludedParticipants",
  "maxPlusIncludedParticipants",
  "enterpriseIncludedParticipants",
  "maxIncludedTokensMillions",
  "maxPlusIncludedTokensMillions",
  "enterpriseIncludedTokensMillions",
  "enterpriseEntrySharePct",
  "overageMarkupPct",
  "blendedTokenCostPerMillion",
] as const;

export type RetiredPackageAssumptionKey = (typeof RETIRED_PACKAGE_ASSUMPTION_KEYS)[number];

const RETIRED_PACKAGE_ASSUMPTION_KEY_SET = new Set<string>(RETIRED_PACKAGE_ASSUMPTION_KEYS);

export function isRetiredPackageAssumptionKey(key: string): key is RetiredPackageAssumptionKey {
  return RETIRED_PACKAGE_ASSUMPTION_KEY_SET.has(key);
}

function requirePricing(pricing: BusinessPricing | undefined): BusinessPricing {
  if (!pricing) {
    throw new Error("computeProjection requires BusinessPricing; load BusinessPricingStorage.getOrCreate(businessId)");
  }
  return pricing;
}

function catalogPackage(pricing: BusinessPricing, key: PricingPackageKey): PricingPackageView {
  const pkg = pricing.packages.find((row) => row.key === key);
  if (!pkg) throw new Error(`BusinessPricing is missing package ${key}`);
  return pkg;
}

function recognizedMonthly(pkg: PricingPackageView, accountAgeMonths: number): number {
  return accountAgeMonths < 12 ? pkg.yearOneMonthly : pkg.yearTwoMonthly;
}

function catalogIncludedParticipants(pkg: PricingPackageView): number {
  return pkg.includedParticipants ?? Number.POSITIVE_INFINITY;
}

function catalogExtraParticipantMonthly(pkg: PricingPackageView): number {
  return pkg.extraParticipantMonthly ?? 0;
}

function catalogOverageMultiple(pricing: BusinessPricing): number {
  const cost = pricing.extras.workhorseInputPerMillion;
  return cost > 0 ? pricing.extras.extraUsagePerMillion / cost : 1;
}

const SUPPORT_LOADED_HOURLY = 100;
const PACKAGE_USAGE_HOURS: Record<PricingPackageKey, number> = {
  max: 5,
  max_plus: 10,
  factory_plus: 80,
};
const PACKAGE_DELIVERY_HOURS: Record<PricingPackageKey, { activation: number; checkIns: number }> = {
  max: { activation: 2, checkIns: 2 },
  max_plus: { activation: 2, checkIns: 4 },
  factory_plus: { activation: 8, checkIns: 5 },
};

function normalizeEntryShares(assumptions: Assumptions): { max: number; maxPlus: number; factory: number } {
  const max = Math.max(0, assumptions.maxEntrySharePct);
  const maxPlus = Math.max(0, assumptions.maxPlusEntrySharePct);
  const factory = Math.max(0, assumptions.factoryPlusEntrySharePct);
  const total = max + maxPlus + factory;
  if (total <= 0) return { max: 1, maxPlus: 0, factory: 0 };
  return { max: max / total, maxPlus: maxPlus / total, factory: factory / total };
}

function catalogIncludedPeople(pkg: PricingPackageView): number {
  return pkg.includedPrincipals + (Number.isFinite(catalogIncludedParticipants(pkg)) ? catalogIncludedParticipants(pkg) : 0);
}

function yearOneDeliveryHours(key: PricingPackageKey, ageMonths: number): { activation: number; checkIns: number } {
  const hours = PACKAGE_DELIVERY_HOURS[key];
  return {
    activation: ageMonths === 0 ? hours.activation : 0,
    checkIns: ageMonths < 12 ? hours.checkIns : 0,
  };
}

function roundUp(value: number, increment: number): number {
  return Math.ceil(Math.max(0, value) / increment) * increment;
}

interface DerivedHire {
  id: string;
  startMonth: number;
  baseMonthly: number;
  components: StaffCostComponents;
  monthlyCost: number;
  costAllocation: HireCostAllocation;
  acquisitionAllocationPct: number;
  headcount: number;
}

export function computeProjection(input: Assumptions | unknown, roles: JobRole[] = [], budgetDepartments?: BudgetDepartment[], hiringSlots?: BusinessHiringSlot[], pricing?: BusinessPricing): Projection {
  const assumptions = normalizeAssumptions(input);
  const catalog = requirePricing(pricing);
  const maxPackage = catalogPackage(catalog, "max");
  const maxPlusPackage = catalogPackage(catalog, "max_plus");
  const factoryPlusPackage = catalogPackage(catalog, "factory_plus");
  const tokenCostPerMillion = catalog.extras.workhorseInputPerMillion;
  const overagePriceMultiple = catalogOverageMultiple(catalog);
  const entryShares = normalizeEntryShares(assumptions);
  const packagePeopleCharge = (pkg: PricingPackageView, peopleCount: number) =>
    billableExtraParticipants(peopleCount, catalogIncludedParticipants(pkg)) * catalogExtraParticipantMonthly(pkg);
  const packageRecognized = (pkg: PricingPackageView, ageMonths: number, peopleCount: number) =>
    recognizedMonthly(pkg, ageMonths) + packagePeopleCharge(pkg, peopleCount);
  const splitTypes = (accounts: number, upgradeShare: number) => {
    const factoryPlusAccounts = accounts * entryShares.factory;
    const remaining = accounts - factoryPlusAccounts;
    const remainder = entryShares.max + entryShares.maxPlus;
    const entryMax = remainder > 0 ? remaining * (entryShares.max / remainder) : 0;
    const entryMaxPlus = remaining - entryMax;
    const upgraded = entryMax * upgradeShare;
    return { maxAccounts: entryMax - upgraded, maxPlusAccounts: entryMaxPlus + upgraded, factoryPlusAccounts };
  };
  const typedRevenue = (accounts: number, upgradeShare: number, ageMonths: number, peopleCount: number) => {
    const types = splitTypes(accounts, upgradeShare);
    return types.maxAccounts * packageRecognized(maxPackage, ageMonths, peopleCount)
      + types.maxPlusAccounts * packageRecognized(maxPlusPackage, ageMonths, peopleCount)
      + types.factoryPlusAccounts * packageRecognized(factoryPlusPackage, ageMonths, peopleCount);
  };
  const maxRecognizedMonthly = (ageMonths: number) => recognizedMonthly(maxPackage, ageMonths);
  const maxPlusRecognizedMonthly = (ageMonths: number) => recognizedMonthly(maxPlusPackage, ageMonths);
  const seatDeltaAt = (ageMonths: number) => Math.max(0, maxPlusRecognizedMonthly(ageMonths) - maxRecognizedMonthly(ageMonths));
  const departmentOpex = Object.fromEntries((budgetDepartments ?? []).map((department) => [department.id, departmentMonthlyTotal(department) / 100]));
  const canonicalBudgetOpex = budgetDepartments ? budgetMonthlyTotal(budgetDepartments) / 100 : null;
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const staffLoad = staffLoadFromAssumptions(assumptions);
  const derivedHires: DerivedHire[] = [];
  if (hiringSlots) {
    for (const slot of hiringSlots) {
      const role = roleById.get(slot.roleId);
      if (!role || slot.status !== "approved" || !slot.plannedStartMonth) continue;
      const baseMonthly = baseMonthlyForRole(role);
      const components = staffCostComponentsForBase(baseMonthly, 1, staffLoad);
      derivedHires.push({
        id: role.id,
        startMonth: monthOffset(assumptions.startCalendarMonth, slot.plannedStartMonth) + 1,
        baseMonthly,
        components,
        monthlyCost: totalStaffCostComponents(components),
        costAllocation: "opex",
        acquisitionAllocationPct: 0,
        headcount: 1,
      });
    }
  } else {
    for (const phase of assumptions.phases) for (const hire of phase.keyHires) {
      const role = roleById.get(hire.roleId); if (!role) continue;
      const headcount = Math.max(1, hire.headcount ?? 1);
      const baseMonthly = baseMonthlyForRole(role) * headcount;
      const components = staffCostComponentsForBase(baseMonthly, headcount, staffLoad);
      derivedHires.push({
        id: role.id,
        startMonth: hire.startMonth ?? phase.startMonth ?? 1,
        baseMonthly,
        components,
        monthlyCost: totalStaffCostComponents(components),
        costAllocation: hire.costAllocation ?? "opex",
        acquisitionAllocationPct: hire.acquisitionAllocationPct ?? 0,
        headcount,
      });
    }
  }
  const accountSurvivalMonthly = Math.pow(1 - assumptions.annualAccountChurnPct / 100, 1 / 12);
  const hoursUsedPerUser = assumptions.hoursUsedPerActiveUser;
  const internalMeetingShare = assumptions.internalMeetingSharePct / 100;
  const meetingExpansionPerUser = hoursUsedPerUser * assumptions.meetingsPerHour * internalMeetingShare * assumptions.expandedUsersPerInternalMeeting;
  const userExpansionMonthly = 1 + meetingExpansionPerUser;
  const userRetentionMonthly = Math.pow(1 - assumptions.annualExistingAccountUserContractionPct / 100, 1 / 12);
  const netUserMovementMonthly = userExpansionMonthly * userRetentionMonthly;
  const upgradeMonthly = 1 - Math.pow(1 - assumptions.annualAccountUpgradePct / 100, 1 / 12);
  const catalogPeoplePerAccount = catalogIncludedPeople(maxPackage) * entryShares.max
    + catalogIncludedPeople(maxPlusPackage) * entryShares.maxPlus
    + catalogIncludedPeople(factoryPlusPackage) * entryShares.factory;
  const representativeStartingUsers = Math.max(1, assumptions.startingAccounts > 0 ? assumptions.startingUsers / assumptions.startingAccounts : catalogPeoplePerAccount);
  const representativeStartingRevenue = typedRevenue(1, 0, 0, representativeStartingUsers);
  const representativeRetainedUsers = Math.max(1, representativeStartingUsers * Math.pow(userExpansionMonthly, 12) * (1 - assumptions.annualExistingAccountUserContractionPct / 100));
  const representativeRetainedRevenue = (1 - assumptions.annualAccountChurnPct / 100) * typedRevenue(1, assumptions.annualAccountUpgradePct / 100, 12, representativeRetainedUsers);
  const calculatedAnnualNrrPct = safeRatio(representativeRetainedRevenue, representativeStartingRevenue) * 100;
  const overageGrossMargin = overagePriceMultiple > 0 ? 1 - 1 / overagePriceMultiple : 0;
  const startingUsersPerAccount = assumptions.startingAccounts > 0 ? Math.max(1, assumptions.startingUsers / assumptions.startingAccounts) : catalogPeoplePerAccount;
  const entryRevenuePerAccount = typedRevenue(1, 0, 0, catalogPeoplePerAccount);
  const includedTokensPerAccount = maxPackage.includedTokensMillions * entryShares.max
    + maxPlusPackage.includedTokensMillions * entryShares.maxPlus
    + factoryPlusPackage.includedTokensMillions * entryShares.factory;
  const includedInferencePerAccount = includedTokensPerAccount * tokenCostPerMillion;
  const entrySupportHours = yearOneDeliveryHours("max", 0).activation * entryShares.max
    + yearOneDeliveryHours("max_plus", 0).activation * entryShares.maxPlus
    + yearOneDeliveryHours("factory_plus", 0).activation * entryShares.factory
    + yearOneDeliveryHours("max", 0).checkIns * entryShares.max
    + yearOneDeliveryHours("max_plus", 0).checkIns * entryShares.maxPlus
    + yearOneDeliveryHours("factory_plus", 0).checkIns * entryShares.factory;
  const entryVariableCogsPerAccount = includedInferencePerAccount
    + catalogPeoplePerAccount * assumptions.seatInferenceAndSupportCost
    + assumptions.infrastructurePerActiveAccount
    + entrySupportHours * SUPPORT_LOADED_HOURLY
    + entryRevenuePerAccount * assumptions.paymentProcessingPct / 100;
  const entryContributionGrossMargin = entryRevenuePerAccount > 0 ? 1 - entryVariableCogsPerAccount / entryRevenuePerAccount : 0;
  const blendedEntryCac = assumptions.plgSharePct / 100 * assumptions.plgCac + (1 - assumptions.plgSharePct / 100) * assumptions.topDownCac;
  const baselineCacPaybackMonths = entryRevenuePerAccount * entryContributionGrossMargin > 0 ? blendedEntryCac / (entryRevenuePerAccount * entryContributionGrossMargin) : 0;
  const cohorts: Cohort[] = assumptions.startingAccounts > 0 ? [{ birthMonth: 0, accounts: assumptions.startingAccounts, usersPerAccount: startingUsersPerAccount }] : [];
  const months: MonthRow[] = [];
  let endingCash = assumptions.openingCash;

  for (let month = 1; month <= assumptions.horizonMonths; month++) {
    let startUsers = 0;
    for (const cohort of cohorts) {
      const age = month - cohort.birthMonth;
      if (age <= 0) continue;
      const startOfMonthAge = age - 1;
      startUsers += cohort.accounts * Math.pow(accountSurvivalMonthly, startOfMonthAge) * cohort.usersPerAccount * Math.pow(netUserMovementMonthly, startOfMonthAge);
    }
    const seedAccounts = month <= 3 ? assumptions.quarterOneNewAccounts / 3 : 0;
    const seedUsers = seedAccounts * catalogPeoplePerAccount;
    const meetings = (startUsers + seedUsers) * hoursUsedPerUser * assumptions.meetingsPerHour;
    const internalMeetings = meetings * internalMeetingShare;
    const externalMeetings = meetings - internalMeetings;
    const newAccountsFromMeetings = externalMeetings * assumptions.newAccountsPerExternalMeeting;
    const expandedUsersFromMeetings = internalMeetings * assumptions.expandedUsersPerInternalMeeting;
    const newAccountsFromSales = seedAccounts;
    const newAccounts = newAccountsFromSales + newAccountsFromMeetings;
    cohorts.push({ birthMonth: month, accounts: newAccounts, usersPerAccount: catalogPeoplePerAccount });
    let activeAccounts = 0;
    let maxAccounts = 0;
    let maxPlusAccounts = 0;
    let factoryPlusAccounts = 0;
    let principals = 0;
    let participants = 0;
    let agents = 0;
    let hoursUsed = 0;
    let activationHours = 0;
    let checkInHours = 0;
    let tokensUsed = 0;
    let activeUsers = 0;
    let newUsers = 0;
    let expandedUsers = 0;
    let contractedUsers = 0;
    let startingCohortRevenue = 0;
    let churnedRevenue = 0;
    let userExpansionRevenue = 0;
    let userContractionRevenue = 0;
    let tierExpansionRevenue = 0;
    for (const cohort of cohorts) {
      const age = month - cohort.birthMonth;
      const startOfMonthAge = Math.max(0, age - 1);
      const startAccounts = cohort.accounts * Math.pow(accountSurvivalMonthly, startOfMonthAge);
      const survivingAccounts = cohort.accounts * Math.pow(accountSurvivalMonthly, age);
      const startUsersPerAccount = cohort.usersPerAccount * Math.pow(netUserMovementMonthly, startOfMonthAge);
      const expandedUsersPerAccount = startUsersPerAccount * userExpansionMonthly;
      const usersPerAccount = Math.max(1, expandedUsersPerAccount * userRetentionMonthly);
      const startUpgradeShare = 1 - Math.pow(1 - upgradeMonthly, startOfMonthAge);
      const upgradeShare = 1 - Math.pow(1 - upgradeMonthly, age);
      const startRevenue = typedRevenue(startAccounts, startUpgradeShare, startOfMonthAge, startUsersPerAccount);
      const retainedBaseRevenue = typedRevenue(survivingAccounts, startUpgradeShare, startOfMonthAge, startUsersPerAccount);
      const retainedExpandedRevenue = typedRevenue(survivingAccounts, startUpgradeShare, startOfMonthAge, expandedUsersPerAccount);
      const retainedUserRevenue = typedRevenue(survivingAccounts, startUpgradeShare, age, usersPerAccount);
      const retainedRevenue = typedRevenue(survivingAccounts, upgradeShare, age, usersPerAccount);
      const types = splitTypes(survivingAccounts, upgradeShare);
      const maxHours = yearOneDeliveryHours("max", age);
      const maxPlusHours = yearOneDeliveryHours("max_plus", age);
      const factoryHours = yearOneDeliveryHours("factory_plus", age);
      activeAccounts += survivingAccounts;
      maxAccounts += types.maxAccounts;
      maxPlusAccounts += types.maxPlusAccounts;
      factoryPlusAccounts += types.factoryPlusAccounts;
      principals += types.maxAccounts * maxPackage.includedPrincipals
        + types.maxPlusAccounts * maxPlusPackage.includedPrincipals
        + types.factoryPlusAccounts * factoryPlusPackage.includedPrincipals;
      participants += types.maxAccounts * catalogIncludedParticipants(maxPackage)
        + types.maxPlusAccounts * catalogIncludedParticipants(maxPlusPackage);
      agents += types.maxAccounts * maxPackage.includedAgents
        + types.maxPlusAccounts * maxPlusPackage.includedAgents
        + types.factoryPlusAccounts * factoryPlusPackage.includedAgents;
      hoursUsed += types.maxAccounts * PACKAGE_USAGE_HOURS.max
        + types.maxPlusAccounts * PACKAGE_USAGE_HOURS.max_plus
        + types.factoryPlusAccounts * PACKAGE_USAGE_HOURS.factory_plus;
      activationHours += types.maxAccounts * maxHours.activation
        + types.maxPlusAccounts * maxPlusHours.activation
        + types.factoryPlusAccounts * factoryHours.activation;
      checkInHours += types.maxAccounts * maxHours.checkIns
        + types.maxPlusAccounts * maxPlusHours.checkIns
        + types.factoryPlusAccounts * factoryHours.checkIns;
      tokensUsed += types.maxAccounts * maxPackage.includedTokensMillions * 1_000_000
        + types.maxPlusAccounts * maxPlusPackage.includedTokensMillions * 1_000_000
        + types.factoryPlusAccounts * factoryPlusPackage.includedTokensMillions * 1_000_000;
      activeUsers += types.maxAccounts * catalogIncludedPeople(maxPackage)
        + types.maxPlusAccounts * catalogIncludedPeople(maxPlusPackage)
        + types.factoryPlusAccounts * catalogIncludedPeople(factoryPlusPackage);
      if (age === 0) {
        newUsers += types.maxAccounts * catalogIncludedPeople(maxPackage)
          + types.maxPlusAccounts * catalogIncludedPeople(maxPlusPackage)
          + types.factoryPlusAccounts * catalogIncludedPeople(factoryPlusPackage);
      }
      if (age > 0) {
        expandedUsers += survivingAccounts * Math.max(0, expandedUsersPerAccount - startUsersPerAccount);
        contractedUsers += survivingAccounts * Math.max(0, expandedUsersPerAccount - usersPerAccount);
        startingCohortRevenue += startRevenue;
        churnedRevenue += Math.max(0, startRevenue - retainedBaseRevenue);
        userExpansionRevenue += Math.max(0, retainedExpandedRevenue - retainedBaseRevenue);
        userContractionRevenue += Math.max(0, retainedExpandedRevenue - retainedUserRevenue);
        tierExpansionRevenue += Math.max(0, retainedRevenue - retainedUserRevenue);
      }
    }
    const newAccountRevenue = newAccounts * entryRevenuePerAccount;
    const sameCohortRecurringRevenue = startingCohortRevenue - churnedRevenue + userExpansionRevenue - userContractionRevenue + tierExpansionRevenue;
    const cohortNrr = safeRatio(sameCohortRecurringRevenue, startingCohortRevenue);
    const subscriptionRevenue = Math.max(0, startingCohortRevenue - churnedRevenue) + newAccountRevenue;
    const seatExpansionRevenue = userExpansionRevenue - userContractionRevenue;
    const overageRevenue = 0;
    const productRevenue = subscriptionRevenue + seatExpansionRevenue + tierExpansionRevenue;
    const activeSeats = activeUsers;
    const existingAccountUsers = Math.max(0, activeUsers - newUsers);
    const churnedAccounts = cohorts.reduce((sum, cohort) => {
      const age = month - cohort.birthMonth;
      if (age <= 0) return sum;
      const before = cohort.accounts * Math.pow(accountSurvivalMonthly, age - 1);
      const after = cohort.accounts * Math.pow(accountSurvivalMonthly, age);
      return sum + Math.max(0, before - after);
    }, 0);
    const requiredTierUpgrades = seatDeltaAt(12) > 0
      ? tierExpansionRevenue / seatDeltaAt(12)
      : 0;
    const overageTokenCogs = overagePriceMultiple > 0 ? overageRevenue / overagePriceMultiple : 0;
    const requiredOverageTokensMillions = tokenCostPerMillion > 0 ? overageTokenCogs / tokenCostPerMillion : 0;
    const tokenCost = (tokensUsed / 1_000_000) * tokenCostPerMillion;
    const includedTokenCogs = tokenCost;
    const seatCogs = activeSeats * assumptions.seatInferenceAndSupportCost;
    const supportActivationCogs = activationHours * SUPPORT_LOADED_HOURLY;
    const supportCheckInCogs = checkInHours * SUPPORT_LOADED_HOURLY;
    const supportCogs = supportActivationCogs + supportCheckInCogs;
    const activeHires = derivedHires.filter((hire) => hire.startMonth <= month);
    const keyHireStaffOpex = activeHires.reduce((sum, hire) => hire.costAllocation === "product_cogs" ? sum : sum + hire.monthlyCost, 0);
    const keyHireAcquisitionSpend = activeHires.filter((hire) => hire.costAllocation === "acquisition_split").reduce((sum, hire) => sum + hire.monthlyCost * hire.acquisitionAllocationPct / 100, 0);
    const keyHireHeadcount = activeHires.reduce((sum, hire) => sum + hire.headcount, 0);
    const productCogs = includedTokenCogs + supportCogs;
    const lane = assumptions.monthlyCashLanes[month - 1];
    const totalCashRevenue = productRevenue;
    const acquisitionSpend = newAccounts * blendedEntryCac + keyHireAcquisitionSpend;
    const manualOpex = (category: OpexCategory) => assumptions.operatingCosts.filter((cost) => cost.classification === "opex" && (cost.opexCategory ?? "g_and_a") === category && activeCost(cost, month)).reduce((sum, cost) => sum + cost.monthlyAmount, 0);
    const staffByComponent: StaffCostComponents = { ...EMPTY_STAFF_COST_COMPONENTS };
    const staffByRole: Record<string, number> = {};
    for (const hire of activeHires) {
      if (hire.costAllocation === "product_cogs") continue;
      // Full hire cash stays in Staff opex; acquisition_split only affects CAC metrics.
      staffByComponent.salary += hire.components.salary;
      staffByComponent.match += hire.components.match;
      staffByComponent.hdv += hire.components.hdv;
      staffByComponent.taxes += hire.components.taxes;
      staffByRole[hire.id] = (staffByRole[hire.id] ?? 0) + hire.monthlyCost;
    }
    for (const cost of assumptions.operatingCosts) {
      if (cost.classification !== "opex" || (cost.opexCategory ?? "g_and_a") !== "staff" || !activeCost(cost, month)) continue;
      // Manual staff opex lines are treated as cash wages until they are migrated into hiring roles.
      const manualComponents = staffCostComponentsForBase(cost.monthlyAmount, Math.max(0, cost.headcount), staffLoad);
      staffByComponent.salary += manualComponents.salary;
      staffByComponent.match += manualComponents.match;
      staffByComponent.hdv += manualComponents.hdv;
      staffByComponent.taxes += manualComponents.taxes;
      staffByRole[cost.id] = (staffByRole[cost.id] ?? 0) + totalStaffCostComponents(manualComponents);
    }
    const staffOpex = totalStaffCostComponents(staffByComponent);
    const acquisitionOpex = 0;
    const budgetOpex = canonicalBudgetOpex ?? manualOpex("marketing") + manualOpex("g_and_a");
    const totalOpex = staffOpex + budgetOpex;
    const operatingExpense = totalOpex;
    const headcount = assumptions.operatingCosts.filter((cost) => activeCost(cost, month)).reduce((sum, cost) => sum + cost.headcount, 0) + keyHireHeadcount;
    const grossProfit = totalCashRevenue - productCogs;
    const operatingIncome = grossProfit - totalOpex;
    const netCashChange = totalCashRevenue - productCogs - operatingExpense - lane.capex;
    const financingCash = assumptions.financingEvents.filter((event) => event.month === month).reduce((sum, event) => sum + event.amount, 0);
    endingCash += netCashChange + financingCash;
    const burnWindow = [...months.slice(-(assumptions.trailingBurnMonths - 1)).map((row) => row.netCashChange), netCashChange];
    const trailingBurn = Math.max(0, -burnWindow.reduce((sum, value) => sum + value, 0) / burnWindow.length);
    const newPlgAccounts = newAccounts * assumptions.plgSharePct / 100;
    months.push({
      month, calendarMonth: calendarMonthAt(assumptions.startCalendarMonth, month), label: calendarMonthLabel(assumptions.startCalendarMonth, month), phaseKey: phaseForMonth(assumptions.phases, month).key, phaseLabel: PHASE_LABELS[phaseForMonth(assumptions.phases, month).key],
      newAccounts, newPlgAccounts, newTopDownAccounts: newAccounts - newPlgAccounts, churnedAccounts, activeAccounts,
      maxAccounts, maxPlusAccounts, factoryPlusAccounts,
      newUsers, expandedUsers, contractedUsers, existingAccountUsers, activeUsers,
      principals, participants, agents,
      meetings, internalMeetings, externalMeetings, newAccountsFromMeetings, newAccountsFromSales, expandedUsersFromMeetings,
      hoursUsed, activationHours, checkInHours, tokensUsed, tokenCost, startingCohortRevenue, churnedRevenue, userExpansionRevenue, userContractionRevenue, tierExpansionRevenue, sameCohortRecurringRevenue, cohortNrr,
      subscriptionRevenue, seatExpansionRevenue, overageRevenue, productRevenue, productArr: productRevenue * 12,
      activeSeats, requiredTierUpgrades, overageDominant: false,
      totalCashRevenue, includedTokenCogs, seatCogs, supportCogs, supportActivationCogs, supportCheckInCogs, overageTokenCogs, requiredOverageTokensMillions, totalTokenUsageMillions: tokensUsed / 1_000_000 + requiredOverageTokensMillions, overageGrossMargin,
      productCogs, productGrossMargin: safeRatio(productRevenue - productCogs, productRevenue),
      blendedCompanyGrossMargin: safeRatio(totalCashRevenue - productCogs, totalCashRevenue), acquisitionSpend, blendedCac: newAccounts > 0 ? acquisitionSpend / newAccounts : blendedEntryCac,
      cacPaybackMonths: baselineCacPaybackMonths, headcount, operatingExpense, capex: lane.capex, grossProfit, staffOpex, staffByComponent, staffByRole, acquisitionOpex, budgetOpex, departmentOpex, totalOpex, operatingIncome, netCashChange, financingCash, endingCash, trailingBurn, runwayMonths: trailingBurn > 0 ? Math.max(0, endingCash) / trailingBurn : Number.POSITIVE_INFINITY,
    });
  }

  const gates = assumptions.phases.map((phase) => {
    if (phase.key === "phase_0") return { phaseKey: phase.key, label: PHASE_LABELS[phase.key], targetMonth: 0, status: "achieved" as GateStatus, firstAchievedMonth: 0 };
    const achieved = months.find((row) => row.month >= phase.startMonth && row.productArr >= phase.productArrMin && (phase.productArrMax <= 0 || row.productArr <= phase.productArrMax) && calculatedAnnualNrrPct >= phase.annualNrrMinPct && 100 - assumptions.annualAccountChurnPct >= phase.annualGlrMinPct && (phase.accountExpansion90dMin <= 0 || assumptions.newAccountsPerExternalMeeting > 0) && (phase.cacPaybackMaxMonths <= 0 || row.cacPaybackMonths <= phase.cacPaybackMaxMonths) && row.productGrossMargin * 100 >= phase.productGrossMarginMinPct);
    const status: GateStatus = achieved ? "achieved" : assumptions.horizonMonths >= phase.endMonth ? "missed" : "not_yet_observable";
    return { phaseKey: phase.key, label: PHASE_LABELS[phase.key], targetMonth: phase.endMonth, status, firstAchievedMonth: achieved?.month ?? null };
  });

  const firstInvestorInvestment = assumptions.financingEvents[0].amount;
  let cumulativeInvestorOwnership = 0;
  let founderOwnershipRemaining = 1;
  const financing = assumptions.financingEvents.map((event) => {
    const postMoneyValuation = event.instrument === "post_money_safe" ? event.valuation : event.valuation + event.amount;
    const newInvestorOwnership = postMoneyValuation > 0 ? event.amount / postMoneyValuation : 0;
    const dilution = Math.max(0, 1 - newInvestorOwnership - event.optionPoolTopUpPct / 100);
    cumulativeInvestorOwnership = cumulativeInvestorOwnership * dilution + newInvestorOwnership;
    founderOwnershipRemaining *= dilution;
    const investorPaperValue = cumulativeInvestorOwnership * postMoneyValuation;
    return {
      key: event.key,
      label: FINANCING_LABELS[event.key],
      month: event.month,
      instrument: event.instrument,
      investment: event.amount,
      valuation: event.valuation,
      postMoneyValuation,
      newInvestorOwnership,
      cumulativeInvestorOwnership,
      founderOwnershipRemaining,
      investorPaperValue,
      investorReturnMultiple: firstInvestorInvestment > 0 ? investorPaperValue / firstInvestorInvestment : 0,
    };
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
    reserveAtGate: assumptions.reserveAtNextGate,
  };

  const scenarioId = "baseline";
  const metricValue = (row: MonthRow, key: keyof typeof FORECAST_METRIC_CATALOG): number => {
    switch (key) {
      case "payingAccounts": return row.activeAccounts;
      case "newAccounts": return row.newAccounts;
      case "churnedAccounts": return row.churnedAccounts;
      case "users": return row.activeUsers;
      case "newUsers": return row.newUsers;
      case "nrr": return row.cohortNrr * 100;
      case "revenue": return row.totalCashRevenue;
      case "cogs": return row.productCogs;
      case "grossProfit": return row.grossProfit;
      case "opex": return row.totalOpex;
      case "operatingIncome": return row.operatingIncome;
      case "netCashFlow": return row.netCashChange;
      case "cashBalance": return row.endingCash;
    }
  };
  const metricSeries: ProjectedMetricSeries[] = Object.entries(FORECAST_METRIC_CATALOG).map(([key, definition]) => ({
    metricSlug: definition.slug,
    name: definition.name,
    unit: definition.unit,
    observations: months.map((row) => ({
      metricSlug: definition.slug,
      value: metricValue(row, key as keyof typeof FORECAST_METRIC_CATALOG),
      unit: definition.unit,
      periodStart: `${row.calendarMonth}-01T00:00:00.000Z`,
      periodEnd: `${calendarMonthAt(row.calendarMonth, 2)}-01T00:00:00.000Z`,
      valueStatus: "projected" as const,
      scenarioId,
    })),
  }));

  return { assumptions, months, gates, financing, financingNeed, metricSeries, impliedRetainedAccountArpaExpansionPct: accountSurvivalMonthly > 0 ? calculatedAnnualNrrPct / (100 - assumptions.annualAccountChurnPct) * 100 : 0, entryContributionGrossMargin, baselineCacPaybackMonths };
}

/**
 * Roll monthly rows up into the requested period. Monthly is the source of
 * truth: flows are summed, balances (accounts, ending cash) are period-end,
 * and no ratio is averaged — margins are recomputed from summed numerators
 * and denominators by the consumer.
 */
interface CalendarPeriodDescriptor { key: string; label: string; }

function calendarPeriodForMonth(row: MonthRow, mode: PeriodMode): CalendarPeriodDescriptor {
  if (mode === "monthly") return { key: row.calendarMonth, label: row.label };
  const [year, month] = row.calendarMonth.split("-").map(Number);
  if (mode === "quarterly") {
    const quarter = Math.floor((month - 1) / 3) + 1;
    return { key: `${year}-Q${quarter}`, label: `Q${quarter} '${String(year).slice(-2)}` };
  }
  return { key: String(year), label: String(year) };
}

function firstReserveBreachMonth(projection: Projection): number | null {
  const gateMonth = projection.financingNeed.gateMonth;
  return projection.months.find((row) => row.month <= gateMonth && row.endingCash < projection.assumptions.reserveAtNextGate)?.month ?? null;
}

function nextFundraiseStartMonth(projection: Projection): number {
  const reserveBreachMonth = firstReserveBreachMonth(projection);
  const triggerMonth = reserveBreachMonth ?? projection.financingNeed.gateMonth;
  return Math.max(1, triggerMonth - projection.assumptions.fundraisingLeadMonths);
}

export function computePhaseOneFinancingScenario(input: Assumptions | unknown, roles: JobRole[], amount: number, budgetDepartments?: BudgetDepartment[], pricing?: BusinessPricing): PhaseOneFinancingScenario {
  const assumptions = normalizeAssumptions(input);
  const financingEvents = assumptions.financingEvents.map((event) => event.key === "pre_seed" ? { ...event, amount: nonNegative(amount, event.amount) } : event);
  const baseline = computeProjection({ ...assumptions, financingEvents }, roles, budgetDepartments, undefined, pricing);
  const viralHaircut = assumptions.accountExpansion90d > 0 ? assumptions.downsideAccountExpansion90d / assumptions.accountExpansion90d : 1;
  const downside = computeProjection({
    ...assumptions,
    financingEvents,
    newAccountsPerExternalMeeting: assumptions.newAccountsPerExternalMeeting * viralHaircut,
    expandedUsersPerInternalMeeting: assumptions.expandedUsersPerInternalMeeting * viralHaircut,
  }, roles, budgetDepartments, undefined, pricing);
  const gateIndex = Math.max(0, baseline.financingNeed.gateMonth - 1);
  const baselineCashAtGate = baseline.months[gateIndex]?.endingCash ?? assumptions.openingCash;
  const downsideCashAtGate = downside.months[gateIndex]?.endingCash ?? assumptions.openingCash;
  return {
    amount: nonNegative(amount, assumptions.financingEvents[0]?.amount ?? 0),
    baselineCashAtGate,
    downsideCashAtGate,
    baselineReserveGap: Math.max(0, assumptions.reserveAtNextGate - baselineCashAtGate),
    downsideReserveGap: Math.max(0, assumptions.reserveAtNextGate - downsideCashAtGate),
    baselineNextFundraiseStartMonth: nextFundraiseStartMonth(baseline),
    downsideNextFundraiseStartMonth: nextFundraiseStartMonth(downside),
  };
}

export function aggregateMonths(months: MonthRow[], mode: PeriodMode): PeriodRow[] {
  if (months.length === 0) return [];
  const groups: { period: CalendarPeriodDescriptor; months: MonthRow[] }[] = [];
  for (const month of months) {
    const period = calendarPeriodForMonth(month, mode);
    const current = groups[groups.length - 1];
    if (current?.period.key === period.key) current.months.push(month);
    else groups.push({ period, months: [month] });
  }

  return groups.map(({ period, months: slice }) => {
    const first = slice[0];
    const last = slice[slice.length - 1];
    const sum = (pick: (row: MonthRow) => number) => slice.reduce((acc, row) => acc + pick(row), 0);
    return {
      key: period.key,
      label: period.label,
      startMonth: first.month,
      endMonth: last.month,
      monthCount: slice.length,
      phaseKey: last.phaseKey,
      phaseLabel: last.phaseLabel,
      financingKey: PHASE_FINANCING[last.phaseKey],
      activeAccounts: last.activeAccounts,
      maxAccounts: last.maxAccounts,
      maxPlusAccounts: last.maxPlusAccounts,
      factoryPlusAccounts: last.factoryPlusAccounts,
      newAccounts: sum((row) => row.newAccounts),
      newAccountsFromMeetings: sum((row) => row.newAccountsFromMeetings),
      newAccountsFromSales: sum((row) => row.newAccountsFromSales),
      churnedAccounts: sum((row) => row.churnedAccounts),
      activeUsers: last.activeUsers,
      newUsers: sum((row) => row.newUsers),
      expandedUsers: sum((row) => row.expandedUsers),
      contractedUsers: sum((row) => row.contractedUsers),
      principals: last.principals,
      participants: last.participants,
      agents: last.agents,
      meetings: sum((row) => row.meetings),
      internalMeetings: sum((row) => row.internalMeetings),
      externalMeetings: sum((row) => row.externalMeetings),
      expandedUsersFromMeetings: sum((row) => row.expandedUsersFromMeetings),
      hoursUsed: sum((row) => row.hoursUsed),
      activationHours: sum((row) => row.activationHours),
      checkInHours: sum((row) => row.checkInHours),
      tokensUsed: sum((row) => row.tokensUsed),
      tokenCost: sum((row) => row.tokenCost),
      supportActivationCogs: sum((row) => row.supportActivationCogs),
      supportCheckInCogs: sum((row) => row.supportCheckInCogs),
      startingCohortRevenue: sum((row) => row.startingCohortRevenue),
      churnedRevenue: sum((row) => row.churnedRevenue),
      userExpansionRevenue: sum((row) => row.userExpansionRevenue),
      userContractionRevenue: sum((row) => row.userContractionRevenue),
      tierExpansionRevenue: sum((row) => row.tierExpansionRevenue),
      cohortNrr: safeRatio(sum((row) => row.sameCohortRecurringRevenue), sum((row) => row.startingCohortRevenue)),
      totalCashRevenue: sum((row) => row.totalCashRevenue),
      productRevenue: sum((row) => row.productRevenue),
      productCogs: sum((row) => row.productCogs),
      supportCogs: sum((row) => row.supportCogs),
      cogs: sum((row) => row.productCogs),
      mrr: last.productRevenue,
      arr: last.productArr,
      grossProfit: sum((row) => row.grossProfit),
      staffOpex: sum((row) => row.staffOpex),
      staffByComponent: {
        salary: sum((row) => row.staffByComponent.salary),
        match: sum((row) => row.staffByComponent.match),
        hdv: sum((row) => row.staffByComponent.hdv),
        taxes: sum((row) => row.staffByComponent.taxes),
      },
      staffByRole: Object.fromEntries([...new Set(slice.flatMap((row) => Object.keys(row.staffByRole)))].map((roleId) => [
        roleId,
        sum((row) => row.staffByRole[roleId] ?? 0),
      ])),
      acquisitionOpex: sum((row) => row.acquisitionOpex),
      budgetOpex: sum((row) => row.budgetOpex),
      departmentOpex: Object.fromEntries(Object.keys(last.departmentOpex).map((departmentId) => [
        departmentId,
        sum((row) => row.departmentOpex[departmentId] ?? 0),
      ])),
      totalOpex: sum((row) => row.totalOpex),
      operatingIncome: sum((row) => row.operatingIncome),
      acquisitionSpend: sum((row) => row.acquisitionSpend),
      netCashChange: sum((row) => row.netCashChange),
      financingCash: sum((row) => row.financingCash),
      endingCash: last.endingCash,
      runwayMonths: last.runwayMonths,
    };
  });
}
