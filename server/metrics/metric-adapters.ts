/**
 * Code-owned Metric adapter handlers.
 *
 * Composition `metricAdapters` contributions remain labels for the catalog.
 * Dispatch authority lives here: adapterKey → handler. Unknown keys fall
 * through to warehouse metric_samples in queryMetric.
 */
import { createHash } from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { metrics } from "@shared/schema";
import type { Metric, MetricCoverage, MetricSample, MetricSeries } from "@shared/models/metrics";
import { db } from "../db";
import type { Principal } from "../principal";
import { getCurrentPrincipal } from "../principal-context";
import { principalHasPermission } from "../permissions";
import { hasActiveWellnessAccess } from "../mods/wellness-access";
import { isUniqueViolationError } from "../postgres-errors";
import { userDateStr, userDayBounds } from "../utils/user-time";
import { queryMergedPrSeries } from "../integrations/merged-pr-ledger";
import { countCompletedMeetingsWithNotesInRange } from "../meetings/meeting-index";
import { USAGE_LEASE_TAIL_MS } from "../hours-used";
import {
  queryInteractionSeries,
  queryTaskSeries,
  queryWellnessSeries,
} from "./engagement-series";
import { createLogger } from "../log";

const log = createLogger("MetricAdapters");

export const PRODUCT_METRIC_SLUGS = new Set([
  "hours-used",
  "active-users",
  "current-users",
  "new-users",
  "accounts",
  "registered-users",
  "shipped-prs",
]);

/** Meetings is principal-scoped via the meeting index — not a product metric. */
const PRODUCT_CURRENT_KEYS = [
  { key: "hoursUsed" as const, slug: "hours-used", name: "Hours Used", unit: "hours" },
  { key: "activeUsers" as const, slug: "active-users", name: "Active Users", unit: "users" },
  { key: "currentUsers" as const, slug: "current-users", name: "Current Users", unit: "users" },
  { key: "shippedPrs" as const, slug: "shipped-prs", name: "Shipped PRs", unit: "" },
  { key: "newUsers" as const, slug: "new-users", name: "New Users", unit: "users" },
  { key: "accounts" as const, slug: "accounts", name: "Accounts", unit: "accounts" },
  { key: "registeredUsers" as const, slug: "registered-users", name: "Users", unit: "users" },
];

const ENGAGEMENT_DEFINITIONS = [
  {
    slug: "completed-tasks",
    name: "Completed Tasks",
    description: "Tasks completed in the selected range (principal-visible work).",
    unit: "tasks",
    adapterKey: "tasks",
  },
  {
    slug: "opportunity-interactions",
    name: "Opportunity Interactions",
    description:
      "Person interaction events plus ended external calendar meetings from 2026-06-02.",
    unit: "interactions",
    adapterKey: "interactions",
  },
  {
    slug: "wellness-completions",
    name: "Wellness Completions",
    description: "Wellness activity completions in the selected range.",
    unit: "completions",
    adapterKey: "wellness",
  },
] as const;

export type MetricAdapterHandler = (
  metric: Metric,
  range: { start: Date; end: Date },
  principal: Principal,
) => Promise<MetricSeries | null>;

function requirePrincipal(): Principal {
  const principal = getCurrentPrincipal();
  if (!principal?.userId || !principal.accountId) {
    throw Object.assign(new Error("Authentication required"), { status: 401 });
  }
  return principal;
}

export function canReadPlatformMetrics(principal: Principal): boolean {
  return principalHasPermission(principal, "users:read");
}

export function isPlatformMetric(metric: Pick<Metric, "ownerKind" | "slug">): boolean {
  return metric.ownerKind === "platform" || PRODUCT_METRIC_SLUGS.has(metric.slug);
}

function stableAccountMetricId(accountId: string, slug: string, namespace: string): string {
  return `metric_${namespace}_${createHash("sha256").update(`${accountId}:${slug}`).digest("hex").slice(0, 24)}`;
}

