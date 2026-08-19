import { createHash, randomBytes } from "crypto";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { businesses, metrics, kpis, metricSamples } from "@shared/schema";
import {
  kpiCreateSchema,
  kpiUpdateSchema,
  metricCreateSchema,
  metricSampleCreateSchema,
  metricUpdateSchema,
  scoreKpi,
  slugifyMetricName,
  type Kpi,
  type KpiCreate,
  type KpiScore,
  type KpiUpdate,
  type Metric,
  type MetricCreate,
  type MetricDirection,
  type MetricSample,
  type MetricSampleCreate,
  type MetricCollection,
  type MetricCoverage,
  type MetricSeries,
  type MetricUpdate,
  type StandingObjectiveKey,
} from "@shared/models/metrics";
import {
  cadenceFromPeriod,
  compileKpiSample,
  KPI_DEFAULT_TIMEZONE,
  normalizeKpiPeriod,
  normalizeKpiSamples,
  normalizeKpiStyle,
  sampleBelongsToLatestBucket,
  type KpiPeriod,
  type KpiStyle,
} from "@shared/kpi-sample";
import { USAGE_LEASE_TAIL_MS, type UsageRangeSample } from "./hours-used";
import type { WorkRangeSample } from "./work-metrics";
import type { IdentityRangeSample } from "./identity-metrics";
import { db } from "./db";
import { metricsDb, ensureMetricsSamplesSchema } from "./metrics-db";
import {
  assertVisible,
  assertWritable,
  combineWithVisibleScope,
  combineWithWritableScope,
  ownedInsertValues,
  type ScopeColumns,
} from "./scoped-storage";
import { getCurrentPrincipal } from "./principal-context";
import { eventBus } from "./event-bus";
import { visibleBusinessPredicate, writableBusinessPredicate } from "./business-vault-access";
import {
  canReadPlatformMetrics,
  canReadSystemMetrics,
  isPlatformMetric,
  isSystemMetric,
  metricIsVisibleTo,
  PRODUCT_METRIC_SLUGS,
} from "./metrics/metric-adapters";
import {
  compileMetricExpression,
  identityStockCanAnswerRange,
} from "./metrics/expression-plan";

const metricScope: ScopeColumns = {
  scope: metrics.scope,
  ownerUserId: metrics.ownerUserId,
  accountId: metrics.accountId,
  vaultId: metrics.vaultId,
};

