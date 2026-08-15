import { pgTable, text, integer, real, boolean, timestamp, jsonb, index, uniqueIndex, doublePrecision } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod";

// ── Enums ──────────────────────────────────────────────────────────

export const METRIC_STATUSES = ["draft", "active", "archived"] as const;
export type MetricStatus = (typeof METRIC_STATUSES)[number];

export const KPI_STATUSES = ["draft", "active", "archived"] as const;
export type KpiStatus = (typeof KPI_STATUSES)[number];

export const METRIC_DIRECTIONS = ["higher_is_better", "lower_is_better", "target_band"] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

export const METRIC_SAMPLE_PERIODS = ["point", "daily", "weekly", "monthly", "custom"] as const;
export type MetricSamplePeriod = (typeof METRIC_SAMPLE_PERIODS)[number];

export const METRIC_ADAPTER_KINDS = ["manual", "internal", "expression"] as const;
export type MetricAdapterKind = (typeof METRIC_ADAPTER_KINDS)[number];

export const KPI_SCORE_BANDS = ["bull", "on_track", "bear", "critical", "unmeasured", "stale", "unavailable"] as const;
export type KpiScoreBand = (typeof KPI_SCORE_BANDS)[number];

/** Standing operating objective keys on the Advantage dashboard. */
export const STANDING_OBJECTIVE_KEYS = [
  "trust-security",
  "reliability-performance",
  "customer-health",
  "revenue-runway",
  "delivery-economics",
  "product-release",
  "founder-team",
  "corporate-stewardship",
] as const;
export type StandingObjectiveKey = (typeof STANDING_OBJECTIVE_KEYS)[number];

// ── Account DB: Metric definitions ─────────────────────────────────