function dayKeys(start: Date, end: Date): string[] {
  const startDate = userDateStr(start);
  // end is exclusive half-open; last included day is the day before end when end is midnight,
  // otherwise the day of end-1ms.
  const lastIncluded = new Date(end.getTime() - 1);
  const endDate = userDateStr(lastIncluded);
  if (endDate < startDate) return [];
  const days: string[] = [];
  const cursor = new Date(`${startDate}T12:00:00Z`);
  const last = new Date(`${endDate}T12:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function samplesFromDayMap(
  metric: Metric,
  dayMap: Map<string, number>,
  range: { start: Date; end: Date },
  sourceRef: string,
): MetricSample[] {
  const days = dayKeys(range.start, range.end);
  const now = new Date().toISOString();
  return days.map((date) => {
    const bounds = userDayBounds(date);
    return {
      id: `query_${metric.id}_${date}`,
      metricId: metric.id,
      accountId: metric.accountId ?? "",
      vaultId: metric.vaultId,
      value: dayMap.get(date) ?? 0,
      unit: metric.unit,
      observedAt: bounds.end.toISOString(),
      sourceRef,
      evidence: "Resolved at query time from the owning engagement producer.",
      periodStart: bounds.start.toISOString(),
      periodEnd: new Date(bounds.end.getTime() + 1).toISOString(),
      createdAt: now,
    };
  });
}

function singleRangeSample(
  metric: Metric,
  value: number,
  range: { start: Date; end: Date },
  sourceRef: string,
  evidence: string,
  identityPoint = false,
): MetricSample {
  const observedAt = identityPoint ? new Date().toISOString() : range.end.toISOString();
  return {
    id: `query_${metric.id}_${identityPoint ? observedAt : `${range.start.getTime()}_${range.end.getTime()}`}`,
    metricId: metric.id,
    accountId: metric.accountId ?? "",
    vaultId: metric.vaultId,
    value,
    unit: metric.unit,
    observedAt,
    sourceRef,
    evidence,
    periodStart: identityPoint ? null : range.start.toISOString(),
    periodEnd: identityPoint ? null : range.end.toISOString(),
    createdAt: observedAt,
  };
}

/**
 * Resolve an existing engagement definition on the real uniqueness key
 * (account, vault, slug) — metrics_account_vault_slug_uidx — or by stable id.
 */
async function findEngagementDefinitionId(
  accountId: string,
  vaultId: string | null | undefined,
  slug: string,
  desiredId: string,
): Promise<string | null> {
  const vaultPredicate =
    vaultId == null || vaultId === ""
      ? isNull(metrics.vaultId)
      : eq(metrics.vaultId, vaultId);
  const [byKey] = await db
    .select({ id: metrics.id })
    .from(metrics)
    .where(and(eq(metrics.accountId, accountId), vaultPredicate, eq(metrics.slug, slug)))
    .limit(1);
  if (byKey?.id) return byKey.id;

  const [byId] = await db
    .select({ id: metrics.id })
    .from(metrics)
    .where(eq(metrics.id, desiredId))
    .limit(1);
  return byId?.id ?? null;
}

/**
 * Provision one engagement Metric row. Idempotent on the real unique key
 * metrics_account_vault_slug_uidx (account, COALESCE(vault,''), slug), not only metrics.id.
 * Concurrent callers and pre-existing slug rows converge on the surviving id.
 */
async function ensureEngagementDefinition(
  principal: Principal,
  definition: (typeof ENGAGEMENT_DEFINITIONS)[number],
): Promise<string> {
  const accountId = principal.accountId!;
  const vaultId = principal.activeVaultId ?? null;
  const desiredId = stableAccountMetricId(accountId, definition.slug, "engagement");

  const existing = await findEngagementDefinitionId(accountId, vaultId, definition.slug, desiredId);
  if (existing) return existing;

  try {
    await db.insert(metrics).values({
      id: desiredId,
      scope: "user",
      ownerUserId: principal.userId,
      accountId,
      vaultId,
      createdByUserId: principal.userId,
      ownerKind: "account",
      ownerId: accountId,
      businessId: null,
      name: definition.name,
      slug: definition.slug,
      description: definition.description,
      unit: definition.unit,
      direction: "higher_is_better",
      samplePeriod: "daily",
      adapterKind: "internal",
      adapterConfig: { adapterKey: definition.adapterKey },
      status: "active",
    });
  } catch (error) {
    // PK or metrics_account_vault_slug_uidx race / pre-existing row — converge.
    if (!isUniqueViolationError(error)) throw error;
  }

  const resolved = await findEngagementDefinitionId(accountId, vaultId, definition.slug, desiredId);
  if (resolved) return resolved;
  // Insert succeeded without a subsequent read hit (should be rare); return desired id.
  return desiredId;
}

/** Provision engagement Metric rows for the current principal (Performance-style). */
export async function ensureEngagementMetrics(principal?: Principal): Promise<string[]> {
  const p = principal ?? requirePrincipal();
  const ids: string[] = [];
  for (const definition of ENGAGEMENT_DEFINITIONS) {
    if (definition.adapterKey === "wellness") {
      const active = await hasActiveWellnessAccess(p).catch(() => false);
      if (!active) continue;
    }
    ids.push(await ensureEngagementDefinition(p, definition));
  }
  return ids;
}

async function handleTasks(
  metric: Metric,
  range: { start: Date; end: Date },
  principal: Principal,
): Promise<MetricSeries> {
  const dayMap = await queryTaskSeries(range.start, range.end, principal);
  const samples = samplesFromDayMap(metric, dayMap, range, "internal/completed-tasks-query-v1");
  return {
    metric: { ...metric, latestSample: samples[samples.length - 1] ?? null },
    samples,
    valueStatus: "actual",
    coverage: { status: "finalized" },
  };
}

async function handleInteractions(
  metric: Metric,
  range: { start: Date; end: Date },
  principal: Principal,
): Promise<MetricSeries> {
  const startDate = userDateStr(range.start);
  const endDate = userDateStr(new Date(range.end.getTime() - 1));
  const { series, coverage } = await queryInteractionSeries(startDate, endDate, principal);
  const samples = samplesFromDayMap(
    metric,
    series,
    range,
    "internal/opportunity-interactions-query-v1",
  );
  return {
    metric: { ...metric, latestSample: samples[samples.length - 1] ?? null },
    samples,
    valueStatus: "actual",
    coverage,
  };
}

async function handleWellness(
  metric: Metric,
  range: { start: Date; end: Date },
  principal: Principal,
): Promise<MetricSeries | null> {
  const active = await hasActiveWellnessAccess(principal).catch(() => false);
  if (!active) {
    return {
      metric: { ...metric, latestSample: null },
      samples: [],
      valueStatus: "actual",
      coverage: { status: "unbound", reason: "Wellness Mod is inactive." },
    };
  }
  const dayMap = await queryWellnessSeries(range.start, range.end, principal);
  const samples = samplesFromDayMap(metric, dayMap, range, "internal/wellness-completions-query-v1");
  return {
    metric: { ...metric, latestSample: samples[samples.length - 1] ?? null },
    samples,
    valueStatus: "actual",
    coverage: { status: "finalized" },
  };
}

async function handleProduct(
  metric: Metric,
  range: { start: Date; end: Date },
  principal: Principal,
): Promise<MetricSeries> {
  if (!canReadPlatformMetrics(principal)) {
    throw Object.assign(new Error("Metric not found"), { status: 404 });
  }
  if (metric.slug === "meetings") {
    // Defensive: meetings must not land on the product adapter.
    const value = await countCompletedMeetingsWithNotesInRange(range.start, range.end);
    const sample = singleRangeSample(
      metric,
      value,
      range,
      "internal/meetings-query-v1",
      "Completed sessions with notes in the selected range.",
    );
    return {
      metric: { ...metric, latestSample: sample },
      samples: [sample],
      valueStatus: "actual",
      coverage: { status: "finalized" },
    };
  }

  if (metric.slug === "shipped-prs") {
    const dayMap = await queryMergedPrSeries(range.start, range.end);
    const samples = samplesFromDayMap(metric, dayMap, range, "internal/shipped-prs-query-v1");
    // Also expose a range total sample as latest for KPI/list consumers.
    const total = [...dayMap.values()].reduce((sum, n) => sum + n, 0);
    const totalSample = singleRangeSample(
      metric,
      total,
      range,
      "internal/shipped-prs-query-v1",
      "Merged mono PRs in the selected range (GitHub merged_at).",
    );
    return {
      metric: { ...metric, latestSample: totalSample },
      samples: samples.length > 0 ? samples : [totalSample],
      valueStatus: "actual",
      coverage: { status: "finalized" },
    };
  }

  const [{ sampleUsageRange }, { sampleIdentityRange, sampleIdentityStock }] = await Promise.all([
    import("../hours-used"),
    import("../identity-metrics"),
  ]);

  if (metric.slug === "accounts" || metric.slug === "registered-users") {
    const stock = await sampleIdentityStock();
    const value = metric.slug === "accounts" ? stock.accounts : stock.registeredUsers;
    const sample = singleRangeSample(
      metric,
      value,
      range,
      `internal/${metric.slug}-query-v1`,
      metric.slug === "accounts"
        ? "Count of identity accounts with status=active."
        : "Distinct users with a membership on an active (status=active) account.",
      true,
    );
    return {
      metric: { ...metric, latestSample: sample },
      samples: [sample],
      valueStatus: "actual",
      coverage: { status: "finalized" },
    };
  }

  // Platform-wide Hours Used / presence / new users — never pass principal accountId.
  const [usage, identity] = await Promise.all([
    sampleUsageRange(null, range.start, range.end),
    sampleIdentityRange(range.start, range.end),
  ]);
  const finalizesAt = new Date(range.end.getTime() + USAGE_LEASE_TAIL_MS);
  const rangeCoverage: MetricCoverage =
    finalizesAt.getTime() > Date.now()
      ? { status: "provisional", finalizesAt: finalizesAt.toISOString() }
      : { status: "finalized" };

  const valueBySlug: Record<string, number> = {
    "hours-used": usage.hoursUsed,
    "active-users": usage.activeUsers,
    "current-users": usage.currentUsers,
    "new-users": identity.newUsers,
  };
  const value = valueBySlug[metric.slug];
  if (value == null) {
    throw Object.assign(new Error(`No product handler for slug ${metric.slug}`), { status: 500 });
  }
  const coverage: MetricCoverage =
    metric.slug === "new-users"
      ? {
          status: "partial",
          availableFrom: identity.newUsersCoverage.availableFrom,
          reason: "Historical signup provenance is incomplete.",
        }
      : rangeCoverage;
  const sample = singleRangeSample(
    metric,
    value,
    range,
    `internal/${metric.slug}-query-v1`,
    "Resolved from the owning product system for the selected range.",
  );
  return {
    metric: { ...metric, latestSample: sample },
    samples: [sample],
    valueStatus: "actual",
    coverage,
  };
}

async function handleMeetings(
  metric: Metric,
  range: { start: Date; end: Date },
  _principal: Principal,
): Promise<MetricSeries> {
  const value = await countCompletedMeetingsWithNotesInRange(range.start, range.end);
  const sample = singleRangeSample(
    metric,
    value,
    range,
    "internal/meetings-query-v1",
    "Completed sessions with notes in the selected range.",
  );
  return {
    metric: { ...metric, latestSample: sample },
    samples: [sample],
    valueStatus: "actual",
    coverage: { status: "finalized" },
  };
}

export const METRIC_ADAPTER_HANDLERS: Record<string, MetricAdapterHandler> = {
  tasks: handleTasks,
  interactions: handleInteractions,
  wellness: handleWellness,
  product: handleProduct,
  meetings: handleMeetings,
};

export function adapterKeyOf(metric: Metric): string | null {
  const fromConfig = metric.adapterConfig?.adapterKey;
  if (typeof fromConfig === "string" && fromConfig.trim()) return fromConfig.trim();
  if (metric.slug === "meetings") return "meetings";
  if (isPlatformMetric(metric)) return "product";
  if (metric.slug === "completed-tasks") return "tasks";
  if (metric.slug === "opportunity-interactions") return "interactions";
  if (metric.slug === "wellness-completions") return "wellness";
  return null;
}

export function productCurrentDefinitions() {
  return PRODUCT_CURRENT_KEYS;
}

export async function stampPlatformOwnerOnProductMetrics(): Promise<number> {
  const { sql } = await import("drizzle-orm");
  const slugs = [...PRODUCT_METRIC_SLUGS];
  if (slugs.length === 0) return 0;
  const updated = await db.execute(sql`
    UPDATE metrics
    SET owner_kind = 'platform',
        owner_id = NULL,
        adapter_config = COALESCE(adapter_config, '{}'::jsonb) || '{"adapterKey":"product"}'::jsonb,
        updated_at = NOW()
    WHERE slug = ANY(ARRAY[${sql.join(
      slugs.map((slug) => sql`${slug}`),
      sql`, `,
    )}]::text[])
      AND (
        owner_kind IS DISTINCT FROM 'platform'
        OR COALESCE(adapter_config->>'adapterKey', '') IS DISTINCT FROM 'product'
      )
  `);
  const rowCount =
    typeof (updated as { rowCount?: number }).rowCount === "number"
      ? (updated as { rowCount: number }).rowCount
      : 0;
  if (rowCount > 0) {
    log.info("stamped platform ownerKind on product metrics", { rowCount, slugs });
  }
  return rowCount;
}
