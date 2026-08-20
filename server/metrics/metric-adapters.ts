/**
 * Code-owned Metric adapter handlers.
 *
 * Composition `metricAdapters` contributions remain labels for the catalog.
 * Dispatch authority lives here: adapterKey → handler. Unknown keys fall
 * through to warehouse metric_samples in queryMetric.
 */
import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { kpis, metrics } from "@shared/schema";
import {
  metricAdapterKeyOf,
  type Metric,
  type MetricCoverage,
  type MetricSample,
  type MetricSeries,
} from "@shared/models/metrics";
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
  queryAchievedGoalSeries,
  queryInteractionSeries,
  queryTaskSeries,
  queryWellnessSeries,
} from "./engagement-series";
import { createLogger } from "../log";
import {
  identityStockCanAnswerRange,
  isExpressionPlan,
  type ExpressionPlan,
} from "./expression-plan";

const log = createLogger("MetricAdapters");
const expressionVisit = new AsyncLocalStorage<Set<string>>();

export const PRODUCT_METRIC_SLUGS = new Set([
  "hours-used",
  "active-users",
  "current-users",
  "new-users",
  "accounts",
  "registered-users",
  "shipped-prs",
  "user-memory",
  "achieved-goals",
  "net-new-active-users",
  "mantra-meetings",
  "net-promoter-score",
  "activation-rate",
  "monthly-account-churn",
  // Legacy slug retained only so stamp/rename heals still match pre-rename rows.
  "monthly-customer-churn",
]);

/**
 * Resolve the product producer key for handleProduct.
 * Prefer stamped plan/key; fall back to slug (including company Meetings slug).
 */
function productProducerKey(metric: Metric): string {
  const config = metric.adapterConfig ?? {};
  const plan = config.plan;
  if (
    plan
    && typeof plan === "object"
    && !Array.isArray(plan)
    && (plan as { type?: unknown }).type === "producer"
    && typeof (plan as { key?: unknown }).key === "string"
  ) {
    return String((plan as { key: string }).key).trim();
  }
  if (typeof config.producerKey === "string" && config.producerKey.trim()) {
    return config.producerKey.trim();
  }
  if (typeof config.key === "string" && config.key.trim()) {
    return config.key.trim();
  }
  return metric.slug;
}

/** Meetings engagement slug remains principal-scoped; mantra-meetings is product. */
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
  {
    slug: "personal-achieved-goals",
    name: "Achieved Goals",
    description: "Goals you marked achieved in the selected range.",
    unit: "goals",
    adapterKey: "goals",
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

export function canReadSystemMetrics(principal: Principal): boolean {
  return principalHasPermission(principal, "system:read");
}

export function isPlatformMetric(metric: Pick<Metric, "ownerKind" | "slug">): boolean {
  return metric.ownerKind === "platform" || PRODUCT_METRIC_SLUGS.has(metric.slug);
}

export function isSystemMetric(metric: Pick<Metric, "ownerKind" | "adapterConfig">): boolean {
  const key = metric.adapterConfig?.adapterKey;
  return metric.ownerKind === "performance" || key === "performance";
}

export function metricIsVisibleTo(principal: Principal, metric: Pick<Metric, "ownerKind" | "slug" | "adapterConfig">): boolean {
  if (isPlatformMetric(metric) && !canReadPlatformMetrics(principal)) return false;
  if (isSystemMetric(metric) && !canReadSystemMetrics(principal)) return false;
  return true;
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
      adapterConfig: {
        adapterKey: definition.adapterKey,
        equation: definition.adapterKey,
        plan: { type: "producer", key: definition.adapterKey },
        producerKey: definition.adapterKey,
      },
      status: "active",
    });
  } catch (error) {
    // PK or metrics_account_vault_slug_uidx race / pre-existing row — converge.
    if (!isUniqueViolationError(error)) throw error;
  }

  const resolved = await findEngagementDefinitionId(accountId, vaultId, definition.slug, desiredId);
  if (resolved) {
    // Stamp producer equation on existing engagement leaves (idempotent).
    await db.execute(sql`
      UPDATE metrics
      SET adapter_config = COALESCE(adapter_config, '{}'::jsonb) || ${JSON.stringify({
        adapterKey: definition.adapterKey,
        equation: definition.adapterKey,
        plan: { type: "producer", key: definition.adapterKey },
        producerKey: definition.adapterKey,
      })}::jsonb,
          updated_at = NOW()
      WHERE id = ${resolved}
        AND (
          COALESCE(adapter_config->>'equation', '') IS DISTINCT FROM ${definition.adapterKey}
          OR adapter_config->'plan' IS NULL
        )
    `);
    return resolved;
  }
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