const kpiScope: ScopeColumns = {
  scope: kpis.scope,
  ownerUserId: kpis.ownerUserId,
  accountId: kpis.accountId,
  vaultId: kpis.vaultId,
};

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function currentPrincipal() {
  const principal = getCurrentPrincipal();
  if (!principal?.userId || !principal.accountId) {
    throw Object.assign(new Error("Authentication required"), { status: 401 });
  }
  return principal;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function mapMetric(row: typeof metrics.$inferSelect, latestSample?: MetricSample | null): Metric {
  return {
    id: row.id,
    ownerKind: row.ownerKind ?? "account",
    ownerId: row.ownerId ?? null,
    businessId: row.businessId ?? null,
    name: row.name,
    slug: row.slug,
    description: row.description ?? "",
    unit: row.unit ?? "",
    direction: (row.direction as Metric["direction"]) ?? "higher_is_better",
    samplePeriod: (row.samplePeriod as Metric["samplePeriod"]) ?? "point",
    adapterKind: (row.adapterKind as Metric["adapterKind"]) ?? "manual",
    adapterConfig: (row.adapterConfig as Record<string, unknown>) ?? {},
    status: (row.status as Metric["status"]) ?? "active",
    scope: row.scope,
    ownerUserId: row.ownerUserId ?? null,
    accountId: row.accountId ?? null,
    vaultId: row.vaultId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
    latestSample: latestSample ?? null,
  };
}

function mapSample(row: typeof metricSamples.$inferSelect): MetricSample {
  return {
    id: row.id,
    metricId: row.metricId,
    accountId: row.accountId,
    vaultId: row.vaultId ?? null,
    value: row.value,
    unit: row.unit ?? "",
    observedAt: toIso(row.observedAt) ?? new Date(0).toISOString(),
    sourceRef: row.sourceRef ?? "manual",
    evidence: row.evidence ?? null,
    periodStart: toIso(row.periodStart),
    periodEnd: toIso(row.periodEnd),
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
  };
}

const CURRENT_METRIC_DEFINITIONS = [
  { key: "hoursUsed", slug: "hours-used", name: "Hours Used", unit: "hours" },
  { key: "activeUsers", slug: "active-users", name: "Active Users", unit: "users" },
  { key: "currentUsers", slug: "current-users", name: "Current Users", unit: "users" },
  { key: "shippedPrs", slug: "shipped-prs", name: "Shipped PRs", unit: "" },
  { key: "meetings", slug: "meetings", name: "Meetings", unit: "" },
  { key: "newUsers", slug: "new-users", name: "New Users", unit: "users" },
  { key: "accounts", slug: "accounts", name: "Accounts", unit: "accounts" },
  { key: "registeredUsers", slug: "registered-users", name: "Users", unit: "users" },
] as const;

const IDENTITY_STOCK_SLUGS = new Set<string>(["accounts", "registered-users"]);

function isProductCurrentSlug(slug: string): boolean {
  return PRODUCT_METRIC_SLUGS.has(slug);
}

function equationFromConfig(config: Record<string, unknown> | undefined): string {
  const raw = config?.equation;
  return typeof raw === "string" ? raw : "";
}

function composedOwnerKind(operands: Metric[]): "platform" | "performance" | undefined {
  if (operands.some((operand) => isPlatformMetric(operand))) return "platform";
  if (operands.some((operand) => isSystemMetric(operand))) return "performance";
  return undefined;
}

async function loadVisibleOperand(id: string): Promise<Metric | null> {
  try {
    return await metricsStorage.get(id);
  } catch (error) {
    if ((error as { status?: number })?.status === 404) return null;
    throw error;
  }
}

async function compilePersistedExpression(input: {
  adapterKind?: Metric["adapterKind"];
  adapterConfig?: Record<string, unknown>;
  existing?: Metric;
  selfId?: string;
}): Promise<{
  adapterKind: Metric["adapterKind"];
  adapterConfig: Record<string, unknown>;
  ownerKind?: "platform" | "performance";
  didCompile: boolean;
}> {
  const adapterKind = input.adapterKind ?? input.existing?.adapterKind ?? "manual";
  const adapterConfig = input.adapterConfig ?? input.existing?.adapterConfig ?? {};
  if (adapterKind !== "expression") {
    return { adapterKind, adapterConfig, didCompile: false };
  }
  const compiled = await compileMetricExpression({
    equation: equationFromConfig(adapterConfig),
    selfId: input.selfId,
    loadVisibleMetric: loadVisibleOperand,
  });
  return {
    adapterKind: "expression",
    adapterConfig: {
      adapterKey: "expression",
      equation: compiled.equation,
      plan: compiled.plan,
      operandIds: compiled.operandIds,
    },
    ownerKind: composedOwnerKind(compiled.operands),
    didCompile: true,
  };
}

function virtualCurrentMetric(
  businessId: string,
  definition: (typeof CURRENT_METRIC_DEFINITIONS)[number],
  sample: MetricSample,
): Metric {
  const now = new Date().toISOString();
  const product = isProductCurrentSlug(definition.slug);
  return {
    id: `metric_current_${businessId}_${definition.slug.replace(/-/g, "_")}`,
    ownerKind: product ? "platform" : "account",
    ownerId: product ? null : sample.accountId,
    businessId,
    name: definition.name,
    slug: definition.slug,
    description: product
      ? "Platform product quantity resolved from its owning system."
      : "Principal-scoped quantity resolved from its owning system.",
    unit: definition.unit,
    direction: "higher_is_better",
    samplePeriod: "custom",
    adapterKind: "internal",
    adapterConfig: product
      ? { key: definition.slug, mode: "query", adapterKey: "product" }
      : { key: definition.slug, mode: "query", adapterKey: "meetings" },
    status: "active",
    scope: "user",
    ownerUserId: null,
    accountId: sample.accountId,
    vaultId: sample.vaultId,
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
    latestSample: sample,
  };
}

function kpiQuestion(row: typeof kpis.$inferSelect): {
  period: KpiPeriod;
  samples: number;
  style: KpiStyle;
  cadence: string;
} {
  const period = normalizeKpiPeriod(
    (row as { period?: string | null }).period,
    row.cadence,
  );
  const rawSamples = (row as { samples?: number | null }).samples;
  const samples = period === "live" ? 1 : normalizeKpiSamples(period, rawSamples ?? 1);
  const style = normalizeKpiStyle((row as { style?: string | null }).style);
  return { period, samples, style, cadence: cadenceFromPeriod(period) };
}

function unavailableScore(reason: string): KpiScore {
  return {
    band: "unavailable",
    value: null,
    unit: "",
    observedAt: null,
    sourceRef: null,
    evidence: reason,
    label: "Unavailable",
  };
}

function mapKpi(
  row: typeof kpis.$inferSelect,
  opts?: {
    metric?: Metric | null;
    score?: KpiScore;
    coverage?: MetricCoverage;
    series?: MetricSample[];
    rangeStart?: string;
    rangeEnd?: string;
  },
): Kpi {
  const direction = (row.direction as MetricDirection) ?? "higher_is_better";
  const question = kpiQuestion(row);

  return {
    id: row.id,
    metricId: row.metricId,
    name: row.name,
    slug: row.slug,
    description: row.description ?? "",
    targetLabel: row.targetLabel ?? "",
    cadence: question.cadence,
    period: question.period,
    samples: question.samples,
    style: question.style,
    ownerLabel: row.ownerLabel ?? "",
    direction,
    bullThreshold: row.bullThreshold ?? null,
    onTrackThreshold: row.onTrackThreshold ?? null,
    bearThreshold: row.bearThreshold ?? null,
    staleAfterHours: row.staleAfterHours ?? 168,
    standingObjectiveKey: (row.standingObjectiveKey as StandingObjectiveKey | null) ?? null,
    status: (row.status as Kpi["status"]) ?? "active",
    scope: row.scope,
    ownerUserId: row.ownerUserId ?? null,
    accountId: row.accountId ?? null,
    vaultId: row.vaultId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updatedAt) ?? new Date(0).toISOString(),
    metric: opts?.metric ?? null,
    score: opts?.score,
    coverage: opts?.coverage,
    series: opts?.series,
    rangeStart: opts?.rangeStart,
    rangeEnd: opts?.rangeEnd,
  };
}

async function evaluateKpi(
  row: typeof kpis.$inferSelect,
  metric?: Metric | null,
): Promise<{
  metric: Metric | null;
  score: KpiScore;
  coverage?: MetricCoverage;
  series: MetricSample[];
  rangeStart: string;
  rangeEnd: string;
}> {
  const question = kpiQuestion(row);
  const compiled = compileKpiSample(question.period, question.samples, new Date(), KPI_DEFAULT_TIMEZONE);
  const rangeStart = compiled.start.toISOString();
  const rangeEnd = compiled.end.toISOString();
  try {
    const { queryMetric } = await import("./metrics/core-engine");
    const series = await queryMetric(row.metricId, { start: compiled.start, end: compiled.end });
    const coverage = series.coverage;
    if (coverage.status === "unavailable" || coverage.status === "unbound") {
      return {
        metric: series.metric,
        score: unavailableScore(coverage.reason),
        coverage,
        series: [],
        rangeStart,
        rangeEnd,
      };
    }
    const point = [...series.samples]
      .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())
      .find((sample) => sampleBelongsToLatestBucket(sample, compiled)) ?? null;
    return {
      metric: series.metric,
      score: scoreKpi({
        direction: (row.direction as MetricDirection) ?? "higher_is_better",
        bullThreshold: row.bullThreshold,
        bearThreshold: row.bearThreshold,
        staleAfterHours: row.staleAfterHours ?? 168,
        sample: point,
        applyStale: question.period === "live",
      }),
      coverage,
      series: series.samples,
      rangeStart,
      rangeEnd,
    };
  } catch (error) {
    if ((error as { status?: number })?.status === 404) {
      return {
        metric: metric ?? null,
        score: unavailableScore("Metric not found"),
        coverage: { status: "unavailable", reason: "Metric not found" },
        series: [],
        rangeStart,
        rangeEnd,
      };
    }
    throw error;
  }
}

