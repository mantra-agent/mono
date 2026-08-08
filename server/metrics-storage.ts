import { createHash, randomBytes } from "crypto";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { metrics, kpis, metricSamples } from "@shared/schema";
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
  type MetricUpdate,
  type StandingObjectiveKey,
} from "@shared/models/metrics";
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

function mapKpi(
  row: typeof kpis.$inferSelect,
  opts?: { metric?: Metric | null; sample?: MetricSample | null },
): Kpi {
  const direction = (row.direction as MetricDirection) ?? "higher_is_better";
  const score: KpiScore | undefined = opts?.sample !== undefined || opts?.metric
    ? scoreKpi({
        direction,
        bullThreshold: row.bullThreshold,
        onTrackThreshold: row.onTrackThreshold,
        bearThreshold: row.bearThreshold,
        staleAfterHours: row.staleAfterHours ?? 168,
        sample: opts?.sample ?? opts?.metric?.latestSample ?? null,
      })
    : undefined;

  return {
    id: row.id,
    metricId: row.metricId,
    name: row.name,
    slug: row.slug,
    description: row.description ?? "",
    targetLabel: row.targetLabel ?? "",
    cadence: row.cadence ?? "Weekly",
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
    score,
  };
}

async function latestSampleFor(metricId: string, accountId: string): Promise<MetricSample | null> {
  await ensureMetricsSamplesSchema();
  const [row] = await metricsDb
    .select()
    .from(metricSamples)
    .where(and(eq(metricSamples.metricId, metricId), eq(metricSamples.accountId, accountId)))
    .orderBy(desc(metricSamples.observedAt))
    .limit(1);
  return row ? mapSample(row) : null;
}