async function handleGoals(
  metric: Metric,
  range: { start: Date; end: Date },
  principal: Principal,
): Promise<MetricSeries> {
  const dayMap = await queryAchievedGoalSeries(range.start, range.end, principal);
  const samples = samplesFromDayMap(metric, dayMap, range, "internal/achieved-goals-query-v1");
  const total = [...dayMap.values()].reduce((sum, n) => sum + n, 0);
  const totalSample = singleRangeSample(
    metric,
    total,
    range,
    "internal/achieved-goals-query-v1",
    "Principal-visible goals marked achieved in the selected range.",
  );
  return {
    metric: { ...metric, latestSample: totalSample },
    samples: samples.length > 0 ? samples : [totalSample],
    valueStatus: "actual",
    coverage: { status: "finalized" },
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
  const producerKey = productProducerKey(metric);

  // Engagement meetings must not land on the product adapter; company Meetings does.
  if (producerKey === "meetings" || metric.slug === "meetings") {
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

  if (producerKey === "mantra-meetings") {
    const value = await countCompletedMeetingsWithNotesInRange(range.start, range.end);
    const sample = singleRangeSample(
      metric,
      value,
      range,
      "internal/mantra-meetings-query-v1",
      "Company scorecard: completed sessions with notes (recap-ready) in the selected range.",
    );
    return {
      metric: { ...metric, latestSample: sample },
      samples: [sample],
      valueStatus: "actual",
      coverage: { status: "finalized" },
    };
  }

  if (producerKey === "user-memory") {
    const {
      sampleUserMemoryStock,
      sampleUserMemoryStockAsOf,
      USER_MEMORY_STOCK_PARTIAL_REASON,
    } = await import("../user-memory-metric");
    const current = identityStockCanAnswerRange(range);
    const value = current
      ? await sampleUserMemoryStock()
      : await sampleUserMemoryStockAsOf(range.end);
    const sample = singleRangeSample(
      metric,
      value,
      range,
      "internal/user-memory-query-v1",
      current
        ? "Platform count of active canonical and linked vNext memory claims."
        : "User Memory reconstructed as of range.end from created and lifecycle timestamps.",
      current,
    );
    return {
      metric: { ...metric, latestSample: sample },
      samples: [sample],
      valueStatus: "actual",
      coverage: current
        ? { status: "finalized" }
        : { status: "partial", availableFrom: null, reason: USER_MEMORY_STOCK_PARTIAL_REASON },
    };
  }

  if (producerKey === "achieved-goals") {
    const { documentStoreDocuments } = await import("@shared/schema");
    const startIso = range.start.toISOString();
    const endIso = range.end.toISOString();
    const [row] = await db
      .select({
        value: sql<number>`count(*)::int`,
      })
      .from(documentStoreDocuments)
      .where(and(
        eq(documentStoreDocuments.documentType, "goal"),
        sql`COALESCE(${documentStoreDocuments.metadata}->>'status', '') = 'achieved'`,
        sql`COALESCE(${documentStoreDocuments.metadata}->>'completedAt', '') >= ${startIso}`,
        sql`COALESCE(${documentStoreDocuments.metadata}->>'completedAt', '') < ${endIso}`,
      ));
    const value = Number(row?.value ?? 0);
    const sample = singleRangeSample(
      metric,
      value,
      range,
      "internal/achieved-goals-platform-query-v1",
      "Platform goals marked achieved in the selected range. Count only — no titles or owners.",
    );
    return {
      metric: { ...metric, latestSample: sample },
      samples: [sample],
      valueStatus: "actual",
      coverage: { status: "finalized" },
    };
  }

  // NPS: average of stored users.nps_score when any scores exist; else unavailable.
  // Does not invent survey events. Collection writer is a later Feature.
  if (producerKey === "net-promoter-score") {
    const { users } = await import("@shared/schema");
    const [row] = await db
      .select({
        respondents: sql<number>`count(*)::int`,
        promoters: sql<number>`count(*) FILTER (WHERE ${users.npsScore} >= 9)::int`,
        detractors: sql<number>`count(*) FILTER (WHERE ${users.npsScore} <= 6)::int`,
      })
      .from(users)
      .where(sql`${users.npsScore} IS NOT NULL`);
    const respondents = Number(row?.respondents ?? 0);
    if (respondents <= 0) {
      return unavailableSeries(
        metric,
        "No users.nps_score values yet. NPS stays unmeasured until survey collection writes scores.",
      );
    }
    const promoters = Number(row?.promoters ?? 0);
    const detractors = Number(row?.detractors ?? 0);
    const value = ((promoters - detractors) / respondents) * 100;
    const sample = singleRangeSample(
      metric,
      value,
      range,
      "internal/nps-score-query-v1",
      `NPS from ${respondents} stored user score(s). Point-in-time over users.nps_score; not a period cohort until collection stamps response times.`,
    );
    return {
      metric: { ...metric, latestSample: sample },
      samples: [sample],
      valueStatus: "actual",
      coverage: { status: "partial", availableFrom: null, reason: "NPS is point-in-time over stored scores until response timestamps exist." },
    };
  }

  // Activation Rate: share of Accounts with activation_level = activated|retained.
  // Distinct from onboarding completed. Empty levels → unavailable (do not infer).
  if (producerKey === "activation-rate") {
    const { accounts } = await import("@shared/schema");
    const [row] = await db
      .select({
        measured: sql<number>`count(*) FILTER (WHERE ${accounts.activationLevel} IS NOT NULL)::int`,
        activated: sql<number>`count(*) FILTER (WHERE ${accounts.activationLevel} IN ('activated', 'retained'))::int`,
      })
      .from(accounts)
      .where(eq(accounts.status, "active"));
    const measured = Number(row?.measured ?? 0);
    if (measured <= 0) {
      return unavailableSeries(
        metric,
        "No accounts.activation_level values yet. Activation Rate stays unmeasured until commercial activation is written — not onboarding completed.",
      );
    }
    const activated = Number(row?.activated ?? 0);
    const value = (activated / measured) * 100;
    const sample = singleRangeSample(
      metric,
      value,
      range,
      "internal/activation-rate-query-v1",
      `Share of active Accounts with activation_level activated|retained among ${measured} measured seat(s). Not onboarding REGISTERED/ACTIVATED.`,
    );
    return {
      metric: { ...metric, latestSample: sample },
      samples: [sample],
      valueStatus: "actual",
      coverage: {
        status: "partial",
        availableFrom: null,
        reason: "Activation Rate is point-in-time over activation_level until lifecycle events exist.",
      },
    };
  }

  // Monthly Account Churn: paying = included_tokens IS NOT NULL.
  // Dark until cancel/non-paying lifecycle events exist — never fabricate from status noise.
  if (
    producerKey === "monthly-account-churn"
    || producerKey === "monthly-customer-churn"
    || metric.slug === "monthly-customer-churn"
  ) {
    return unavailableSeries(
      metric,
      "Monthly Account Churn needs paying-at-start and cancel/non-paying lifecycle events. Paying seat is included_tokens IS NOT NULL; identity status noise is not churn.",
    );
  }

  if (producerKey === "shipped-prs") {
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

  const [{ sampleUsageRange }, { sampleIdentityRange, sampleIdentityStock, sampleIdentityStockAsOf, IDENTITY_STOCK_PARTIAL_REASON }] = await Promise.all([
    import("../hours-used"),
    import("../identity-metrics"),
  ]);

  if (producerKey === "accounts" || producerKey === "registered-users") {
    const current = identityStockCanAnswerRange(range);
    const stock = current
      ? await sampleIdentityStock()
      : await sampleIdentityStockAsOf(range.end);
    const value = producerKey === "accounts" ? stock.accounts : stock.registeredUsers;
    const evidence = current
      ? (producerKey === "accounts"
        ? "Count of identity accounts with status=active."
        : "Distinct users with a membership on an active (status=active) account.")
      : (producerKey === "accounts"
        ? "Accounts reconstructed as of range.end from created and updated timestamps."
        : "Users reconstructed as of range.end from membership and account timestamps.");
    const sample = singleRangeSample(
      metric,
      value,
      range,
      `internal/${producerKey}-query-v1`,
      evidence,
      current,
    );
    return {
      metric: { ...metric, latestSample: sample },
      samples: [sample],
      valueStatus: "actual",
      coverage: current
        ? { status: "finalized" }
        : { status: "partial", availableFrom: null, reason: IDENTITY_STOCK_PARTIAL_REASON },
    };
  }

  if (producerKey === "net-new-active-users") {
    const durationMs = range.end.getTime() - range.start.getTime();
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return unavailableSeries(
        metric,
        "Net New Active Users requires a positive equal-length window.",
      );
    }
    const prevEnd = new Date(range.start.getTime());
    const prevStart = new Date(range.start.getTime() - durationMs);
    const [currentUsage, previousUsage] = await Promise.all([
      sampleUsageRange(null, range.start, range.end),
      sampleUsageRange(null, prevStart, prevEnd),
    ]);
    const value = currentUsage.activeUsers - previousUsage.activeUsers;
    const finalizesAt = new Date(range.end.getTime() + USAGE_LEASE_TAIL_MS);
    const coverage: MetricCoverage =
      finalizesAt.getTime() > Date.now()
        ? { status: "provisional", finalizesAt: finalizesAt.toISOString() }
        : { status: "finalized" };
    const sample = singleRangeSample(
      metric,
      value,
      range,
      "internal/net-new-active-users-query-v1",
      "Active Users(this window) minus Active Users(immediately previous equal-length window). Not Δ of Users or Accounts.",
    );
    return {
      metric: { ...metric, latestSample: sample },
      samples: [sample],
      valueStatus: "actual",
      coverage,
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

  const valueByKey: Record<string, number> = {
    "hours-used": usage.hoursUsed,
    "active-users": usage.activeUsers,
    "current-users": usage.currentUsers,
    "new-users": identity.newUsers,
  };
  const value = valueByKey[producerKey];
  if (value == null) {
    throw Object.assign(new Error(`No product handler for producer ${producerKey}`), { status: 500 });
  }
  const coverage: MetricCoverage =
    producerKey === "new-users"
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
    `internal/${producerKey}-query-v1`,
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

function unavailableSeries(metric: Metric, reason: string): MetricSeries {
  return {
    metric: { ...metric, latestSample: null },
    samples: [],
    valueStatus: "actual",
    coverage: { status: "unavailable", reason },
  };
}

function mergeExpressionCoverage(left: MetricCoverage, right: MetricCoverage): MetricCoverage {
  const rank: Record<MetricCoverage["status"], number> = {
    finalized: 1,
    partial: 2,
    provisional: 3,
    unbound: 4,
    unavailable: 5,
  };
  return rank[left.status] >= rank[right.status] ? left : right;
}

type ExpressionWalk =
  | { ok: true; value: number; coverage: MetricCoverage }
  | { ok: false; series: MetricSeries };

async function walkExpressionPlan(
  host: Metric,
  plan: ExpressionPlan,
  range: { start: Date; end: Date },
): Promise<ExpressionWalk> {
  if (plan.type === "literal") {
    return { ok: true, value: plan.value, coverage: { status: "finalized" } };
  }
  if (plan.type === "metric") {
    const { queryMetric } = await import("./core-engine");
    const series = await queryMetric(plan.metricId, range);
    if (series.coverage.status === "unavailable" || series.coverage.status === "unbound") {
      return { ok: false, series: { ...series, metric: { ...host, latestSample: null }, samples: [] } };
    }
    if (series.samples.length !== 1 || !Number.isFinite(series.samples[0]?.value)) {
      return {
        ok: false,
        series: unavailableSeries(host, "Operand did not answer the asked sample as a single value"),
      };
    }
    return { ok: true, value: series.samples[0].value, coverage: series.coverage };
  }
  const left = await walkExpressionPlan(host, plan.left, range);
  if (!left.ok) return left;
  const right = await walkExpressionPlan(host, plan.right, range);
  if (!right.ok) return right;
  if (plan.op === "/" && right.value === 0) {
    return { ok: false, series: unavailableSeries(host, "Divide by zero") };
  }
  const value =
    plan.op === "+" ? left.value + right.value
      : plan.op === "-" ? left.value - right.value
        : plan.op === "*" ? left.value * right.value
          : left.value / right.value;
  if (!Number.isFinite(value)) {
    return { ok: false, series: unavailableSeries(host, "Divide by zero") };
  }
  return { ok: true, value, coverage: mergeExpressionCoverage(left.coverage, right.coverage) };
}

async function handleExpression(
  metric: Metric,
  range: { start: Date; end: Date },
  _principal: Principal,
): Promise<MetricSeries> {
  const plan = metric.adapterConfig?.plan;
  if (!isExpressionPlan(plan)) {
    return unavailableSeries(metric, "Compiled plan missing");
  }
  const inherited = expressionVisit.getStore();
  if (inherited?.has(metric.id)) {
    return unavailableSeries(metric, "Equation contains a cycle.");
  }
  const visited = inherited ?? new Set<string>();
  visited.add(metric.id);
  const walked = await expressionVisit.run(visited, () => walkExpressionPlan(metric, plan, range));
  if (!walked.ok) return walked.series;
  const sample = singleRangeSample(
    metric,
    walked.value,
    range,
    "internal/expression-query-v1",
    "Resolved from the compiled plan over operand queryMetric samples.",
  );
  return {
    metric: { ...metric, latestSample: sample },
    samples: [sample],
    valueStatus: "actual",
    coverage: walked.coverage,
  };
}

export const METRIC_ADAPTER_HANDLERS: Record<string, MetricAdapterHandler> = {
  tasks: handleTasks,
  interactions: handleInteractions,
  wellness: handleWellness,
  goals: handleGoals,
  product: handleProduct,
  meetings: handleMeetings,
  expression: handleExpression,
};

export function adapterKeyOf(metric: Metric): string | null {
  return metricAdapterKeyOf(metric);
}

export function productCurrentDefinitions() {
  return PRODUCT_CURRENT_KEYS;
}

const PLATFORM_ACHIEVED_GOALS_DEFINITION = {
  key: "achieved-goals",
  name: "Achieved Goals",
  unit: "goals",
  description: "Platform goals marked achieved in the period.",
  direction: "higher_is_better" as const,
  samplePeriod: "daily" as const,
};

const PLATFORM_ACTIVE_USERS_DEFINITION = {
  key: "active-users",
  name: "Active Users",
  unit: "users",
  description:
    "Distinct users with Hours Used overlapping the asked range. Not Accounts, not registered Users stock, not connected-at-end Current Users.",
  direction: "higher_is_better" as const,
  samplePeriod: "custom" as const,
};

const PLATFORM_NET_NEW_ACTIVE_USERS_DEFINITION = {
  key: "net-new-active-users",
  name: "Net New Active Users",
  unit: "users",
  description:
    "Active Users in this window minus Active Users in the immediately previous equal-length window. Unequal windows are unavailable.",
  direction: "higher_is_better" as const,
  samplePeriod: "custom" as const,
};

const PLATFORM_MANTRA_MEETINGS_DEFINITION = {
  key: "mantra-meetings",
  name: "Meetings",
  unit: "meetings",
  description:
    "Company scorecard count of completed sessions with notes (recap-ready) in the selected range. Product producer — not principal engagement meetings.",
  direction: "higher_is_better" as const,
  samplePeriod: "custom" as const,
};

const PLATFORM_NPS_DEFINITION = {
  key: "net-promoter-score",
  name: "Net Promoter Score",
  unit: "score",
  description:
    "Standard NPS from stored users.nps_score (promoters 9–10 minus detractors 0–6). Unmeasured until survey collection writes scores. No collection writer in this producer.",
  direction: "higher_is_better" as const,
  samplePeriod: "monthly" as const,
};

const PLATFORM_ACTIVATION_RATE_DEFINITION = {
  key: "activation-rate",
  name: "Activation Rate",
  unit: "%",
  description:
    "Share of active Accounts with commercial activation_level activated|retained among measured seats. Not onboarding REGISTERED vs ACTIVATED. Unmeasured until activation_level is written.",
  direction: "higher_is_better" as const,
  samplePeriod: "monthly" as const,
};

const PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION = {
  key: "monthly-account-churn",
  name: "Monthly Account Churn",
  unit: "%",
  description:
    "Paying accounts (included_tokens IS NOT NULL) active at window start that cancel or become non-paying in the window, divided by paying at start. Dark until lifecycle events exist — never fabricate from identity status noise.",
  direction: "lower_is_better" as const,
  samplePeriod: "monthly" as const,
};

/** Catalog description overrides stamped onto existing product rows (idempotent). */
const PRODUCT_DESCRIPTION_BY_SLUG: Record<string, string> = {
  "achieved-goals": PLATFORM_ACHIEVED_GOALS_DEFINITION.description,
  "active-users": PLATFORM_ACTIVE_USERS_DEFINITION.description,
  "net-new-active-users": PLATFORM_NET_NEW_ACTIVE_USERS_DEFINITION.description,
  "mantra-meetings": PLATFORM_MANTRA_MEETINGS_DEFINITION.description,
  "net-promoter-score": PLATFORM_NPS_DEFINITION.description,
  "activation-rate": PLATFORM_ACTIVATION_RATE_DEFINITION.description,
  "monthly-account-churn": PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION.description,
  "monthly-customer-churn": PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION.description,
};

const HOURS_USED_PER_USER_SLUG = "hours-used-per-user";

async function ensureHoursUsedPerUserMetric(): Promise<void> {
  const { ensurePlatformBusinessMetrics } = await import("../metrics-storage");
  const refs = await ensurePlatformBusinessMetrics([
    {
      key: "hours-used",
      name: "Hours Used",
      unit: "hours",
      description: "Connected time unioned per authenticated user across tabs and devices.",
    },
    {
      key: "registered-users",
      name: "Users",
      unit: "users",
      description: "Distinct users with a membership on an active account.",
    },
  ]);
  const hours = refs.get("hours-used");
  const users = refs.get("registered-users");
  if (!hours || !users) return;

  const equation = `@metric:${hours.id} / @metric:${users.id}`;
  const plan = {
    type: "op" as const,
    op: "/" as const,
    left: { type: "metric" as const, metricId: hours.id },
    right: { type: "metric" as const, metricId: users.id },
  };
  const adapterConfig = {
    adapterKey: "expression",
    equation,
    plan,
    operandIds: [hours.id, users.id],
  };
  const id = `metric_hours_used_per_user_${hours.businessId}`;
  await db.execute(sql`
    INSERT INTO metrics (
      id, business_id, name, slug, description, unit, direction, sample_period, adapter_kind,
      adapter_config, status, scope, owner_user_id, account_id, vault_id, created_by_user_id,
      owner_kind, owner_id
    ) VALUES (
      ${id}, ${hours.businessId}, ${"Hours Used Per User"}, ${HOURS_USED_PER_USER_SLUG},
      ${"Hours Used divided by Users as of the asked sample."},
      ${"hours"}, ${"higher_is_better"}, ${"custom"}, ${"expression"},
      ${JSON.stringify(adapterConfig)}::jsonb, ${"active"}, ${"user"}, ${hours.ownerUserId},
      ${hours.accountId}, ${hours.vaultId ?? null}, ${hours.ownerUserId},
      ${"platform"}, NULL
    )
    ON CONFLICT DO NOTHING
  `);
  await db.execute(sql`
    UPDATE metrics
    SET adapter_kind = 'expression',
        owner_kind = 'platform',
        owner_id = NULL,
        adapter_config = ${JSON.stringify(adapterConfig)}::jsonb,
        updated_at = NOW()
    WHERE slug = ${HOURS_USED_PER_USER_SLUG}
      AND account_id = ${hours.accountId}
      AND (
        adapter_kind IS DISTINCT FROM 'expression'
        OR COALESCE(adapter_config->>'adapterKey', '') IS DISTINCT FROM 'expression'
        OR adapter_config->'plan' IS NULL
      )
      AND (
        adapter_kind = 'expression'
        OR COALESCE(adapter_config, '{}'::jsonb) = '{}'::jsonb
        OR COALESCE(adapter_config->>'adapterKey', '') = 'expression'
      )
  `);
}

/**
 * Rename Monthly Customer Churn → Monthly Account Churn on Metric + KPI rows.
 * Idempotent; keeps metric id so KPI bindings stay intact.
 */
export async function renameMonthlyCustomerChurnToAccountChurn(): Promise<number> {
  const metricUpdated = await db.execute(sql`
    UPDATE metrics
    SET name = ${PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION.name},
        slug = ${PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION.key},
        description = ${PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION.description},
        adapter_kind = 'internal',
        status = 'active',
        owner_kind = 'platform',
        owner_id = NULL,
        adapter_config = COALESCE(adapter_config, '{}'::jsonb) || ${JSON.stringify({
          adapterKey: "product",
          key: PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION.key,
          equation: PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION.key,
          plan: { type: "producer", key: PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION.key },
          producerKey: PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION.key,
        })}::jsonb,
        updated_at = NOW()
    WHERE id = 'metric_89a6d21438755204c41091be'
       OR slug = 'monthly-customer-churn'
       OR (slug = 'monthly-account-churn' AND (
         name IS DISTINCT FROM ${PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION.name}
         OR description IS DISTINCT FROM ${PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION.description}
         OR adapter_kind IS DISTINCT FROM 'internal'
         OR owner_kind IS DISTINCT FROM 'platform'
       ))
  `);
  const kpiUpdated = await db.execute(sql`
    UPDATE kpis
    SET name = ${"Monthly Account Churn"},
        slug = ${"monthly-account-churn-kpi"},
        description = ${"Lagging KPI for Multiply User Leverage: paying-account loss (included_tokens IS NOT NULL at window start that cancel or become non-paying). Not customer-headcount churn."},
        updated_at = NOW()
    WHERE id = 'kpi_cdfea8c022b9da620323e04b'
       OR slug = 'monthly-customer-churn-kpi'
       OR (slug = 'monthly-account-churn-kpi' AND name IS DISTINCT FROM ${"Monthly Account Churn"})
  `);
  const metricN =
    typeof (metricUpdated as { rowCount?: number }).rowCount === "number"
      ? (metricUpdated as { rowCount: number }).rowCount
      : 0;
  const kpiN =
    typeof (kpiUpdated as { rowCount?: number }).rowCount === "number"
      ? (kpiUpdated as { rowCount: number }).rowCount
      : 0;
  const total = metricN + kpiN;
  if (total > 0) {
    log.info("renamed Monthly Customer Churn → Monthly Account Churn", { metricN, kpiN });
  }
  return total;
}

/**
 * Stamp User Memory, Achieved Goals, Active Users, NNAU, company Meetings,
 * NPS, Activation Rate, and Monthly Account Churn as product rows.
 * ensure is idempotent on (account, vault, slug).
 */
export async function ensureProductCatalogDefinitions(): Promise<void> {
  const { ensurePlatformBusinessMetrics } = await import("../metrics-storage");
  const { USER_MEMORY_PLATFORM_DEFINITION } = await import("../user-memory-metric");
  await renameMonthlyCustomerChurnToAccountChurn();
  await ensurePlatformBusinessMetrics([
    USER_MEMORY_PLATFORM_DEFINITION,
    PLATFORM_ACHIEVED_GOALS_DEFINITION,
    PLATFORM_ACTIVE_USERS_DEFINITION,
    PLATFORM_NET_NEW_ACTIVE_USERS_DEFINITION,
    PLATFORM_MANTRA_MEETINGS_DEFINITION,
    PLATFORM_NPS_DEFINITION,
    PLATFORM_ACTIVATION_RATE_DEFINITION,
    PLATFORM_MONTHLY_ACCOUNT_CHURN_DEFINITION,
  ]);
  // Stamp existing fixed-id NPS / Activation Rate catalog rows onto product producers.
  await db.execute(sql`
    UPDATE metrics
    SET name = ${PLATFORM_NPS_DEFINITION.name},
        description = ${PLATFORM_NPS_DEFINITION.description},
        adapter_kind = 'internal',
        status = 'active',
        owner_kind = 'platform',
        owner_id = NULL,
        adapter_config = COALESCE(adapter_config, '{}'::jsonb) || ${JSON.stringify({
          adapterKey: "product",
          key: "net-promoter-score",
          equation: "net-promoter-score",
          plan: { type: "producer", key: "net-promoter-score" },
          producerKey: "net-promoter-score",
        })}::jsonb,
        updated_at = NOW()
    WHERE id = 'metric_ee71f6d2e2e3130a15952f80'
       OR slug = 'net-promoter-score'
  `);
  await db.execute(sql`
    UPDATE metrics
    SET name = ${PLATFORM_ACTIVATION_RATE_DEFINITION.name},
        description = ${PLATFORM_ACTIVATION_RATE_DEFINITION.description},
        adapter_kind = 'internal',
        status = 'active',
        owner_kind = 'platform',
        owner_id = NULL,
        adapter_config = COALESCE(adapter_config, '{}'::jsonb) || ${JSON.stringify({
          adapterKey: "product",
          key: "activation-rate",
          equation: "activation-rate",
          plan: { type: "producer", key: "activation-rate" },
          producerKey: "activation-rate",
        })}::jsonb,
        updated_at = NOW()
    WHERE id = 'metric_aa254f4fa3cb2955d22e30a6'
       OR slug = 'activation-rate'
  `);
  await ensureHoursUsedPerUserMetric();
  await ensureScorecardKpiWrappers();
}

/**
 * Company scorecard KPI wrappers — one Metric each, no standingObjectiveKey.
 * Retunes existing fixed-id KPIs and mints missing wrappers by metric slug.
 * Hours Used bands are monotonic for higher_is_better (bear under bull).
 * Dark Metrics stay unmeasured KPIs (no fabricated samples).
 */
type ScorecardKpiSpec = {
  /** Prefer fixed id when the row already exists in production. */
  id?: string;
  /** Legacy slug aliases to adopt before minting. */
  matchSlugs: string[];
  slug: string;
  name: string;
  metricSlug: string;
  /** Prefer fixed metric id when the catalog row is stable. */
  metricId?: string;
  description: string;
  targetLabel: string;
  cadence: string;
  period: "daily" | "weekly" | "monthly" | "live";
  ownerLabel: string;
  direction: "higher_is_better" | "lower_is_better";
  bullThreshold: number | null;
  bearThreshold: number | null;
  staleAfterHours: number;
  status: "active" | "draft";
};

const SCORECARD_KPI_SPECS: ScorecardKpiSpec[] = [
  {
    id: "kpi_1ebe9dee0b2927af71d6e905",
    matchSlugs: ["hours-used-kpi"],
    slug: "hours-used-kpi",
    name: "Hours Used",
    metricSlug: "hours-used",
    metricId: "metric_hours_used_1d52cbc6-d922-4afd-b5e8-0eeeb5babd47",
    description:
      "Lagging engagement KPI: authenticated connected hours (unioned per user). Bands are monotonic higher_is_better — bear is the floor, bull the stretch.",
    targetLabel: "Sustain at least 8 authenticated hours used per day",
    cadence: "Weekly",
    period: "weekly",
    ownerLabel: "Product",
    direction: "higher_is_better",
    // Was inverted (bear 250 > on-track 8). Scorer uses bear=under, bull=over only.
    bullThreshold: 300,
    bearThreshold: 8,
    staleAfterHours: 48,
    status: "active",
  },
  {
    id: "kpi_3de012b5b3b39b4eb6dde7a6",
    matchSlugs: ["achieved-goals-kpi"],
    slug: "achieved-goals-kpi",
    name: "Achieved Goals",
    metricSlug: "achieved-goals",
    metricId: "metric_a6f0ae8469109539b853fb22",
    description:
      "Platform goals marked achieved in the period (documentType=goal + status=achieved + completedAt in range). Not a customer-only filter.",
    targetLabel: "Platform goals reach achieved each month",
    cadence: "Monthly",
    period: "monthly",
    ownerLabel: "Product",
    direction: "higher_is_better",
    bullThreshold: 40,
    bearThreshold: 5,
    staleAfterHours: 1080,
    status: "active",
  },
  {
    id: "kpi_ee48891843f5c019cb4abc33",
    matchSlugs: ["activation-rate-kpi"],
    slug: "activation-rate-kpi",
    name: "Activation Rate",
    metricSlug: "activation-rate",
    metricId: "metric_aa254f4fa3cb2955d22e30a6",
    description:
      "Share of measured Accounts at commercial activation_level activated|retained. Not onboarding completed. Unmeasured until activation_level is written.",
    targetLabel: "Activate at least 60% of measured accounts",
    cadence: "Monthly",
    period: "monthly",
    ownerLabel: "Product",
    direction: "higher_is_better",
    bullThreshold: 75,
    bearThreshold: 30,
    staleAfterHours: 1080,
    status: "active",
  },
  {
    id: "kpi_cdfea8c022b9da620323e04b",
    matchSlugs: ["monthly-account-churn-kpi", "monthly-customer-churn-kpi"],
    slug: "monthly-account-churn-kpi",
    name: "Monthly Account Churn",
    metricSlug: "monthly-account-churn",
    metricId: "metric_89a6d21438755204c41091be",
    description:
      "Paying-account loss (included_tokens IS NOT NULL at window start that cancel or become non-paying). lower_is_better. Dark until lifecycle events exist.",
    targetLabel: "Keep monthly paying-account churn at or below 5%",
    cadence: "Monthly",
    period: "monthly",
    ownerLabel: "Customer Success",
    direction: "lower_is_better",
    // lower_is_better: bull when value <= bull (under), bear when value > bear (over)
    bullThreshold: 2,
    bearThreshold: 10,
    staleAfterHours: 1080,
    status: "active",
  },
  {
    matchSlugs: ["mantra-meetings-kpi", "meetings-kpi"],
    slug: "meetings-kpi",
    name: "Meetings",
    metricSlug: "mantra-meetings",
    metricId: "metric_0fabe2a49667c865bedc3cf7",
    description:
      "Company scorecard: recap-ready completed sessions with notes in the period. Product Meetings — not principal engagement meetings.",
    targetLabel: "Grow recap-ready meetings week over week",
    cadence: "Weekly",
    period: "weekly",
    ownerLabel: "Product",
    direction: "higher_is_better",
    bullThreshold: 15,
    bearThreshold: 3,
    staleAfterHours: 168,
    status: "active",
  },
  {
    matchSlugs: ["net-new-active-users-kpi", "nnau-kpi"],
    slug: "net-new-active-users-kpi",
    name: "Net New Active Users",
    metricSlug: "net-new-active-users",
    description:
      "Δ Active Users across adjacent equal-length windows. Not Δ of Users/Accounts stock. Unequal windows stay unavailable.",
    targetLabel: "Net new active users positive each month",
    cadence: "Monthly",
    period: "monthly",
    ownerLabel: "Growth",
    direction: "higher_is_better",
    bullThreshold: 5,
    bearThreshold: 0,
    staleAfterHours: 1080,
    status: "active",
  },
  {
    matchSlugs: ["user-memory-kpi"],
    slug: "user-memory-kpi",
    name: "User Memory",
    metricSlug: "user-memory",
    description:
      "Active canonical and linked vNext memory claims held across Mantra (platform stock).",
    targetLabel: "Grow durable user memory claims",
    cadence: "Weekly",
    period: "weekly",
    ownerLabel: "Product",
    direction: "higher_is_better",
    bullThreshold: 2000,
    bearThreshold: 500,
    staleAfterHours: 168,
    status: "active",
  },
  {
    matchSlugs: ["same-cohort-nrr-kpi", "nrr-kpi"],
    slug: "same-cohort-nrr-kpi",
    name: "Same-Cohort NRR",
    metricSlug: "same-cohort-nrr",
    metricId: "metric_e81c001644039d637eca4550",
    description:
      "Ending recurring revenue from the opening cohort divided by opening cohort revenue. Unmeasured until cohort snapshots exist.",
    targetLabel: "Same-cohort NRR at or above 100%",
    cadence: "Monthly",
    period: "monthly",
    ownerLabel: "Finance",
    direction: "higher_is_better",
    bullThreshold: 120,
    bearThreshold: 90,
    staleAfterHours: 1080,
    status: "active",
  },
  {
    matchSlugs: ["shipped-prs-kpi"],
    slug: "shipped-prs-kpi",
    name: "Shipped PRs",
    metricSlug: "shipped-prs",
    metricId: "metric_187a9b4d67a6842334327fd3",
    description:
      "Pull requests merged to main on Mantra mono from the merged-PR ledger. Production deploys are not equivalent.",
    targetLabel: "Ship at least 20 PRs per week",
    cadence: "Weekly",
    period: "weekly",
    ownerLabel: "Engineering",
    direction: "higher_is_better",
    bullThreshold: 40,
    bearThreshold: 10,
    staleAfterHours: 168,
    status: "active",
  },
  {
    matchSlugs: ["net-promoter-score-kpi", "nps-kpi"],
    slug: "nps-kpi",
    name: "NPS",
    metricSlug: "net-promoter-score",
    metricId: "metric_ee71f6d2e2e3130a15952f80",
    description:
      "Standard NPS from stored users.nps_score. Unmeasured until survey collection writes scores.",
    targetLabel: "NPS at or above 40",
    cadence: "Monthly",
    period: "monthly",
    ownerLabel: "Customer Success",
    direction: "higher_is_better",
    bullThreshold: 50,
    bearThreshold: 20,
    staleAfterHours: 1080,
    status: "active",
  },
];

export async function ensureScorecardKpiWrappers(): Promise<number> {
  const principal = getCurrentPrincipal();
  if (!principal?.userId || !principal.accountId) return 0;

  let touched = 0;
  for (const spec of SCORECARD_KPI_SPECS) {
    try {
      const metricRow = await resolveScorecardMetric(spec, principal.accountId);
      if (!metricRow) {
        log.warn("scorecard KPI skipped — metric missing", {
          kpiSlug: spec.slug,
          metricSlug: spec.metricSlug,
        });
        continue;
      }

      const existing = await findScorecardKpi(spec, principal.accountId);
      if (existing) {
        const updated = await db.execute(sql`
          UPDATE kpis
          SET metric_id = ${metricRow.id},
              name = ${spec.name},
              slug = ${spec.slug},
              description = ${spec.description},
              target_label = ${spec.targetLabel},
              cadence = ${spec.cadence},
              period = ${spec.period},
              samples = 1,
              style = 'line',
              owner_label = ${spec.ownerLabel},
              direction = ${spec.direction},
              bull_threshold = ${spec.bullThreshold},
              on_track_threshold = NULL,
              bear_threshold = ${spec.bearThreshold},
              stale_after_hours = ${spec.staleAfterHours},
              standing_objective_key = NULL,
              status = ${spec.status},
              updated_at = NOW()
          WHERE id = ${existing.id}
            AND (
              metric_id IS DISTINCT FROM ${metricRow.id}
              OR name IS DISTINCT FROM ${spec.name}
              OR slug IS DISTINCT FROM ${spec.slug}
              OR description IS DISTINCT FROM ${spec.description}
              OR target_label IS DISTINCT FROM ${spec.targetLabel}
              OR cadence IS DISTINCT FROM ${spec.cadence}
              OR period IS DISTINCT FROM ${spec.period}
              OR owner_label IS DISTINCT FROM ${spec.ownerLabel}
              OR direction IS DISTINCT FROM ${spec.direction}
              OR bull_threshold IS DISTINCT FROM ${spec.bullThreshold}
              OR bear_threshold IS DISTINCT FROM ${spec.bearThreshold}
              OR on_track_threshold IS NOT NULL
              OR stale_after_hours IS DISTINCT FROM ${spec.staleAfterHours}
              OR standing_objective_key IS NOT NULL
              OR status IS DISTINCT FROM ${spec.status}
            )
        `);
        const n =
          typeof (updated as { rowCount?: number }).rowCount === "number"
            ? (updated as { rowCount: number }).rowCount
            : 0;
        touched += n;
        continue;
      }

      const id = spec.id ?? `kpi_scorecard_${spec.slug.replace(/-/g, "_")}`;
      await db.execute(sql`
        INSERT INTO kpis (
          id, metric_id, name, slug, description, target_label, cadence, period, samples, style,
          owner_label, direction, bull_threshold, on_track_threshold, bear_threshold,
          stale_after_hours, standing_objective_key, status,
          scope, owner_user_id, account_id, vault_id, created_by_user_id
        ) VALUES (
          ${id}, ${metricRow.id}, ${spec.name}, ${spec.slug}, ${spec.description}, ${spec.targetLabel},
          ${spec.cadence}, ${spec.period}, 1, 'line',
          ${spec.ownerLabel}, ${spec.direction}, ${spec.bullThreshold}, NULL, ${spec.bearThreshold},
          ${spec.staleAfterHours}, NULL, ${spec.status},
          ${"user"}, ${principal.userId}, ${principal.accountId}, ${metricRow.vaultId}, ${principal.userId}
        )
        ON CONFLICT DO NOTHING
      `);
      touched += 1;
    } catch (error) {
      log.warn("scorecard KPI ensure failed", {
        kpiSlug: spec.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (touched > 0) {
    log.info("ensured scorecard KPI wrappers", { touched });
  }
  return touched;
}

async function resolveScorecardMetric(
  spec: ScorecardKpiSpec,
  accountId: string,
): Promise<{ id: string; vaultId: string | null } | null> {
  if (spec.metricId) {
    const [byId] = await db
      .select({ id: metrics.id, vaultId: metrics.vaultId })
      .from(metrics)
      .where(eq(metrics.id, spec.metricId))
      .limit(1);
    if (byId?.id) return { id: byId.id, vaultId: byId.vaultId ?? null };
  }
  const [bySlug] = await db
    .select({ id: metrics.id, vaultId: metrics.vaultId })
    .from(metrics)
    .where(and(eq(metrics.accountId, accountId), eq(metrics.slug, spec.metricSlug)))
    .orderBy(desc(metrics.updatedAt))
    .limit(1);
  return bySlug?.id ? { id: bySlug.id, vaultId: bySlug.vaultId ?? null } : null;
}

async function findScorecardKpi(
  spec: ScorecardKpiSpec,
  accountId: string,
): Promise<{ id: string } | null> {
  if (spec.id) {
    const [byId] = await db
      .select({ id: kpis.id })
      .from(kpis)
      .where(eq(kpis.id, spec.id))
      .limit(1);
    if (byId?.id) return byId;
  }
  const slugs = Array.from(new Set([spec.slug, ...spec.matchSlugs]));
  const rows = await db
    .select({ id: kpis.id, slug: kpis.slug })
    .from(kpis)
    .where(and(eq(kpis.accountId, accountId), inArray(kpis.slug, slugs)))
    .orderBy(desc(kpis.updatedAt))
    .limit(10);
  const preferred = rows.find((row) => row.slug === spec.slug) ?? rows[0];
  return preferred?.id ? { id: preferred.id } : null;
}

export async function stampPlatformOwnerOnProductMetrics(): Promise<number> {
  const { sql } = await import("drizzle-orm");
  // Rename before stamp so legacy monthly-customer-churn does not get a stale equation.
  await renameMonthlyCustomerChurnToAccountChurn();
  const slugs = [...PRODUCT_METRIC_SLUGS].filter((slug) => slug !== "monthly-customer-churn");
  if (slugs.length === 0) return 0;
  // Stamp platform owner + producer equation atom + internal/active for each product slug.
  // Existing catalog rows (e.g. scorecard Achieved Goals / mantra-meetings) keep their ids.
  let rowCount = 0;
  for (const slug of slugs) {
    const producerPlan = {
      adapterKey: "product",
      key: slug,
      equation: slug,
      plan: { type: "producer", key: slug },
      producerKey: slug,
    };
    const description = PRODUCT_DESCRIPTION_BY_SLUG[slug] ?? null;
    const updated = await db.execute(sql`
      UPDATE metrics
      SET owner_kind = 'platform',
          owner_id = NULL,
          adapter_kind = 'internal',
          status = 'active',
          adapter_config = COALESCE(adapter_config, '{}'::jsonb) || ${JSON.stringify(producerPlan)}::jsonb,
          description = COALESCE(${description}, description),
          updated_at = NOW()
      WHERE slug = ${slug}
        AND (
          owner_kind IS DISTINCT FROM 'platform'
          OR adapter_kind IS DISTINCT FROM 'internal'
          OR status IS DISTINCT FROM 'active'
          OR COALESCE(adapter_config->>'adapterKey', '') IS DISTINCT FROM 'product'
          OR COALESCE(adapter_config->>'equation', '') IS DISTINCT FROM ${slug}
          OR adapter_config->'plan' IS NULL
          OR (
            ${description} IS NOT NULL
            AND description IS DISTINCT FROM ${description}
          )
        )
    `);
    const n =
      typeof (updated as { rowCount?: number }).rowCount === "number"
        ? (updated as { rowCount: number }).rowCount
        : 0;
    rowCount += n;
  }
  if (rowCount > 0) {
    log.info("stamped platform ownerKind on product metrics", { rowCount, slugs });
  }
  return rowCount;
}