async function latestSampleFor(
  metricId: string,
  range?: { start: Date; end: Date },
): Promise<MetricSample | null> {
  await ensureMetricsSamplesSchema();
  const [row] = await metricsDb
    .select()
    .from(metricSamples)
    .where(and(
      eq(metricSamples.metricId, metricId),
      range ? sql`${metricSamples.observedAt} >= ${range.start}` : undefined,
      range ? sql`${metricSamples.observedAt} <= ${range.end}` : undefined,
    ))
    .orderBy(desc(metricSamples.observedAt))
    .limit(1);
  return row ? mapSample(row) : null;
}

async function overlayIdentityStockSample(
  metric: Metric,
  range?: { start: Date; end: Date },
): Promise<Metric> {
  if (!IDENTITY_STOCK_SLUGS.has(metric.slug) || !metric.businessId) return metric;
  const principal = getCurrentPrincipal();
  if (!principal?.accountId) return metric;
  // Identity stocks are platform product metrics — never overlay without users:read.
  if (!canReadPlatformMetrics(principal)) return metric;
  if (range && !identityStockCanAnswerRange(range)) {
    return { ...metric, latestSample: null };
  }
  const [business] = await db.select({
    id: businesses.id,
    isPlatformInstrument: businesses.isPlatformInstrument,
  })
    .from(businesses)
    .where(visibleBusinessPredicate(principal, eq(businesses.id, metric.businessId)))
    .limit(1);
  if (!business?.isPlatformInstrument) return metric;
  const { sampleIdentityStock } = await import("./identity-metrics");
  const stock = await sampleIdentityStock();
  const observedAt = new Date().toISOString();
  const value = metric.slug === "accounts" ? stock.accounts : stock.registeredUsers;
  const sample: MetricSample = {
    id: `query_${metric.businessId}_${metric.slug}_${observedAt}`,
    metricId: metric.id,
    accountId: principal.accountId,
    vaultId: metric.vaultId ?? principal.activeVaultId ?? null,
    value,
    unit: metric.unit || (metric.slug === "accounts" ? "accounts" : "users"),
    observedAt,
    sourceRef: `internal/${metric.slug}-query-v1`,
    evidence: metric.slug === "accounts"
      ? "Count of identity accounts with status=active."
      : "Distinct users with a membership on an active (status=active) account.",
    periodStart: null,
    periodEnd: null,
    createdAt: observedAt,
  };
  return { ...metric, latestSample: sample };
}

export interface InternalBusinessMetricDefinition {
  key: string;
  name: string;
  unit: string;
  description: string;
  direction?: MetricDirection;
  samplePeriod?: "point" | "daily" | "weekly" | "monthly" | "custom";
}

export interface InternalBusinessMetricRef {
  id: string;
  businessId: string;
  accountId: string;
  ownerUserId: string;
  vaultId: string | null;
}

/** Provision one internal series per Business and slug. Internal adapters may
 * aggregate private source rows, but only this Business-owned series is exposed.
 */
export async function ensurePlatformBusinessMetrics(
  definitions: readonly InternalBusinessMetricDefinition[],
): Promise<Map<string, InternalBusinessMetricRef>> {
  const businessRows = await db.execute(sql`
    SELECT b.id AS business_id, b.owner_user_id, b.account_id, min(bvm.vault_id) AS vault_id
    FROM businesses b
    JOIN business_vault_memberships bvm ON bvm.business_id = b.id
    WHERE b.is_platform_instrument = true AND b.status = 'active'
    GROUP BY b.id, b.owner_user_id, b.account_id
    ORDER BY b.created_at
    LIMIT 1
  `);
  const rows = Array.isArray(businessRows) ? businessRows : (businessRows as unknown as { rows?: unknown[] }).rows ?? [];
  const owner = rows[0] as { business_id?: string; owner_user_id?: string; account_id?: string; vault_id?: string | null } | undefined;
  if (!owner?.business_id || !owner.owner_user_id || !owner.account_id) return new Map();

  for (const definition of definitions) {
    const id = `metric_${definition.key.replace(/-/g, "_")}_${owner.business_id}`;
    const product = PRODUCT_METRIC_SLUGS.has(definition.key);
    const adapterConfig = product
      ? { key: definition.key, adapterKey: "product" }
      : { key: definition.key };
    await db.execute(sql`
      INSERT INTO metrics (
        id, business_id, name, slug, description, unit, direction, sample_period, adapter_kind,
        adapter_config, status, scope, owner_user_id, account_id, vault_id, created_by_user_id,
        owner_kind, owner_id
      ) VALUES (
        ${id}, ${owner.business_id}, ${definition.name}, ${definition.key}, ${definition.description}, ${definition.unit},
        ${definition.direction ?? "higher_is_better"}, ${definition.samplePeriod ?? "custom"}, 'internal',
        ${JSON.stringify(adapterConfig)}::jsonb, 'active', 'user', ${owner.owner_user_id},
        ${owner.account_id}, ${owner.vault_id ?? null}, ${owner.owner_user_id},
        ${product ? "platform" : "account"}, ${product ? null : owner.account_id}
      )
      ON CONFLICT DO NOTHING
    `);
    if (product) {
      await db.execute(sql`
        UPDATE metrics
        SET owner_kind = 'platform',
            owner_id = NULL,
            adapter_config = COALESCE(adapter_config, '{}'::jsonb) || ${JSON.stringify({ adapterKey: "product" })}::jsonb,
            updated_at = NOW()
        WHERE id = ${id}
          AND (owner_kind IS DISTINCT FROM 'platform'
            OR COALESCE(adapter_config->>'adapterKey', '') IS DISTINCT FROM 'product')
      `);
    }
  }

  const slugs = definitions.map((definition) => definition.key);
  const metricRows = await db.select({
    id: metrics.id,
    businessId: metrics.businessId,
    accountId: metrics.accountId,
    slug: metrics.slug,
    ownerUserId: metrics.ownerUserId,
    vaultId: metrics.vaultId,
  }).from(metrics).where(and(eq(metrics.businessId, owner.business_id), inArray(metrics.slug, slugs)));

  return new Map(metricRows.flatMap((metric) => metric.ownerUserId && metric.businessId && metric.accountId
    ? [[metric.slug, { id: metric.id, businessId: metric.businessId, accountId: metric.accountId, ownerUserId: metric.ownerUserId, vaultId: metric.vaultId }]]
    : []));
}