export const metricsStorage = {
  async list(query?: string): Promise<Metric[]> {
    const principal = currentPrincipal();
    const needle = query?.trim();
    const filter = needle
      ? or(
          ilike(metrics.name, `%${needle}%`),
          ilike(metrics.description, `%${needle}%`),
          ilike(metrics.slug, `%${needle}%`),
        )
      : undefined;
    const rows = await db
      .select()
      .from(metrics)
      .where(combineWithVisibleScope(principal, metricScope, filter))
      .orderBy(asc(metrics.name));

    const out: Metric[] = [];
    for (const row of rows) {
      const sample = principal.accountId
        ? await latestSampleFor(row.id, principal.accountId)
        : null;
      out.push(mapMetric(row, sample));
    }
    return out;
  },

  async get(id: string): Promise<Metric> {
    const principal = currentPrincipal();
    const [row] = await db
      .select()
      .from(metrics)
      .where(combineWithVisibleScope(principal, metricScope, eq(metrics.id, id)))
      .limit(1);
    assertVisible(principal, row, "Metric");
    const sample = principal.accountId ? await latestSampleFor(row.id, principal.accountId) : null;
    return mapMetric(row, sample);
  },

  async create(input: MetricCreate): Promise<Metric> {
    const principal = currentPrincipal();
    const parsed = metricCreateSchema.parse(input);
    const slug = parsed.slug?.trim() || slugifyMetricName(parsed.name);
    const id = newId("metric");
    const ownership = ownedInsertValues(principal, metricScope);
    const [row] = await db
      .insert(metrics)
      .values({
        id,
        ...ownership,
        createdByUserId: principal.userId,
        name: parsed.name,
        slug,
        description: parsed.description ?? "",
        unit: parsed.unit ?? "",
        direction: parsed.direction ?? "higher_is_better",
        samplePeriod: parsed.samplePeriod ?? "point",
        adapterKind: parsed.adapterKind ?? "manual",
        adapterConfig: parsed.adapterConfig ?? {},
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
    const patch: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    if (clearFields?.includes("description")) patch.description = "";
    if (patch.description === "" && !clearFields?.includes("description") && rest.description === undefined) {
      delete patch.description;
    }
    if (Object.keys(patch).length <= 1) return existing;

    const [row] = await db
      .update(metrics)
      .set(patch)
      .where(combineWithWritableScope(principal, metricScope, eq(metrics.id, id)))
      .returning();
    assertWritable(principal, row, "Metric");
    const sample = principal.accountId ? await latestSampleFor(row.id, principal.accountId) : null;
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
      .where(
        and(
          eq(metricSamples.metricId, metric.id),
          eq(metricSamples.accountId, principal.accountId),
        ),
      )
      .orderBy(desc(metricSamples.observedAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map(mapSample);
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
    await ensureMetricsSamplesSchema();
    const idempotencyDigest = createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32);
    const id = `msamp_period_${idempotencyDigest}`;
    const observedAt = parsed.observedAt ? new Date(parsed.observedAt) : new Date(parsed.periodEnd);
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
        sourceRef: parsed.sourceRef ?? "internal",
        evidence: parsed.evidence ?? null,
        periodStart: new Date(parsed.periodStart),
        periodEnd: new Date(parsed.periodEnd),
      })
      .onConflictDoUpdate({
        target: metricSamples.id,
        set: {
          value: parsed.value,
          unit: parsed.unit ?? metric.unit ?? "",
          observedAt,
          sourceRef: parsed.sourceRef ?? "internal",
          evidence: parsed.evidence ?? null,
          periodStart: new Date(parsed.periodStart),
          periodEnd: new Date(parsed.periodEnd),
        },
      })
      .returning();
    return mapSample(row);
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
  async list(query?: string): Promise<Kpi[]> {
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
      .select()
      .from(kpis)
      .where(combineWithVisibleScope(principal, kpiScope, filter))
      .orderBy(asc(kpis.name));

    const out: Kpi[] = [];
    for (const row of rows) {
      let metric: Metric | null = null;
      let sample: MetricSample | null = null;
      try {
        metric = await metricsStorage.get(row.metricId);
        sample = metric.latestSample ?? null;
      } catch {
        metric = null;
        sample = null;
      }
      out.push(mapKpi(row, { metric, sample }));
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
    let metric: Metric | null = null;
    let sample: MetricSample | null = null;
    try {
      metric = await metricsStorage.get(row.metricId);
      sample = metric.latestSample ?? null;
    } catch {
      /* metric may be missing */
    }
    return mapKpi(row, { metric, sample });
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
    let metric: Metric | null = null;
    let sample: MetricSample | null = null;
    try {
      metric = await metricsStorage.get(row.metricId);
      sample = metric.latestSample ?? null;
    } catch {
      /* ignore */
    }
    return mapKpi(row, { metric, sample });
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
        cadence: parsed.cadence ?? "Weekly",
        ownerLabel: parsed.ownerLabel ?? "",
        direction: parsed.direction ?? metric.direction ?? "higher_is_better",
        bullThreshold: parsed.bullThreshold ?? null,
        onTrackThreshold: parsed.onTrackThreshold ?? null,
        bearThreshold: parsed.bearThreshold ?? null,
        staleAfterHours: parsed.staleAfterHours ?? 168,
        standingObjectiveKey: parsed.standingObjectiveKey ?? null,
        status: parsed.status ?? "active",
      })
      .returning();
    return mapKpi(row, { metric, sample: metric.latestSample ?? null });
  },

  async update(id: string, input: KpiUpdate): Promise<Kpi> {
    const principal = currentPrincipal();
    const existing = await this.get(id);
    assertWritable(principal, existing, "KPI");
    const parsed = kpiUpdateSchema.parse(input);
    const { clearFields, ...rest } = parsed;
    const patch: Record<string, unknown> = { ...rest, updatedAt: new Date() };

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
    let metric: Metric | null = null;
    let sample: MetricSample | null = null;
    try {
      metric = await metricsStorage.get(row.metricId);
      sample = metric.latestSample ?? null;
    } catch {
      /* ignore */
    }
    return mapKpi(row, { metric, sample });
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
    return mapKpi(row, { metric: null, sample: null });
  },

  /** Score map for all active KPIs bound to standing objectives. */
  async standingObjectiveScores(): Promise<Record<string, Kpi>> {
    const list = await this.list();
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
  await db.execute(sql`DROP INDEX IF EXISTS metrics_account_slug_uidx`);
  // Expression unique index so NULL vault_id cannot stack duplicate slugs
  // (plain UNIQUE treats each NULL as distinct in PostgreSQL).
  await db.execute(sql`DROP INDEX IF EXISTS metrics_account_vault_slug_uidx`);
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS metrics_account_vault_slug_uidx ON metrics(account_id, COALESCE(vault_id, ''), slug)`,
  );
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
}