export const metrics = pgTable(
  "metrics",
  {
    id: text("id").primaryKey(),
    /** Legacy Business compatibility projection; Core ownership is ownerKind/ownerId. */
    businessId: text("business_id"),
    ownerKind: text("owner_kind").notNull().default("account"),
    ownerId: text("owner_id"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    unit: text("unit").notNull().default(""),
    direction: text("direction").notNull().default("higher_is_better"),
    samplePeriod: text("sample_period").notNull().default("point"),
    adapterKind: text("adapter_kind").notNull().default("manual"),
    /** Adapter config: internal key, expression AST, or empty for manual. */
    adapterConfig: jsonb("adapter_config").notNull().default({}),
    status: text("status").notNull().default("active"),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    vaultId: text("vault_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (t) => ({
    businessSlug: uniqueIndex("metrics_business_slug_uidx").on(t.businessId, t.slug),
    accountVaultSlug: uniqueIndex("metrics_account_vault_slug_uidx").on(t.accountId, t.vaultId, t.slug),
    accountVault: index("metrics_account_vault_idx").on(t.accountId, t.vaultId),
    scopeOwner: index("metrics_scope_owner_idx").on(t.scope, t.ownerUserId),
    owner: index("metrics_owner_idx").on(t.ownerKind, t.ownerId),
  }),
);

export type MetricRow = typeof metrics.$inferSelect;

// ── Account DB: KPI definitions ────────────────────────────────────
// KPI = Metric + qualitative scoring (bear/bull bands) + enriching fields.
// Exactly one KPI may bind to a given standing operating objective per vault.

export const kpis = pgTable(
  "kpis",
  {
    id: text("id").primaryKey(),
    metricId: text("metric_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    /** Human-readable target statement shown on cards. */
    targetLabel: text("target_label").notNull().default(""),
    /** Cadence label (e.g. Weekly, Monthly). */
    cadence: text("cadence").notNull().default("Weekly"),
    ownerLabel: text("owner_label").notNull().default(""),
    /** When true, higher values are better for band comparison. */
    direction: text("direction").notNull().default("higher_is_better"),
    /** Bull threshold — at/beyond this is bull (excellent). */
    bullThreshold: doublePrecision("bull_threshold"),
    /** On-track threshold — at/beyond this is on_track (good). */
    onTrackThreshold: doublePrecision("on_track_threshold"),
    /** Bear threshold — at/beyond this is bear (warning); below is critical. */
    bearThreshold: doublePrecision("bear_threshold"),
    /** Max age in hours before a measured value is treated as stale. */
    staleAfterHours: integer("stale_after_hours").notNull().default(168),
    /** Optional standing operating objective key this KPI owns (1:1 per vault). */
    standingObjectiveKey: text("standing_objective_key"),
    status: text("status").notNull().default("active"),
    scope: text("scope").notNull().default("user"),
    ownerUserId: text("owner_user_id"),
    accountId: text("account_id"),
    vaultId: text("vault_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (t) => ({
    accountVaultSlug: uniqueIndex("kpis_account_vault_slug_uidx").on(t.accountId, t.vaultId, t.slug),
    accountVault: index("kpis_account_vault_idx").on(t.accountId, t.vaultId),
    metric: index("kpis_metric_idx").on(t.metricId),
    standingObj: uniqueIndex("kpis_vault_standing_objective_uidx").on(t.vaultId, t.standingObjectiveKey),
    scopeOwner: index("kpis_scope_owner_idx").on(t.scope, t.ownerUserId),
  }),
);

export type KpiRow = typeof kpis.$inferSelect;

// ── Metrics DB: high-volume samples ────────────────────────────────
// Lives on METRICS_DATABASE_URL when set; falls back to primary pool in dev.

export const metricSamples = pgTable(
  "metric_samples",
  {
    id: text("id").primaryKey(),
    metricId: text("metric_id").notNull(),
    accountId: text("account_id").notNull(),
    vaultId: text("vault_id"),
    value: doublePrecision("value").notNull(),
    unit: text("unit").notNull().default(""),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    sourceRef: text("source_ref").notNull().default("manual"),
    evidence: text("evidence"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).default(sql`CURRENT_TIMESTAMP`).notNull(),
  },
  (t) => ({
    metricTime: index("metric_samples_metric_observed_idx").on(t.metricId, t.observedAt),
    accountMetric: index("metric_samples_account_metric_idx").on(t.accountId, t.metricId),
  }),
);

export type MetricSampleRow = typeof metricSamples.$inferSelect;

// ── Zod contracts ──────────────────────────────────────────────────

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase kebab-case");

const nameSchema = z.string().trim().min(1).max(160);

export const metricCreateSchema = z.object({
  ownerKind: z.string().trim().min(1).max(80).optional().default("account"),
  ownerId: z.string().trim().min(1).optional(),
  businessId: z.string().trim().min(1).optional(),
  name: nameSchema,
  slug: slugSchema.optional(),
  description: z.string().max(4000).optional().default(""),
  unit: z.string().trim().max(40).optional().default(""),
  direction: z.enum(METRIC_DIRECTIONS).optional().default("higher_is_better"),
  samplePeriod: z.enum(METRIC_SAMPLE_PERIODS).optional().default("point"),
  adapterKind: z.enum(METRIC_ADAPTER_KINDS).optional().default("manual"),
  adapterConfig: z.record(z.unknown()).optional().default({}),
  status: z.enum(METRIC_STATUSES).optional().default("active"),
});

export const metricUpdateSchema = z.object({
  ownerKind: z.string().trim().min(1).max(80).optional(),
  ownerId: z.string().trim().min(1).optional(),
  businessId: z.string().trim().min(1).optional(),
  name: nameSchema.optional(),
  description: z.string().max(4000).optional(),
  unit: z.string().trim().max(40).optional(),
  direction: z.enum(METRIC_DIRECTIONS).optional(),
  samplePeriod: z.enum(METRIC_SAMPLE_PERIODS).optional(),
  adapterKind: z.enum(METRIC_ADAPTER_KINDS).optional(),
  adapterConfig: z.record(z.unknown()).optional(),
  status: z.enum(METRIC_STATUSES).optional(),
  clearFields: z.array(z.enum(["description"])).optional(),
});

export const kpiCreateSchema = z.object({
  metricId: z.string().trim().min(1),
  name: nameSchema,
  slug: slugSchema.optional(),
  description: z.string().max(4000).optional().default(""),
  targetLabel: z.string().trim().max(240).optional().default(""),
  cadence: z.string().trim().max(40).optional().default("Weekly"),
  ownerLabel: z.string().trim().max(80).optional().default(""),
  direction: z.enum(METRIC_DIRECTIONS).optional().default("higher_is_better"),
  bullThreshold: z.number().finite().optional().nullable(),
  onTrackThreshold: z.number().finite().optional().nullable(),
  bearThreshold: z.number().finite().optional().nullable(),
  staleAfterHours: z.number().int().positive().max(24 * 365).optional().default(168),
  standingObjectiveKey: z.enum(STANDING_OBJECTIVE_KEYS).optional().nullable(),
  status: z.enum(KPI_STATUSES).optional().default("active"),
});

export const kpiUpdateSchema = z.object({
  metricId: z.string().trim().min(1).optional(),
  name: nameSchema.optional(),
  description: z.string().max(4000).optional(),
  targetLabel: z.string().trim().max(240).optional(),
  cadence: z.string().trim().max(40).optional(),
  ownerLabel: z.string().trim().max(80).optional(),
  direction: z.enum(METRIC_DIRECTIONS).optional(),
  bullThreshold: z.number().finite().optional().nullable(),
  onTrackThreshold: z.number().finite().optional().nullable(),
  bearThreshold: z.number().finite().optional().nullable(),
  staleAfterHours: z.number().int().positive().max(24 * 365).optional(),
  standingObjectiveKey: z.enum(STANDING_OBJECTIVE_KEYS).optional().nullable(),
  status: z.enum(KPI_STATUSES).optional(),
  clearFields: z
    .array(
      z.enum([
        "description",
        "targetLabel",
        "standingObjectiveKey",
        "bullThreshold",
        "onTrackThreshold",
        "bearThreshold",
      ]),
    )
    .optional(),
});

export const metricSampleCreateSchema = z.object({
  metricId: z.string().trim().min(1),
  value: z.number().finite(),
  unit: z.string().trim().max(40).optional(),
  observedAt: z.string().datetime({ offset: true }).optional(),
  sourceRef: z.string().trim().max(240).optional().default("manual"),
  evidence: z.string().max(4000).optional().nullable(),
  periodStart: z.string().datetime({ offset: true }).optional().nullable(),
  periodEnd: z.string().datetime({ offset: true }).optional().nullable(),
});

export type MetricCreate = z.infer<typeof metricCreateSchema>;
export type MetricUpdate = z.infer<typeof metricUpdateSchema>;
export type KpiCreate = z.infer<typeof kpiCreateSchema>;
export type KpiUpdate = z.infer<typeof kpiUpdateSchema>;
export type MetricSampleCreate = z.infer<typeof metricSampleCreateSchema>;

// ── API shapes ─────────────────────────────────────────────────────

export interface Metric {
  id: string;
  ownerKind: string;
  ownerId: string | null;
  businessId: string | null;
  name: string;
  slug: string;
  description: string;
  unit: string;
  direction: MetricDirection;
  samplePeriod: MetricSamplePeriod;
  adapterKind: MetricAdapterKind;
  adapterConfig: Record<string, unknown>;
  status: MetricStatus;
  scope: string;
  ownerUserId: string | null;
  accountId: string | null;
  vaultId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  latestSample?: MetricSample | null;
}

export interface Kpi {
  id: string;
  metricId: string;
  name: string;
  slug: string;
  description: string;
  targetLabel: string;
  cadence: string;
  ownerLabel: string;
  direction: MetricDirection;
  bullThreshold: number | null;
  onTrackThreshold: number | null;
  bearThreshold: number | null;
  staleAfterHours: number;
  standingObjectiveKey: StandingObjectiveKey | null;
  status: KpiStatus;
  scope: string;
  ownerUserId: string | null;
  accountId: string | null;
  vaultId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  metric?: Metric | null;
  score?: KpiScore;
}

export interface MetricSample {
  id: string;
  metricId: string;
  accountId: string;
  vaultId: string | null;
  value: number;
  unit: string;
  observedAt: string;
  sourceRef: string;
  evidence: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
}

export type MetricValueStatus = "actual" | "estimated" | "projected";

export type MetricCoverage =
  | { status: "finalized" }
  | { status: "provisional"; finalizesAt: string }
  | { status: "partial"; availableFrom: string | null; reason: string };

/** One canonical read shape regardless of whether a Metric is materialized or
 * resolved from an owning domain at query time. */
export interface MetricSeries {
  metric: Metric;
  samples: MetricSample[];
  valueStatus: MetricValueStatus;
  coverage: MetricCoverage;
}

export interface MetricCollection {
  start: string;
  end: string;
  series: MetricSeries[];
}

/** Stable semantic identities shared by Forecast and every downstream Metric
 * consumer. Scenario math may vary; these business quantities do not. */
export const FORECAST_METRIC_CATALOG = {
  payingAccounts: { slug: "paying-accounts", name: "Paying Accounts", unit: "accounts" },
  newAccounts: { slug: "new-accounts", name: "New Accounts", unit: "accounts" },
  churnedAccounts: { slug: "churned-accounts", name: "Churned Accounts", unit: "accounts" },
  users: { slug: "users", name: "Users", unit: "users" },
  newUsers: { slug: "new-users", name: "New Users", unit: "users" },
  nrr: { slug: "net-revenue-retention", name: "Net Revenue Retention", unit: "%" },
  revenue: { slug: "revenue", name: "Revenue", unit: "USD" },
  cogs: { slug: "cogs", name: "COGS", unit: "USD" },
  grossProfit: { slug: "gross-profit", name: "Gross Profit", unit: "USD" },
  opex: { slug: "operating-expense", name: "Operating Expense", unit: "USD" },
  operatingIncome: { slug: "operating-income", name: "Operating Income", unit: "USD" },
  netCashFlow: { slug: "net-cash-flow", name: "Net Cash Flow", unit: "USD" },
  cashBalance: { slug: "cash-balance", name: "Cash Balance", unit: "USD" },
} as const;

export interface ProjectedMetricObservation {
  metricSlug: string;
  value: number;
  unit: string;
  periodStart: string;
  periodEnd: string;
  valueStatus: "projected";
  scenarioId: string;
}

export interface ProjectedMetricSeries {
  metricSlug: string;
  name: string;
  unit: string;
  observations: ProjectedMetricObservation[];
}

export interface KpiScore {
  band: KpiScoreBand;
  value: number | null;
  unit: string;
  observedAt: string | null;
  sourceRef: string | null;
  evidence: string | null;
  label: string;
}

export function slugifyMetricName(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "metric";
}

/**
 * Score a KPI from its latest sample and band thresholds.
 * Direction higher_is_better: value >= bull → bull; >= onTrack → on_track; >= bear → bear; else critical.
 * Direction lower_is_better: inverted comparisons.
 * Missing sample → unmeasured. Past staleAfterHours → stale.
 */
export function scoreKpi(input: {
  direction: MetricDirection;
  bullThreshold: number | null;
  onTrackThreshold: number | null;
  bearThreshold: number | null;
  staleAfterHours: number;
  sample: MetricSample | null | undefined;
  now?: Date;
}): KpiScore {
  const now = input.now ?? new Date();
  if (!input.sample) {
    return {
      band: "unmeasured",
      value: null,
      unit: "",
      observedAt: null,
      sourceRef: null,
      evidence: null,
      label: "Unmeasured",
    };
  }

  const observedAt = new Date(input.sample.observedAt);
  const ageHours = (now.getTime() - observedAt.getTime()) / (1000 * 60 * 60);
  if (Number.isFinite(ageHours) && ageHours > input.staleAfterHours) {
    return {
      band: "stale",
      value: input.sample.value,
      unit: input.sample.unit,
      observedAt: input.sample.observedAt,
      sourceRef: input.sample.sourceRef,
      evidence: input.sample.evidence,
      label: "Stale",
    };
  }

  const value = input.sample.value;
  const band = classifyBand(value, input.direction, input.bullThreshold, input.onTrackThreshold, input.bearThreshold);

  return {
    band,
    value,
    unit: input.sample.unit,
    observedAt: input.sample.observedAt,
    sourceRef: input.sample.sourceRef,
    evidence: input.sample.evidence,
    label: bandLabel(band),
  };
}

function classifyBand(
  value: number,
  direction: MetricDirection,
  bull: number | null,
  onTrack: number | null,
  bear: number | null,
): KpiScoreBand {
  if (bull == null && onTrack == null && bear == null) {
    return "on_track";
  }

  if (direction === "lower_is_better") {
    if (bull != null && value <= bull) return "bull";
    if (onTrack != null && value <= onTrack) return "on_track";
    if (bear != null && value <= bear) return "bear";
    if (bear != null && value > bear) return "critical";
    if (onTrack != null && value > onTrack) return "bear";
    return "on_track";
  }

  // higher_is_better and target_band (treat target_band like higher for MVP)
  if (bull != null && value >= bull) return "bull";
  if (onTrack != null && value >= onTrack) return "on_track";
  if (bear != null && value >= bear) return "bear";
  if (bear != null && value < bear) return "critical";
  if (onTrack != null && value < onTrack) return "bear";
  return "on_track";
}

function bandLabel(band: KpiScoreBand): string {
  switch (band) {
    case "bull":
      return "Bull";
    case "on_track":
      return "On track";
    case "bear":
      return "Bear";
    case "critical":
      return "Critical";
    case "stale":
      return "Stale";
    case "unavailable":
      return "Unavailable";
    case "unmeasured":
    default:
      return "Unmeasured";
  }
}

/** Map a KPI score onto the Advantage ScorecardMeasureState shape. */
export function kpiScoreToMeasureState(
  score: KpiScore,
  instrumentationOwner: string,
):
  | { kind: "measured"; value: number; unit: string; observedAt: string; sourceRef: string; evidence?: string }
  | { kind: "unmeasured"; instrumentationOwner: string; evidence?: string }
  | { kind: "stale"; value: number; unit: string; observedAt: string; sourceRef: string; instrumentationOwner: string; evidence?: string }
  | { kind: "unavailable"; instrumentationOwner: string; evidence?: string } {
  switch (score.band) {
    case "stale":
      return {
        kind: "stale",
        value: score.value ?? 0,
        unit: score.unit,
        observedAt: score.observedAt ?? new Date(0).toISOString(),
        sourceRef: score.sourceRef ?? "kpi",
        instrumentationOwner,
        evidence: score.evidence ?? undefined,
      };
    case "unmeasured":
      return {
        kind: "unmeasured",
        instrumentationOwner,
        evidence: score.evidence ?? undefined,
      };
    case "unavailable":
      return {
        kind: "unavailable",
        instrumentationOwner,
        evidence: score.evidence ?? undefined,
      };
    default:
      if (score.value == null || !score.observedAt) {
        return { kind: "unmeasured", instrumentationOwner };
      }
      return {
        kind: "measured",
        value: score.value,
        unit: score.unit,
        observedAt: score.observedAt,
        sourceRef: score.sourceRef ?? "kpi",
        evidence: score.evidence ?? score.label,
      };
  }
}