export interface InternalPeriodSampleInput {
  id: string;
  metricId: string;
  accountId: string;
  ownerUserId: string;
  vaultId: string | null;
  value: number;
  unit: string;
  observedAt: Date;
  sourceRef: string;
  evidence: string | null;
  periodStart: Date;
  periodEnd: Date;
}

export async function upsertInternalPeriodSample(input: InternalPeriodSampleInput): Promise<MetricSample> {
  await ensureMetricsSamplesSchema();
  const [row] = await metricsDb
    .insert(metricSamples)
    .values({
      id: input.id,
      metricId: input.metricId,
      accountId: input.accountId,
      vaultId: input.vaultId,
      value: input.value,
      unit: input.unit,
      observedAt: input.observedAt,
      sourceRef: input.sourceRef,
      evidence: input.evidence,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    })
    .onConflictDoUpdate({
      target: metricSamples.id,
      set: {
        value: input.value,
        unit: input.unit,
        observedAt: input.observedAt,
        sourceRef: input.sourceRef,
        evidence: input.evidence,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
      },
    })
    .returning();
  eventBus.publish({
    category: "data",
    event: "data:metrics_changed",
    payload: { metricId: input.metricId },
    audience: {
      scope: "user",
      ownerUserId: input.ownerUserId,
      accountId: input.accountId,
    },
  });
  return mapSample(row);
}

export const metricsStorage = {
  async list(query?: string, businessId?: string, range?: { start: Date; end: Date }): Promise<Metric[]> {
    const principal = currentPrincipal();
    const allowPlatform = canReadPlatformMetrics(principal);
    const allowSystem = canReadSystemMetrics(principal);
    const needle = query?.trim();
    const filter = and(
      businessId ? eq(metrics.businessId, businessId) : undefined,
      needle ? or(
        ilike(metrics.name, `%${needle}%`),
        ilike(metrics.description, `%${needle}%`),
        ilike(metrics.slug, `%${needle}%`),
      ) : undefined,
      // Engine gate: never advertise Product without users:read or System without system:read.
      allowPlatform
        ? undefined
        : sql`(${metrics.ownerKind} IS DISTINCT FROM 'platform' AND ${metrics.slug} NOT IN ('hours-used','active-users','current-users','new-users','accounts','registered-users','shipped-prs','user-memory','achieved-goals','hours-used-per-user'))`,
      allowSystem
        ? undefined
        : sql`(${metrics.ownerKind} IS DISTINCT FROM 'performance' AND COALESCE(${metrics.adapterConfig}->>'adapterKey', '') IS DISTINCT FROM 'performance')`,
    );
    const rows = await db
      .select({ metric: metrics })
      .from(metrics)
      .where(and(combineWithVisibleScope(principal, metricScope, filter), businessId ? eq(metrics.businessId, businessId) : undefined))
      .orderBy(asc(metrics.name));

    const out: Metric[] = [];
    for (const { metric } of rows) {
      const mapped = mapMetric(metric, await latestSampleFor(metric.id, range));
      if (!metricIsVisibleTo(principal, mapped)) continue;
      out.push(await overlayIdentityStockSample(mapped, range));
    }
    if (!range) return out;
    const { overlayCatalogSeries } = await import("./metrics/core-engine");
    return overlayCatalogSeries(out, range);
  },

  async get(id: string): Promise<Metric> {
    const principal = currentPrincipal();
    const [result] = await db
      .select({ metric: metrics })
      .from(metrics)
      .where(combineWithVisibleScope(principal, metricScope, eq(metrics.id, id)))
      .limit(1);
    if (!result?.metric) throw Object.assign(new Error("Metric not found"), { status: 404 });
    const mapped = mapMetric(result.metric, await latestSampleFor(result.metric.id));
    if (!metricIsVisibleTo(principal, mapped)) {
      throw Object.assign(new Error("Metric not found"), { status: 404 });
    }
    return overlayIdentityStockSample(mapped);
  },

  async create(input: MetricCreate): Promise<Metric> {
    const principal = currentPrincipal();
    const parsed = metricCreateSchema.parse(input);
    const slug = parsed.slug?.trim() || slugifyMetricName(parsed.name);
    const id = newId("metric");
    const ownership = ownedInsertValues(principal, metricScope);
    const compiled = await compilePersistedExpression({
      adapterKind: parsed.adapterKind,
      adapterConfig: parsed.adapterConfig,
    });
    const [row] = await db
      .insert(metrics)
      .values({
        id,
        ...ownership,
        businessId: parsed.businessId,
        ownerKind: compiled.didCompile
          ? compiled.ownerKind ?? "account"
          : parsed.ownerKind ?? "account",
        ownerId: compiled.didCompile
          ? (compiled.ownerKind === "platform" || compiled.ownerKind === "performance"
            ? null
            : parsed.ownerId ?? principal.accountId)
          : parsed.ownerId ?? principal.accountId,
        createdByUserId: principal.userId,
        name: parsed.name,
        slug,
        description: parsed.description ?? "",
        unit: parsed.unit ?? "",
        direction: parsed.direction ?? "higher_is_better",
        samplePeriod: parsed.samplePeriod ?? "point",
        adapterKind: compiled.adapterKind,
        adapterConfig: compiled.adapterConfig,
        status: parsed.status ?? "active",
      })
      .returning();
    return mapMetric(row, null);
  },

  async update(id: string, input: MetricUpdate): Promise<Metric> {
    const principal = currentPrincipal();
    const existing = await this.get(id);
    assertWritable(principal, existing, "Metric");
    const parsed = metricUpdateSchema.parse(input);
    const { clearFields, ...rest } = parsed;
    const compiled = await compilePersistedExpression({
      adapterKind: rest.adapterKind,
      adapterConfig: rest.adapterConfig,
      existing,
      selfId: id,
    });
    const patch: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    if (compiled.didCompile) {
      patch.adapterKind = compiled.adapterKind;
      patch.adapterConfig = compiled.adapterConfig;
      if (compiled.ownerKind) {
        patch.ownerKind = compiled.ownerKind;
        patch.ownerId = compiled.ownerKind === "account" ? existing.ownerId : null;
      }
    }
    if (clearFields?.includes("description")) patch.description = "";
    if (patch.description === "" && !clearFields?.includes("description") && rest.description === undefined) {
      delete patch.description;
    }
    if (Object.keys(patch).length <= 1) return existing;

    if (rest.businessId) {
      const [target] = await db.select({ id: businesses.id }).from(businesses)
        .where(writableBusinessPredicate(principal, eq(businesses.id, rest.businessId))).limit(1);
      if (!target) throw Object.assign(new Error("Business not found or not writable"), { status: 404 });
    }
    const [row] = await db
      .update(metrics)
      .set(patch)
      .where(combineWithWritableScope(principal, metricScope, eq(metrics.id, id)))
      .returning();
    assertWritable(principal, row, "Metric");
    const sample = await latestSampleFor(row.id);
    return mapMetric(row, sample);
  },

  async delete(id: string): Promise<Metric> {
    const principal = currentPrincipal();
    const existing = await this.get(id);
    assertWritable(principal, existing, "Metric");
    const [row] = await db
      .delete(metrics)
      .where(combineWithWritableScope(principal, metricScope, eq(metrics.id, id)))
      .returning();
    assertWritable(principal, row, "Metric");
    return mapMetric(row, null);
  },

  async listSamples(metricId: string, limit = 50): Promise<MetricSample[]> {
    const principal = currentPrincipal();
    const metric = await this.get(metricId);
    if (!principal.accountId) return [];
    await ensureMetricsSamplesSchema();
    const rows = await metricsDb
      .select()
      .from(metricSamples)
      .where(eq(metricSamples.metricId, metric.id))
      .orderBy(desc(metricSamples.observedAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map(mapSample);
  },

  async sampleRange(businessId: string, start: Date, end: Date): Promise<UsageRangeSample & WorkRangeSample & IdentityRangeSample & {
    coverage: { status: "provisional" | "finalized"; finalizesAt: string };
  }> {
    const principal = currentPrincipal();
    if (!canReadPlatformMetrics(principal)) {
      // Product current-range is platform-wide Mantra ops — fail closed as not found.
      throw Object.assign(new Error("Metric not found"), { status: 404 });
    }
    const [business] = await db.select({ id: businesses.id, isPlatformInstrument: businesses.isPlatformInstrument })
      .from(businesses)
      .where(visibleBusinessPredicate(principal, eq(businesses.id, businessId)))
      .limit(1);
    if (!business) throw Object.assign(new Error("Business not found"), { status: 404 });
    if (!business.isPlatformInstrument) {
      throw Object.assign(new Error("This Business has no internal current-range adapter"), { status: 409 });
    }
    const [{ sampleUsageRange }, { sampleWorkRange }, { sampleIdentityRange }] = await Promise.all([
      import("./hours-used"),
      import("./work-metrics"),
      import("./identity-metrics"),
    ]);
    const [usage, work, identity] = await Promise.all([
      // Platform-wide Hours Used — never pass principal accountId.
      sampleUsageRange(null, start, end),
      sampleWorkRange(start, end),
      sampleIdentityRange(start, end),
    ]);
    const finalizesAt = new Date(end.getTime() + USAGE_LEASE_TAIL_MS);
    return {
      ...usage,
      ...work,
      ...identity,
      coverage: {
        status: finalizesAt.getTime() > Date.now() ? "provisional" : "finalized",
        finalizesAt: finalizesAt.toISOString(),
      },
    };
  },

  async listSamplesInRange(metricId: string, start: Date, end: Date): Promise<MetricSample[]> {
    const metric = await this.get(metricId);
    if (!currentPrincipal().accountId) return [];
    await ensureMetricsSamplesSchema();
    const rows = await metricsDb
      .select()
      .from(metricSamples)
      .where(and(
        eq(metricSamples.metricId, metric.id),
        sql`${metricSamples.observedAt} >= ${start}`,
        sql`${metricSamples.observedAt} < ${end}`,
      ))
      .orderBy(desc(metricSamples.observedAt));
    return rows.map(mapSample);
  },

  /** Unified Metrics read. Domain-owned current values stay query-time and
   * durable observations stay in metric_samples, but every consumer receives
   * the same MetricSeries contract and one readiness boundary. Product rows
   * require users:read; meetings remain principal-scoped. */
  async collection(businessId: string, start: Date, end: Date): Promise<MetricCollection> {
    const principal = currentPrincipal();
    const allowPlatform = canReadPlatformMetrics(principal);
    const durable = await this.list(undefined, businessId, { start, end });
    let current: Awaited<ReturnType<typeof this.sampleRange>> | null = null;
    try {
      current = await this.sampleRange(businessId, start, end);
    } catch (error) {
      const status = (error as { status?: number })?.status;
      // 409 = non-platform business; 404 = no users:read — both skip product current series.
      if (status !== 409 && status !== 404) throw error;
    }
    const bySlug = new Map(durable.map((metric) => [metric.slug, metric]));
    if (!current) {
      // Still project principal-scoped meetings when product current is gated.
      const meetingsDef = CURRENT_METRIC_DEFINITIONS.find((d) => d.slug === "meetings");
      let meetingsSeries: MetricSeries[] = [];
      if (meetingsDef) {
        const { countCompletedMeetingsWithNotesInRange } = await import("./meetings/meeting-index");
        const value = await countCompletedMeetingsWithNotesInRange(start, end);
        const existing = bySlug.get("meetings");
        if (existing) bySlug.delete("meetings");
        const observedAt = end.toISOString();
        const sample: MetricSample = {
          id: `query_${businessId}_meetings_${start.getTime()}_${end.getTime()}`,
          metricId: existing?.id ?? `metric_current_${businessId}_meetings`,
          accountId: principal.accountId!,
          vaultId: existing?.vaultId ?? principal.activeVaultId ?? null,
          value,
          unit: meetingsDef.unit,
          observedAt,
          sourceRef: "internal/meetings-query-v1",
          evidence: "Completed sessions with notes in the selected range.",
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          createdAt: observedAt,
        };
        const metric = existing
          ? { ...existing, latestSample: sample }
          : virtualCurrentMetric(businessId, meetingsDef, sample);
        meetingsSeries = [{ metric, samples: [sample], valueStatus: "actual", coverage: { status: "finalized" } }];
      }
      return {
        start: start.toISOString(),
        end: end.toISOString(),
        series: [
          ...meetingsSeries,
          ...[...bySlug.values()].map((metric) => ({
            metric,
            samples: metric.latestSample ? [metric.latestSample] : [],
            valueStatus: "actual" as const,
            coverage: { status: "finalized" as const },
          })),
        ],
      };
    }
    const rangeCoverage: MetricCoverage = current.coverage.status === "provisional"
      ? { status: "provisional", finalizesAt: current.coverage.finalizesAt }
      : { status: "finalized" };
    const currentSeries = CURRENT_METRIC_DEFINITIONS.flatMap((definition) => {
      if (isProductCurrentSlug(definition.slug) && !allowPlatform) return [];
      const existing = bySlug.get(definition.slug);
      if (existing) bySlug.delete(definition.slug);
      const isIdentityStock = IDENTITY_STOCK_SLUGS.has(definition.slug);
      const coverage: MetricCoverage = definition.key === "newUsers"
        ? {
            status: "partial",
            availableFrom: current.newUsersCoverage.availableFrom,
            reason: "Historical signup provenance is incomplete.",
          }
        : isIdentityStock
          ? { status: "finalized" }
          : definition.slug === "meetings"
            ? { status: "finalized" }
            : rangeCoverage;
      const observedAt = isIdentityStock ? new Date().toISOString() : end.toISOString();
      const sample: MetricSample = {
        id: `query_${businessId}_${definition.slug}_${isIdentityStock ? observedAt : `${start.getTime()}_${end.getTime()}`}`,
        metricId: existing?.id ?? `metric_current_${businessId}_${definition.slug.replace(/-/g, "_")}`,
        accountId: principal.accountId!,
        vaultId: existing?.vaultId ?? principal.activeVaultId ?? null,
        value: Number(current[definition.key]),
        unit: definition.unit,
        observedAt,
        sourceRef: `internal/${definition.slug}-query-v1`,
        evidence: isIdentityStock
          ? (definition.slug === "accounts"
            ? "Count of identity accounts with status=active."
            : "Distinct users with a membership on an active (status=active) account.")
          : definition.slug === "meetings"
            ? "Completed sessions with notes in the selected range."
            : "Resolved from the owning product system for the selected range.",
        periodStart: isIdentityStock ? null : start.toISOString(),
        periodEnd: isIdentityStock ? null : end.toISOString(),
        createdAt: observedAt,
      };
      const metric = existing
        ? { ...existing, ownerKind: isProductCurrentSlug(definition.slug) ? "platform" : existing.ownerKind, latestSample: sample }
        : virtualCurrentMetric(businessId, definition, sample);
      return [{ metric, samples: [sample], valueStatus: "actual" as const, coverage }];
    });
    const durableSeries = [...bySlug.values()].map((metric) => ({
      metric,
      samples: metric.latestSample ? [metric.latestSample] : [],
      valueStatus: "actual" as const,
      coverage: { status: "finalized" as const },
    }));
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      series: [...currentSeries, ...durableSeries],
    };
  },

  async deleteSample(id: string): Promise<MetricSample> {
    const principal = currentPrincipal();
    if (!principal.accountId) {
      throw Object.assign(new Error("Account required"), { status: 400 });
    }
    await ensureMetricsSamplesSchema();
    const [existing] = await metricsDb
      .select()
      .from(metricSamples)
      .where(
        and(
          eq(metricSamples.id, id),
          eq(metricSamples.accountId, principal.accountId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw Object.assign(new Error("Metric sample not found"), { status: 404 });
    }
    await this.get(existing.metricId);
    const [row] = await metricsDb
      .delete(metricSamples)
      .where(
        and(
          eq(metricSamples.id, id),
          eq(metricSamples.accountId, principal.accountId),
        ),
      )
      .returning();
    if (!row) {
      throw Object.assign(new Error("Metric sample not found"), { status: 404 });
    }
    return mapSample(row);
  },

  async recordPeriodSample(input: MetricSampleCreate & { idempotencyKey: string }): Promise<MetricSample> {
    const principal = currentPrincipal();
    const parsed = metricSampleCreateSchema.parse(input);
    const metric = await this.get(parsed.metricId);
    assertWritable(principal, metric, "Metric");
    if (!principal.accountId) {
      throw Object.assign(new Error("Account required"), { status: 400 });
    }
    if (!parsed.periodStart || !parsed.periodEnd) {
      throw Object.assign(new Error("Period start and end are required"), { status: 400 });
    }
    const idempotencyDigest = createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32);
    const observedAt = parsed.observedAt ? new Date(parsed.observedAt) : new Date(parsed.periodEnd);
    return upsertInternalPeriodSample({
      id: `msamp_period_${idempotencyDigest}`,
      metricId: metric.id,
      accountId: principal.accountId,
      ownerUserId: principal.userId,
      vaultId: metric.vaultId,
      value: parsed.value,
      unit: parsed.unit ?? metric.unit ?? "",
      observedAt,
      sourceRef: parsed.sourceRef ?? "internal",
      evidence: parsed.evidence ?? null,
      periodStart: new Date(parsed.periodStart),
      periodEnd: new Date(parsed.periodEnd),
    });
  },

  async recordSample(input: MetricSampleCreate): Promise<MetricSample> {
    const principal = currentPrincipal();
    const parsed = metricSampleCreateSchema.parse(input);
    const metric = await this.get(parsed.metricId);
    assertWritable(principal, metric, "Metric");
    if (!principal.accountId) {
      throw Object.assign(new Error("Account required"), { status: 400 });
    }
    await ensureMetricsSamplesSchema();
    const id = newId("msamp");
    const observedAt = parsed.observedAt ? new Date(parsed.observedAt) : new Date();
    const [row] = await metricsDb
      .insert(metricSamples)
      .values({
        id,
        metricId: metric.id,
        accountId: principal.accountId,
        vaultId: metric.vaultId,
        value: parsed.value,
        unit: parsed.unit ?? metric.unit ?? "",
        observedAt,
        sourceRef: parsed.sourceRef ?? "manual",
        evidence: parsed.evidence ?? null,
        periodStart: parsed.periodStart ? new Date(parsed.periodStart) : null,
        periodEnd: parsed.periodEnd ? new Date(parsed.periodEnd) : null,
      })
      .returning();
    return mapSample(row);
  },
};

export const kpiStorage = {
  async list(query?: string, businessId?: string): Promise<Kpi[]> {
    const principal = currentPrincipal();
    const needle = query?.trim();
    const filter = needle
      ? or(
          ilike(kpis.name, `%${needle}%`),
          ilike(kpis.description, `%${needle}%`),
          ilike(kpis.slug, `%${needle}%`),
          ilike(kpis.standingObjectiveKey, `%${needle}%`),
        )
      : undefined;
    const rows = await db
      .select({ kpi: kpis })
      .from(kpis)
      .innerJoin(metrics, eq(metrics.id, kpis.metricId))
      .where(and(
        combineWithVisibleScope(principal, kpiScope, filter),
        businessId ? eq(metrics.businessId, businessId) : undefined,
      ))
      .orderBy(asc(kpis.name));

    const out: Kpi[] = [];
    for (const { kpi: row } of rows) {
      try {
        const evaluated = await evaluateKpi(row);
        out.push(mapKpi(row, evaluated));
      } catch (error) {
        if ((error as { status?: number })?.status === 404) continue;
        throw error;
      }
    }
    return out;
  },

  async get(id: string): Promise<Kpi> {
    const principal = currentPrincipal();
    const [row] = await db
      .select()
      .from(kpis)
      .where(combineWithVisibleScope(principal, kpiScope, eq(kpis.id, id)))
      .limit(1);
    assertVisible(principal, row, "KPI");
    const evaluated = await evaluateKpi(row);
    return mapKpi(row, evaluated);
  },

  async getByStandingObjective(key: StandingObjectiveKey): Promise<Kpi | null> {
    const principal = currentPrincipal();
    const [row] = await db
      .select()
      .from(kpis)
      .where(
        combineWithVisibleScope(
          principal,
          kpiScope,
          and(eq(kpis.standingObjectiveKey, key), eq(kpis.status, "active")),
        ),
      )
      .limit(1);
    if (!row) return null;
    const evaluated = await evaluateKpi(row);
    return mapKpi(row, evaluated);
  },

  async create(input: KpiCreate): Promise<Kpi> {
    const principal = currentPrincipal();
    const parsed = kpiCreateSchema.parse(input);
    // Ensure metric is visible/writable context
    const metric = await metricsStorage.get(parsed.metricId);
    const slug = parsed.slug?.trim() || slugifyMetricName(parsed.name);
    const id = newId("kpi");
    const ownership = ownedInsertValues(principal, kpiScope);
    const [row] = await db
      .insert(kpis)
      .values({
        id,
        ...ownership,
        createdByUserId: principal.userId,
        metricId: metric.id,
        name: parsed.name,
        slug,
        description: parsed.description ?? "",
        targetLabel: parsed.targetLabel ?? "",
        cadence: parsed.cadence,
        period: parsed.period,
        samples: parsed.samples,
        style: parsed.style,
        ownerLabel: parsed.ownerLabel ?? "",
        direction: parsed.direction ?? metric.direction ?? "higher_is_better",
        bullThreshold: parsed.bullThreshold ?? null,
        onTrackThreshold: null,
        bearThreshold: parsed.bearThreshold ?? null,
        staleAfterHours: parsed.staleAfterHours ?? 168,
        standingObjectiveKey: parsed.standingObjectiveKey ?? null,
        status: parsed.status ?? "active",
      })
      .returning();
    return mapKpi(row, await evaluateKpi(row, metric));
  },

  async update(id: string, input: KpiUpdate): Promise<Kpi> {
    const principal = currentPrincipal();
    const existing = await this.get(id);
    assertWritable(principal, existing, "KPI");
    const parsed = kpiUpdateSchema.parse(input);
    const { clearFields, ...rest } = parsed;
    const nextPeriod = rest.period
      ? normalizeKpiPeriod(rest.period, rest.cadence ?? existing.cadence)
      : existing.period;
    const nextSamples = rest.samples != null || rest.period
      ? normalizeKpiSamples(nextPeriod, rest.samples ?? (nextPeriod === "live" ? 1 : existing.samples))
      : existing.samples;
    const nextStyle = rest.style ? normalizeKpiStyle(rest.style) : existing.style;
    const patch: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    delete patch.onTrackThreshold;
    if (rest.period || rest.samples != null || rest.cadence !== undefined) {
      patch.period = nextPeriod;
      patch.samples = nextSamples;
      patch.cadence = cadenceFromPeriod(nextPeriod);
    }
    if (rest.style) patch.style = nextStyle;

    if (clearFields?.includes("description")) patch.description = "";
    if (clearFields?.includes("targetLabel")) patch.targetLabel = "";
    if (clearFields?.includes("standingObjectiveKey")) patch.standingObjectiveKey = null;
    if (clearFields?.includes("bullThreshold")) patch.bullThreshold = null;
    if (clearFields?.includes("onTrackThreshold")) patch.onTrackThreshold = null;
    if (clearFields?.includes("bearThreshold")) patch.bearThreshold = null;

    // Safe partial: empty strings on optional text are no-ops unless clearFields
    if (patch.description === "" && !clearFields?.includes("description") && rest.description === undefined) {
      delete patch.description;
    }
    if (patch.targetLabel === "" && !clearFields?.includes("targetLabel") && rest.targetLabel === undefined) {
      delete patch.targetLabel;
    }

    if (rest.metricId) {
      await metricsStorage.get(rest.metricId);
    }

    if (Object.keys(patch).length <= 1) return existing;

    const [row] = await db
      .update(kpis)
      .set(patch)
      .where(combineWithWritableScope(principal, kpiScope, eq(kpis.id, id)))
      .returning();
    assertWritable(principal, row, "KPI");
    return mapKpi(row, await evaluateKpi(row));
  },

  async delete(id: string): Promise<Kpi> {
    const principal = currentPrincipal();
    const existing = await this.get(id);
    assertWritable(principal, existing, "KPI");
    const [row] = await db
      .delete(kpis)
      .where(combineWithWritableScope(principal, kpiScope, eq(kpis.id, id)))
      .returning();
    assertWritable(principal, row, "KPI");
    return mapKpi(row);
  },

  /** Score map for all active KPIs bound to standing objectives. */
  async standingObjectiveScores(businessId?: string): Promise<Record<string, Kpi>> {
    const list = await this.list(undefined, businessId);
    const map: Record<string, Kpi> = {};
    for (const kpi of list) {
      if (kpi.status !== "active" || !kpi.standingObjectiveKey) continue;
      map[kpi.standingObjectiveKey] = kpi;
    }
    return map;
  },
};

/** Ensure account-side metrics/kpis tables exist (dev bootstrap). */
export async function ensureMetricsDefinitionsSchema(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS metrics (
      id text PRIMARY KEY,
      business_id text,
      owner_kind text NOT NULL DEFAULT 'account',
      owner_id text,
      name text NOT NULL,
      slug text NOT NULL,
      description text NOT NULL DEFAULT '',
      unit text NOT NULL DEFAULT '',
      direction text NOT NULL DEFAULT 'higher_is_better',
      sample_period text NOT NULL DEFAULT 'point',
      adapter_kind text NOT NULL DEFAULT 'manual',
      adapter_config jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'active',
      scope text NOT NULL DEFAULT 'user',
      owner_user_id text,
      account_id text,
      vault_id text,
      created_by_user_id text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.execute(sql`ALTER TABLE metrics ADD COLUMN IF NOT EXISTS business_id text`);
  await db.execute(sql`ALTER TABLE metrics ADD COLUMN IF NOT EXISTS owner_kind text NOT NULL DEFAULT 'account'`);
  await db.execute(sql`ALTER TABLE metrics ADD COLUMN IF NOT EXISTS owner_id text`);
  await db.execute(sql`UPDATE metrics SET owner_id = COALESCE(owner_id, account_id) WHERE owner_id IS NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS metrics_owner_idx ON metrics(owner_kind, owner_id)`);
  await db.execute(sql`DROP INDEX IF EXISTS metrics_account_slug_uidx`);
  // Expression unique index so NULL vault_id cannot stack duplicate slugs
  // (plain UNIQUE treats each NULL as distinct in PostgreSQL).
  await db.execute(sql`DROP INDEX IF EXISTS metrics_account_vault_slug_uidx`);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS metrics_account_vault_slug_uidx ON metrics(account_id, COALESCE(vault_id, ''), slug)`,
  );
  await db.execute(sql`
    UPDATE metrics m SET business_id = b.id
    FROM businesses b
    WHERE m.business_id IS NULL
      AND m.account_id = b.account_id
      AND b.is_platform_instrument = true
  `);
  await db.execute(sql`
    DELETE FROM metrics m
    USING businesses b
    WHERE m.business_id IS NULL
      AND m.account_id <> b.account_id
      AND b.is_platform_instrument = true
      AND m.slug IN ('hours-used', 'active-users', 'current-users', 'user-memory')
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS metrics_business_slug_uidx ON metrics(business_id, slug) WHERE business_id IS NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS metrics_account_vault_idx ON metrics(account_id, vault_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS metrics_scope_owner_idx ON metrics(scope, owner_user_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS kpis (
      id text PRIMARY KEY,
      metric_id text NOT NULL,
      name text NOT NULL,
      slug text NOT NULL,
      description text NOT NULL DEFAULT '',
      target_label text NOT NULL DEFAULT '',
      cadence text NOT NULL DEFAULT 'Weekly',
      owner_label text NOT NULL DEFAULT '',
      direction text NOT NULL DEFAULT 'higher_is_better',
      bull_threshold double precision,
      on_track_threshold double precision,
      bear_threshold double precision,
      stale_after_hours integer NOT NULL DEFAULT 168,
      standing_objective_key text,
      period text NOT NULL DEFAULT 'weekly',
      samples integer NOT NULL DEFAULT 1,
      style text NOT NULL DEFAULT 'line',
      status text NOT NULL DEFAULT 'active',
      scope text NOT NULL DEFAULT 'user',
      owner_user_id text,
      account_id text,
      vault_id text,
      created_by_user_id text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.execute(sql`DROP INDEX IF EXISTS kpis_account_slug_uidx`);
  await db.execute(sql`DROP INDEX IF EXISTS kpis_account_vault_slug_uidx`);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS kpis_account_vault_slug_uidx ON kpis(account_id, COALESCE(vault_id, ''), slug)`,
  );
  await db.execute(sql`CREATE INDEX IF NOT EXISTS kpis_account_vault_idx ON kpis(account_id, vault_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS kpis_metric_idx ON kpis(metric_id)`);
  await db.execute(sql`DROP INDEX IF EXISTS kpis_vault_standing_objective_uidx`);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS kpis_vault_standing_objective_uidx ON kpis(COALESCE(vault_id, ''), standing_objective_key) WHERE standing_objective_key IS NOT NULL`,
  );
  await db.execute(sql`CREATE INDEX IF NOT EXISTS kpis_scope_owner_idx ON kpis(scope, owner_user_id)`);
  await db.execute(sql`ALTER TABLE kpis ADD COLUMN IF NOT EXISTS period text NOT NULL DEFAULT 'weekly'`);
  await db.execute(sql`ALTER TABLE kpis ADD COLUMN IF NOT EXISTS samples integer NOT NULL DEFAULT 1`);
  await db.execute(sql`ALTER TABLE kpis ADD COLUMN IF NOT EXISTS style text NOT NULL DEFAULT 'line'`);
  await db.execute(sql`
    UPDATE kpis SET period = CASE lower(cadence)
      WHEN 'live' THEN 'live'
      WHEN 'hourly' THEN 'hourly'
      WHEN 'daily' THEN 'daily'
      WHEN 'weekly' THEN 'weekly'
      WHEN 'monthly' THEN 'monthly'
      WHEN 'quarterly' THEN 'quarterly'
      WHEN 'annually' THEN 'annually'
      WHEN 'yearly' THEN 'annually'
      ELSE period
    END
    WHERE period = 'weekly'
  `);
}
