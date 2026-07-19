import type { Express } from "express";
import { db } from "../db";
import { pool } from "../db";
import { healthMetrics, wellnessActivities, wellnessLogs, gratitudeEntries, learningEntries, reflectionEntries, DEFAULT_WELLNESS_ACTIVITIES } from "@shared/models/health";
import type { HealthMetric, InsertHealthMetric, WellnessActivity, WellnessLog, ActivityTrends, GratitudeEntry, LearningEntry, ReflectionEntry } from "@shared/models/health";
import { desc, eq, gte, lte, isNull, and, sql, asc, type SQL } from "drizzle-orm";
import { createLogger } from "../log";
import { requireAuth } from "../auth";
import { getCurrentPrincipalOrSystem } from "../principal-context";
import { combineWithSensitiveVisible, combineWithSensitiveWritable, sensitiveOwnershipValues } from "../sensitive-scope";
import { userDateStr, userDayBounds, userNoon, userPeriodBounds } from "../utils/user-time";
import { isUsingDefaultTimezone, getTimezone } from "../timezone";
import { isInWindow, validateWindow } from "@shared/wellness-window";

const log = createLogger("HealthRoutes");

const healthScopeColumns = { ownerUserId: healthMetrics.ownerUserId, principalAccountId: healthMetrics.principalAccountId };
const activityScopeColumns = { ownerUserId: wellnessActivities.ownerUserId, principalAccountId: wellnessActivities.principalAccountId };
const logScopeColumns = { ownerUserId: wellnessLogs.ownerUserId, principalAccountId: wellnessLogs.principalAccountId };
const gratitudeScopeColumns = { ownerUserId: gratitudeEntries.ownerUserId, principalAccountId: gratitudeEntries.principalAccountId };
const learningScopeColumns = { ownerUserId: learningEntries.ownerUserId, principalAccountId: learningEntries.principalAccountId };
const reflectionScopeColumns = { ownerUserId: reflectionEntries.ownerUserId, principalAccountId: reflectionEntries.principalAccountId };

function visibleHealth(predicate?: SQL): SQL { return combineWithSensitiveVisible(healthScopeColumns, predicate); }
function visibleActivity(predicate?: SQL): SQL { return combineWithSensitiveVisible(activityScopeColumns, predicate); }
function writableActivity(predicate?: SQL): SQL { return combineWithSensitiveWritable(activityScopeColumns, predicate); }
function visibleLog(predicate?: SQL): SQL { return combineWithSensitiveVisible(logScopeColumns, predicate); }
function writableLog(predicate?: SQL): SQL { return combineWithSensitiveWritable(logScopeColumns, predicate); }
function visibleGratitude(predicate?: SQL): SQL { return combineWithSensitiveVisible(gratitudeScopeColumns, predicate); }
function writableGratitude(predicate?: SQL): SQL { return combineWithSensitiveWritable(gratitudeScopeColumns, predicate); }
function visibleLearning(predicate?: SQL): SQL { return combineWithSensitiveVisible(learningScopeColumns, predicate); }
function writableLearning(predicate?: SQL): SQL { return combineWithSensitiveWritable(learningScopeColumns, predicate); }
function visibleReflection(predicate?: SQL): SQL { return combineWithSensitiveVisible(reflectionScopeColumns, predicate); }
function writableReflection(predicate?: SQL): SQL { return combineWithSensitiveWritable(reflectionScopeColumns, predicate); }

export async function queryHealthMetrics(opts: { type?: string; days?: number }): Promise<HealthMetric[]> {
  const days = opts.days ?? 30;
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = userDateStr(since);

  let query = db
    .select()
    .from(healthMetrics)
    .where(visibleHealth(gte(healthMetrics.date, sinceStr)))
    .orderBy(desc(healthMetrics.date))
    .$dynamic();

  if (opts.type) {
    query = query.where(eq(healthMetrics.metricType, String(opts.type)));
  }

  return query.limit(500);
}

export async function clearAllHealthMetrics(): Promise<number> {
  const deleted = await db.delete(healthMetrics).returning({ id: healthMetrics.id });
  return deleted.length;
}

export async function queryHealthSummary(): Promise<Record<string, { avg: number; latest: number; unit: string; count: number }>> {
  const since = new Date();
  since.setDate(since.getDate() - 7);
  const sinceStr = userDateStr(since);

  const rows = await db
    .select()
    .from(healthMetrics)
    .where(visibleHealth(gte(healthMetrics.date, sinceStr)))
    .orderBy(desc(healthMetrics.date))
    .limit(1000);

  const byType: Record<string, { values: number[]; unit: string }> = {};
  for (const row of rows) {
    if (!byType[row.metricType]) {
      byType[row.metricType] = { values: [], unit: row.unit };
    }
    byType[row.metricType].values.push(row.value);
  }

  const summary: Record<string, { avg: number; latest: number; unit: string; count: number }> = {};
  for (const [type, { values, unit }] of Object.entries(byType)) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    summary[type] = { avg: Math.round(avg * 10) / 10, latest: values[0], unit, count: values.length };
  }

  return summary;
}

function extractMetricRows(payload: any): any[] | null {
  if (!payload) return null;

  if (Array.isArray(payload)) {
    return payload;
  }

  if (typeof payload === "object") {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.metrics)) return payload.metrics;
    if (Array.isArray(payload.results)) return payload.results;
    if (Array.isArray(payload.items)) return payload.items;

    if (Array.isArray(payload.data?.metrics)) return payload.data.metrics;

    const keys = Object.keys(payload);
    for (const key of keys) {
      if (Array.isArray(payload[key]) && payload[key].length > 0 && typeof payload[key][0] === "object") {
        return payload[key];
      }
    }
  }

  return null;
}

function normalizeMetricRow(raw: any): { metricType: string; value: number; unit: string; source: string; date: string } | null {
  if (!raw || typeof raw !== "object") return null;

  const metricType = raw.name ?? raw.metricType ?? raw.metric_type ?? raw.metric ?? raw.type ?? null;
  if (!metricType) return null;

  const rawValue = raw.qty ?? raw.quantity ?? raw.value ?? raw.avg ?? raw.total ?? null;
  if (rawValue == null) return null;
  const value = Number(rawValue);
  if (isNaN(value)) return null;

  const rawDate = raw.date ?? raw.dateString ?? raw.date_string ?? raw.timestamp ?? raw.startDate ?? raw.start_date ?? null;
  if (!rawDate) return null;
  const date = String(rawDate).substring(0, 10);

  const unit = raw.units ?? raw.unit ?? raw.unitName ?? raw.unit_name ?? "";
  const source = raw.source ?? raw.sourceName ?? raw.source_name ?? "apple_health";

  return { metricType: String(metricType), value, unit: String(unit), source: String(source), date };
}

const VALID_CATEGORIES = ["daily_practice", "weekly_ritual", "monthly_renewal", "quarterly_reset", "annual_checkup"];

export function categoryFromInterval(days: number): string {
  if (days <= 1) return "daily_practice";
  if (days <= 7) return "weekly_ritual";
  if (days <= 30) return "monthly_renewal";
  if (days <= 90) return "quarterly_reset";
  return "annual_checkup";
}

export function computeActivityStatus(lastCompletedAt: Date | null, intervalDays: number): {
  status: "overdue" | "due_soon" | "on_track" | "never_done";
  urgency: number;
  daysSince: number | null;
  daysUntilDue: number | null;
} {
  if (!lastCompletedAt) {
    return { status: "never_done", urgency: 100, daysSince: null, daysUntilDue: null };
  }

  const nowLocal = userDateStr();
  const completedLocal = userDateStr(lastCompletedAt);
  const nowDate = new Date(nowLocal + "T00:00:00Z");
  const completedDate = new Date(completedLocal + "T00:00:00Z");
  const daysSince = Math.round((nowDate.getTime() - completedDate.getTime()) / (1000 * 60 * 60 * 24));
  const daysUntilDue = intervalDays - daysSince;
  const urgency = Math.round((daysSince / intervalDays) * 100);

  if (daysUntilDue < 0) {
    return { status: "overdue", urgency, daysSince, daysUntilDue };
  }
  if (daysUntilDue <= Math.max(1, Math.floor(intervalDays * 0.2))) {
    return { status: "due_soon", urgency, daysSince, daysUntilDue };
  }
  return { status: "on_track", urgency, daysSince, daysUntilDue };
}

export type ActivityPulse = "good" | "okay" | "danger" | "never_done";

const PULSE_WINDOW_BY_CATEGORY: Record<string, number> = {
  daily_practice: 5,
  weekly_ritual: 4,
  monthly_renewal: 2,
  quarterly_reset: 1,
  annual_checkup: 1,
};

export function pulseWindowSize(category: string): number {
  return PULSE_WINDOW_BY_CATEGORY[category] ?? 1;
}

export interface ActivityPulseResult {
  pulse: ActivityPulse;
  pulsePercent: number | null;
  rollingAvgIntervalDays: number | null;
  windowSize: number;
}

function parseLogDate(raw: Date | string | null | undefined): Date {
  if (raw instanceof Date) return raw;
  if (raw == null) return new Date(NaN);
  const s = String(raw);
  return s.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(s) ? new Date(s) : new Date(s + "Z");
}

export function computeActivityPulse(
  logs: { completedAt: Date | string }[],
  intervalDays: number,
  category: string,
  now: Date = new Date(),
): ActivityPulseResult {
  const windowSize = pulseWindowSize(category);

  if (!logs || logs.length === 0) {
    return { pulse: "never_done", pulsePercent: null, rollingAvgIntervalDays: null, windowSize };
  }

  const todayStr = userDateStr(now);
  const todayMs = new Date(todayStr + "T00:00:00Z").getTime();
  const dayMs = 86400000;

  const logDays = logs
    .map((l) => {
      const d = parseLogDate(l.completedAt);
      return new Date(userDateStr(d) + "T00:00:00Z").getTime();
    })
    .sort((a, b) => b - a)
    .slice(0, windowSize);

  const daysSinceLast = Math.max(0, (todayMs - logDays[0]) / dayMs);

  const gaps: number[] = [];
  gaps.push(daysSinceLast);
  for (let i = 0; i < logDays.length - 1; i++) {
    gaps.push((logDays[i] - logDays[i + 1]) / dayMs);
  }

  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

  // Treat the time since the most recent log as a partially-elapsed interval:
  // even with a perfect prior cadence, a daily habit not yet logged today should
  // not read 100%. The leading "open" gap is `daysSinceLast + 1` (i.e. if logged
  // today, this becomes 1 day; if logged yesterday, 2 days). Comparing the
  // target interval against the larger of the historical avg and this open gap
  // makes 100% require a same-day log for daily habits, while weekly/monthly
  // habits stay at 100% anywhere inside the current interval window.
  const openGap = daysSinceLast + 1;
  const effectiveGap = Math.max(avgGap, openGap);

  let pulsePercent: number;
  if (effectiveGap <= 0) {
    pulsePercent = 100;
  } else {
    pulsePercent = Math.min(100, Math.max(0, (intervalDays / effectiveGap) * 100));
  }

  let pulse: ActivityPulse;
  if (pulsePercent >= 80) pulse = "good";
  else if (pulsePercent >= 50) pulse = "okay";
  else pulse = "danger";

  return {
    pulse,
    pulsePercent: Math.round(pulsePercent),
    rollingAvgIntervalDays: Math.round(avgGap * 10) / 10,
    windowSize,
  };
}

export interface BucketPulseRollup {
  pulse: ActivityPulse | null;
  pulsePercent: number | null;
  goodCount: number;
  okayCount: number;
  dangerCount: number;
  neverDoneCount: number;
  total: number;
}

export function computeBucketRollup(
  activities: { category: string; pulse: ActivityPulse; pulsePercent?: number | null }[],
): Record<string, BucketPulseRollup> {
  const result: Record<string, BucketPulseRollup> = {};
  const cats = ["daily_practice", "weekly_ritual", "monthly_renewal", "quarterly_reset", "annual_checkup"];
  for (const cat of cats) {
    const inCat = activities.filter((a) => a.category === cat);
    const goodCount = inCat.filter((a) => a.pulse === "good").length;
    const okayCount = inCat.filter((a) => a.pulse === "okay").length;
    const dangerCount = inCat.filter((a) => a.pulse === "danger").length;
    const neverDoneCount = inCat.filter((a) => a.pulse === "never_done").length;
    const total = inCat.length;

    let pulse: ActivityPulse | null = null;
    let pulsePercent: number | null = null;
    if (total > 0) {
      const sum = inCat.reduce((acc, a) => acc + (a.pulsePercent ?? 0), 0);
      pulsePercent = Math.round(sum / total);
      if (pulsePercent >= 80) pulse = "good";
      else if (pulsePercent >= 50) pulse = "okay";
      else pulse = "danger";
    }

    result[cat] = { pulse, pulsePercent, goodCount, okayCount, dangerCount, neverDoneCount, total };
  }
  return result;
}

export async function queryWellnessActivities(): Promise<WellnessActivity[]> {
  return db
    .select()
    .from(wellnessActivities)
    .where(visibleActivity(isNull(wellnessActivities.archivedAt)))
    .orderBy(wellnessActivities.category, wellnessActivities.intervalDays, wellnessActivities.name);
}

export async function queryActivityStatus() {
  const activities = await queryWellnessActivities();

  const allLogRows = await db
    .select()
    .from(wellnessLogs)
    .where(visibleLog())
    .orderBy(desc(wellnessLogs.completedAt));

  const logsByActivity = new Map<number, { date: Date; tier: string | null; metricValue: number | null }[]>();
  for (const l of allLogRows) {
    const parsed = parseLogDate(l.completedAt);
    const list = logsByActivity.get(l.activityId) ?? [];
    list.push({ date: parsed, tier: l.tier ?? null, metricValue: l.metricValue ?? null });
    logsByActivity.set(l.activityId, list);
  }

  const now = new Date();
  const { start: todayStart, end: todayEnd } = userDayBounds(userDateStr(now));
  const todayStartMs = todayStart.getTime();
  const todayEndMs = todayEnd.getTime();

  return activities.map((a) => {
    const logs = logsByActivity.get(a.id) ?? [];
    const lastLog = logs[0] ?? null;
    const lastCompleted = lastLog?.date ?? null;
    const status = computeActivityStatus(lastCompleted, a.intervalDays);
    const pulse = computeActivityPulse(
      logs.map((l) => ({ completedAt: l.date })),
      a.intervalDays,
      a.category,
    );

    const doneToday = logs.some((l) => {
      const t = l.date.getTime();
      return t >= todayStartMs && t <= todayEndMs;
    });

    const { start: periodStart, end: periodEnd } = userPeriodBounds(a.category, now);
    const periodStartMs = periodStart.getTime();
    const periodEndMs = periodEnd.getTime();
    const doneForCurrentPeriod = logs.some((l) => {
      const t = l.date.getTime();
      return t >= periodStartMs && t <= periodEndMs;
    });

    return {
      ...a,
      lastCompletedAt: lastCompleted?.toISOString() ?? null,
      tier: lastLog?.tier ?? null,
      metricValue: lastLog?.metricValue ?? null,
      doneToday,
      doneForCurrentPeriod,
      inWindow: isInWindow(a.category, a.windowStart, a.windowEnd, now, getTimezone()),
      ...status,
      ...pulse,
    };
  });
}

export function buildActivityStatusWithBuckets<
  T extends { category: string; pulse: ActivityPulse; pulsePercent?: number | null },
>(activities: T[]): { activities: T[]; buckets: Record<string, BucketPulseRollup> } {
  const buckets = computeBucketRollup(
    activities.map((a) => ({ category: a.category, pulse: a.pulse, pulsePercent: a.pulsePercent ?? null })),
  );
  return { activities, buckets };
}

export async function queryActivityStatusWithBuckets() {
  const activities = await queryActivityStatus();
  return buildActivityStatusWithBuckets(activities);
}

export async function createWellnessActivity(data: {
  name: string;
  benefit?: string | null;
  risk?: string | null;
  estimatedMinutes?: number | null;
  estimatedCost?: number | null;
  intervalDays: number;
  requirements?: string | null;
  category?: string;
  linkedMetricType?: string | null;
  greatThreshold?: number | null;
  goodThreshold?: number | null;
  windowStart?: number | null;
  windowEnd?: number | null;
}): Promise<WellnessActivity> {
  if (!data.intervalDays || data.intervalDays < 1) throw new Error("intervalDays must be >= 1");
  const category = data.category || categoryFromInterval(data.intervalDays);
  if (!VALID_CATEGORIES.includes(category)) throw new Error(`category must be one of: ${VALID_CATEGORIES.join(", ")}`);
  const windowValidation = validateWindow(category, data.windowStart ?? null, data.windowEnd ?? null);
  if (!windowValidation.valid) throw new Error(windowValidation.error!);
  const [activity] = await db.insert(wellnessActivities).values({
    name: data.name,
    ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()),
    benefit: data.benefit ?? null,
    risk: data.risk ?? null,
    estimatedMinutes: data.estimatedMinutes ?? null,
    estimatedCost: data.estimatedCost ?? null,
    intervalDays: data.intervalDays,
    requirements: data.requirements ?? null,
    category,
    isDefault: false,
    linkedMetricType: data.linkedMetricType ?? null,
    greatThreshold: data.greatThreshold ?? null,
    goodThreshold: data.goodThreshold ?? null,
    windowStart: data.windowStart ?? null,
    windowEnd: data.windowEnd ?? null,
  }).returning();
  return activity;
}

export async function updateWellnessActivity(id: number, data: Partial<{
  name: string;
  benefit: string | null;
  risk: string | null;
  estimatedMinutes: number | null;
  estimatedCost: number | null;
  intervalDays: number;
  requirements: string | null;
  category: string;
  linkedMetricType: string | null;
  greatThreshold: number | null;
  goodThreshold: number | null;
  windowStart: number | null;
  windowEnd: number | null;
}>): Promise<{ activity: WellnessActivity; warning?: string } | null> {
  if (data.intervalDays !== undefined && data.intervalDays < 1) throw new Error("intervalDays must be >= 1");
  if (data.category !== undefined && !VALID_CATEGORIES.includes(data.category)) throw new Error(`category must be one of: ${VALID_CATEGORIES.join(", ")}`);

  let warning: string | undefined;
  const updates: Record<string, any> = { ...data };

  // If category is changing, null out window (semantics differ per category)
  if (data.category !== undefined) {
    const [current] = await db.select().from(wellnessActivities).where(visibleActivity(eq(wellnessActivities.id, id)));
    if (current && (current.windowStart != null || current.windowEnd != null) && data.windowStart === undefined && data.windowEnd === undefined) {
      updates.windowStart = null;
      updates.windowEnd = null;
      warning = "Window cleared because category changed. Reconfigure window for the new category.";
    }
  }

  // Validate window if being set
  if (updates.windowStart !== undefined || updates.windowEnd !== undefined) {
    const effectiveCategory = updates.category ?? (await db.select({ category: wellnessActivities.category }).from(wellnessActivities).where(visibleActivity(eq(wellnessActivities.id, id))).then(r => r[0]?.category));
    if (effectiveCategory) {
      const wStart = updates.windowStart !== undefined ? updates.windowStart : null;
      const wEnd = updates.windowEnd !== undefined ? updates.windowEnd : null;
      const v = validateWindow(effectiveCategory, wStart, wEnd);
      if (!v.valid) throw new Error(v.error!);
    }
  }

  const [activity] = await db
    .update(wellnessActivities)
    .set({ ...updates, updatedAt: new Date() })
    .where(writableActivity(eq(wellnessActivities.id, id)))
    .returning();
  if (!activity) return null;
  return { activity, warning };
}

export async function archiveWellnessActivity(id: number): Promise<WellnessActivity | null> {
  const [activity] = await db
    .update(wellnessActivities)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(writableActivity(eq(wellnessActivities.id, id)))
    .returning();
  return activity ?? null;
}

export async function logWellnessActivity(activityId: number, opts?: { notes?: string; completedAt?: Date }): Promise<WellnessLog | { duplicate: true }> {
  const notes = opts?.notes ?? null;
  const completedAt = opts?.completedAt;

  if (completedAt) {
    const dateStr = userDateStr(completedAt);
    const { start: dayStart, end: dayEnd } = userDayBounds(dateStr);
    const [existing] = await db
      .select()
      .from(wellnessLogs)
      .where(
        and(
          eq(wellnessLogs.activityId, activityId),
          visibleLog(),
          gte(wellnessLogs.completedAt, dayStart),
          lte(wellnessLogs.completedAt, dayEnd)
        )
      )
      .limit(1);

    if (existing) {
      return { duplicate: true };
    }

    const [entry] = await db.insert(wellnessLogs).values({
      activityId,
      notes,
      completedAt,
      ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()),
    }).returning();
    return entry;
  }

  const sixtySecondsAgo = new Date(Date.now() - 60_000);
  const [recent] = await db
    .select()
    .from(wellnessLogs)
    .where(
      and(
        eq(wellnessLogs.activityId, activityId),
        visibleLog(),
        gte(wellnessLogs.completedAt, sixtySecondsAgo)
      )
    )
    .limit(1);

  if (recent) {
    return { duplicate: true };
  }

  const [entry] = await db.insert(wellnessLogs).values({
    activityId,
    notes,
    completedAt: new Date(),
    ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()),
  }).returning();
  return entry;
}

const TIER_RANK: Record<string, number> = { great: 2, good: 1 };
function tierRank(tier: string | null): number {
  return tier ? (TIER_RANK[tier] ?? 0) : 0;
}

export async function upsertMetricCompletion(
  activityId: number,
  dateStr: string,
  tier: "great" | "good",
  metricValue: number,
): Promise<"inserted" | "upgraded" | "unchanged"> {
  const { start: dayStart, end: dayEnd } = userDayBounds(dateStr);
  const completedAt = userNoon(dateStr);
  const newRank = tierRank(tier);

  const lockKey = activityId * 100000 + parseInt(dateStr.replace(/-/g, "").slice(-5), 10);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);

    const { rows } = await client.query(
      `SELECT id, tier, metric_value FROM wellness_logs
       WHERE activity_id = $1 AND completed_at >= $2 AND completed_at <= $3
       LIMIT 1`,
      [activityId, dayStart, dayEnd]
    );

    const existing = rows[0];

    if (existing) {
      const existingRank = tierRank(existing.tier);
      if (newRank > existingRank) {
        await client.query(
          `UPDATE wellness_logs SET tier = $1, metric_value = $2 WHERE id = $3`,
          [tier, metricValue, existing.id]
        );
        await client.query("COMMIT");
        return "upgraded";
      }
      if (metricValue > (existing.metric_value ?? 0)) {
        await client.query(
          `UPDATE wellness_logs SET metric_value = $1 WHERE id = $2`,
          [metricValue, existing.id]
        );
      }
      await client.query("COMMIT");
      return "unchanged";
    }

    await client.query(
      `INSERT INTO wellness_logs (activity_id, notes, tier, metric_value, completed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [activityId, "Auto-logged from health metrics", tier, metricValue, completedAt]
    );
    await client.query("COMMIT");
    return "inserted";
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export type HealthMetricAffectedPair = { metricType: string; date: string };

export interface HealthMetricUpsertResult {
  inserted: number;
  bridge: { logged: number; upgraded: number };
  affectedPairs: HealthMetricAffectedPair[];
}

export async function processMetricCompletions(
  affectedPairs: HealthMetricAffectedPair[]
): Promise<{ logged: number; upgraded: number }> {
  if (affectedPairs.length === 0) return { logged: 0, upgraded: 0 };

  const activities = await queryWellnessActivities();
  const linkedActivities = activities.filter(a => a.linkedMetricType != null);
  if (linkedActivities.length === 0) return { logged: 0, upgraded: 0 };

  const uniquePairs = new Map<string, { metricType: string; date: string }>();
  for (const p of affectedPairs) {
    const key = `${p.metricType}:${p.date}`;
    if (!uniquePairs.has(key)) uniquePairs.set(key, p);
  }

  let logged = 0;
  let upgraded = 0;

  for (const { metricType, date } of uniquePairs.values()) {
    const matchingActivities = linkedActivities.filter(a => a.linkedMetricType === metricType);
    if (matchingActivities.length === 0) continue;

    const dailyMetrics = await db
      .select()
      .from(healthMetrics)
      .where(
        and(
          eq(healthMetrics.metricType, metricType),
          eq(healthMetrics.date, date)
        )
      );

    const totalValue = dailyMetrics.reduce((sum, m) => sum + m.value, 0);

    for (const activity of matchingActivities) {
      const greatThreshold = activity.greatThreshold;
      const goodThreshold = activity.goodThreshold;
      if (greatThreshold == null && goodThreshold == null) continue;

      let tier: "great" | "good" | null = null;
      if (greatThreshold != null && totalValue >= greatThreshold) {
        tier = "great";
      } else if (goodThreshold != null && totalValue >= goodThreshold) {
        tier = "good";
      }

      if (!tier) continue;

      const result = await upsertMetricCompletion(activity.id, date, tier, totalValue);
      if (result === "inserted") logged++;
      else if (result === "upgraded") upgraded++;
    }
  }

  return { logged, upgraded };
}

export async function upsertHealthMetricsAndProcessCompletions(
  rows: InsertHealthMetric[],
  opts: { logPrefix?: string; swallowCompletionErrors?: boolean } = {},
): Promise<HealthMetricUpsertResult> {
  let inserted = 0;
  const affectedPairs: HealthMetricAffectedPair[] = [];

  for (const row of rows) {
    try {
      await db.insert(healthMetrics).values({ ...row, ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()) }).onConflictDoNothing();
      // Preserve webhook behavior: this counts accepted insert attempts, including
      // conflict-noop duplicates, because callers historically observed this value.
      inserted++;
    } catch {
      // Preserve webhook behavior: invalid individual rows are ignored so a single
      // bad metric never prevents the rest of a health payload from landing.
    }
    affectedPairs.push({ metricType: row.metricType, date: row.date });
  }

  let bridge = { logged: 0, upgraded: 0 };
  if (affectedPairs.length > 0) {
    try {
      bridge = await processMetricCompletions(affectedPairs);
      if (bridge.logged > 0 || bridge.upgraded > 0) {
        log.log(`${opts.logPrefix || "[HealthBridge]"} Auto-completed: ${bridge.logged} logged, ${bridge.upgraded} upgraded`);
      }
    } catch (bridgeErr: any) {
      log.error(`${opts.logPrefix || "[HealthBridge]"} Error processing metric completions: ${bridgeErr.message}`);
      if (!opts.swallowCompletionErrors) throw bridgeErr;
    }
  }

  return { inserted, bridge, affectedPairs };
}

export async function seedMetricLinks(): Promise<void> {
  const metricLinks: Array<{ name: string; linkedMetricType: string; greatThreshold: number; goodThreshold: number }> = [
    { name: "Meditation", linkedMetricType: "mindful_minutes", greatThreshold: 10, goodThreshold: 5 },
    { name: "Steps", linkedMetricType: "steps", greatThreshold: 10000, goodThreshold: 5000 },
    { name: "Workout", linkedMetricType: "workout_minutes", greatThreshold: 45, goodThreshold: 20 },
  ];

  for (const link of metricLinks) {
    const [activity] = await db
      .select()
      .from(wellnessActivities)
      .where(eq(wellnessActivities.name, link.name))
      .limit(1);

    if (activity && activity.linkedMetricType == null) {
      await db
        .update(wellnessActivities)
        .set({
          linkedMetricType: link.linkedMetricType,
          greatThreshold: link.greatThreshold,
          goodThreshold: link.goodThreshold,
          updatedAt: new Date(),
        })
        .where(eq(wellnessActivities.id, activity.id));
      log.log(`[HealthBridge] Seeded metric link for ${link.name}: ${link.linkedMetricType}`);
    }
  }
}

export async function deleteWellnessLog(logId: number): Promise<boolean> {
  const result = await db
    .delete(wellnessLogs)
    .where(writableLog(eq(wellnessLogs.id, logId)))
    .returning();
  return result.length > 0;
}

export async function deleteWellnessLogByDate(activityId: number, dateStr: string): Promise<boolean> {
  const { start: startOfDay, end: endOfDay } = userDayBounds(dateStr);
  const result = await db
    .delete(wellnessLogs)
    .where(
      and(
        eq(wellnessLogs.activityId, activityId),
        writableLog(),
        gte(wellnessLogs.completedAt, startOfDay),
        lte(wellnessLogs.completedAt, endOfDay)
      )
    )
    .returning();
  return result.length > 0;
}

export function computeActivityTrends(logs: WellnessLog[], intervalDays: number): ActivityTrends {
  const todayStr = userDateStr();

  const dateList: string[] = [];
  for (let i = 0; i < 84; i++) {
    const d = new Date(todayStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - i);
    dateList.push(d.toISOString().slice(0, 10));
  }

  const completionMap: Record<string, boolean> = {};
  for (const ds of dateList) {
    completionMap[ds] = false;
  }

  const logDateStrs = logs.map(l => userDateStr(new Date(l.completedAt)));
  for (const dateStr of logDateStrs) {
    if (dateStr in completionMap) {
      completionMap[dateStr] = true;
    }
  }

  const computeRate = (days: number): number | null => {
    const expected = Math.floor(days / intervalDays);
    if (expected <= 0) return null;
    const sinceDate = new Date(todayStr + "T00:00:00Z");
    sinceDate.setUTCDate(sinceDate.getUTCDate() - days);
    const sinceStr = sinceDate.toISOString().slice(0, 10);
    const actual = logDateStrs.filter(ds => ds >= sinceStr).length;
    return Math.min(Math.round((actual / expected) * 100), 100);
  };

  const rate30d = computeRate(30);
  const rate90d = computeRate(90);

  const sortedLogs = [...logs].sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());

  const todayEpochDay = Math.floor(new Date(todayStr + "T00:00:00Z").getTime() / 86400000);
  const periodIndex = (date: Date): number => {
    const logDateStr = userDateStr(date);
    const logEpochDay = Math.floor(new Date(logDateStr + "T00:00:00Z").getTime() / 86400000);
    const daysDiff = todayEpochDay - logEpochDay;
    return Math.floor(daysDiff / intervalDays);
  };

  const periodsHit = new Set<number>();
  for (const l of sortedLogs) {
    periodsHit.add(periodIndex(new Date(l.completedAt)));
  }

  let currentStreak = 0;
  for (let p = 0; ; p++) {
    if (periodsHit.has(p)) {
      currentStreak++;
    } else {
      break;
    }
  }

  let longestStreak = 0;
  let streak = 0;
  const maxPeriod = sortedLogs.length > 0
    ? periodIndex(new Date(sortedLogs[sortedLogs.length - 1].completedAt))
    : 0;
  for (let p = 0; p <= maxPeriod; p++) {
    if (periodsHit.has(p)) {
      streak++;
      if (streak > longestStreak) longestStreak = streak;
    } else {
      streak = 0;
    }
  }

  return {
    currentStreak,
    longestStreak,
    rate30d,
    rate90d,
    completionMap,
    totalCompletions: logs.length,
  };
}

export async function queryActivityLogs(
  activityId?: number,
  limit = 50,
  date?: string,
): Promise<WellnessLog[]> {
  const conditions: any[] = [];
  if (activityId) conditions.push(eq(wellnessLogs.activityId, activityId));
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const { start, end } = userDayBounds(date);
    conditions.push(gte(wellnessLogs.completedAt, start));
    conditions.push(lte(wellnessLogs.completedAt, end));
  }

  const whereClause =
    conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);

  const filtered = db.select().from(wellnessLogs).where(visibleLog(whereClause));
  return filtered.orderBy(desc(wellnessLogs.completedAt)).limit(limit);
}

export async function upsertGratitudeEntry(content: string, date?: string): Promise<GratitudeEntry> {
  const dateStr = date || userDateStr();
  const [existing] = await db
    .select()
    .from(gratitudeEntries)
    .where(visibleGratitude(eq(gratitudeEntries.date, dateStr)))
    .limit(1);

  let entry: GratitudeEntry;
  if (existing) {
    const [updated] = await db
      .update(gratitudeEntries)
      .set({ content, updatedAt: new Date() })
      .where(writableGratitude(eq(gratitudeEntries.id, existing.id)))
      .returning();
    entry = updated;
  } else {
    const [inserted] = await db
      .insert(gratitudeEntries)
      .values({ content, date: dateStr, ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()) })
      .returning();
    entry = inserted;
  }

  const activities = await queryWellnessActivities();
  const gratitudeActivity = activities.find(a => a.name.toLowerCase() === "gratitude");
  if (gratitudeActivity) {
    const completedAt = userNoon(dateStr);
    await logWellnessActivity(gratitudeActivity.id, { completedAt });
  }

  return entry;
}

export async function getGratitudeEntry(date: string): Promise<GratitudeEntry | null> {
  const [entry] = await db
    .select()
    .from(gratitudeEntries)
    .where(visibleGratitude(eq(gratitudeEntries.date, date)))
    .limit(1);
  return entry ?? null;
}

export async function listGratitudeEntries(limit = 30, offset = 0): Promise<GratitudeEntry[]> {
  return db
    .select()
    .from(gratitudeEntries)
    .where(visibleGratitude())
    .orderBy(desc(gratitudeEntries.date))
    .limit(limit)
    .offset(offset);
}

export async function deleteGratitudeEntry(date: string): Promise<boolean> {
  const result = await db
    .delete(gratitudeEntries)
    .where(writableGratitude(eq(gratitudeEntries.date, date)))
    .returning();

  if (result.length === 0) return false;

  const activities = await queryWellnessActivities();
  const gratitudeActivity = activities.find(a => a.name.toLowerCase() === "gratitude");
  if (gratitudeActivity) {
    await deleteWellnessLogByDate(gratitudeActivity.id, date);
  }

  return true;
}

export async function upsertLearningEntry(content: string, date?: string): Promise<LearningEntry> {
  const dateStr = date || userDateStr();
  const [existing] = await db
    .select()
    .from(learningEntries)
    .where(visibleLearning(eq(learningEntries.date, dateStr)))
    .limit(1);

  let entry: LearningEntry;
  if (existing) {
    const [updated] = await db
      .update(learningEntries)
      .set({ content, updatedAt: new Date() })
      .where(writableLearning(eq(learningEntries.id, existing.id)))
      .returning();
    entry = updated;
  } else {
    const [inserted] = await db
      .insert(learningEntries)
      .values({ content, date: dateStr, ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()) })
      .returning();
    entry = inserted;
  }

  const activities = await queryWellnessActivities();
  const learningActivity = activities.find(a => a.name.toLowerCase() === "learning");
  if (learningActivity) {
    const completedAt = userNoon(dateStr);
    await logWellnessActivity(learningActivity.id, { completedAt });
  }

  return entry;
}

export async function getLearningEntry(date: string): Promise<LearningEntry | null> {
  const [entry] = await db
    .select()
    .from(learningEntries)
    .where(visibleLearning(eq(learningEntries.date, date)))
    .limit(1);
  return entry ?? null;
}

export async function listLearningEntries(limit = 30, offset = 0): Promise<LearningEntry[]> {
  return db
    .select()
    .from(learningEntries)
    .where(visibleLearning())
    .orderBy(desc(learningEntries.date))
    .limit(limit)
    .offset(offset);
}

export async function deleteLearningEntry(date: string): Promise<boolean> {
  const result = await db
    .delete(learningEntries)
    .where(writableLearning(eq(learningEntries.date, date)))
    .returning();

  if (result.length === 0) return false;

  const activities = await queryWellnessActivities();
  const learningActivity = activities.find(a => a.name.toLowerCase() === "learning");
  if (learningActivity) {
    await deleteWellnessLogByDate(learningActivity.id, date);
  }

  return true;
}

export async function upsertReflectionEntry(content: string, date?: string): Promise<ReflectionEntry> {
  const dateStr = date || userDateStr();
  const [existing] = await db
    .select()
    .from(reflectionEntries)
    .where(visibleReflection(eq(reflectionEntries.date, dateStr)))
    .limit(1);

  let entry: ReflectionEntry;
  if (existing) {
    const [updated] = await db
      .update(reflectionEntries)
      .set({ content, updatedAt: new Date() })
      .where(writableReflection(eq(reflectionEntries.id, existing.id)))
      .returning();
    entry = updated;
  } else {
    const [inserted] = await db
      .insert(reflectionEntries)
      .values({ content, date: dateStr, ...sensitiveOwnershipValues(getCurrentPrincipalOrSystem()) })
      .returning();
    entry = inserted;
  }

  const activities = await queryWellnessActivities();
  const reflectionActivity = activities.find(a => a.name.toLowerCase() === "reflection");
  if (reflectionActivity) {
    const completedAt = userNoon(dateStr);
    await logWellnessActivity(reflectionActivity.id, { completedAt });
  }

  return entry;
}

export async function getReflectionEntry(date: string): Promise<ReflectionEntry | null> {
  const [entry] = await db
    .select()
    .from(reflectionEntries)
    .where(visibleReflection(eq(reflectionEntries.date, date)))
    .limit(1);
  return entry ?? null;
}

export async function listReflectionEntries(limit = 30, offset = 0): Promise<ReflectionEntry[]> {
  return db
    .select()
    .from(reflectionEntries)
    .where(visibleReflection())
    .orderBy(desc(reflectionEntries.date))
    .limit(limit)
    .offset(offset);
}

export async function deleteReflectionEntry(date: string): Promise<boolean> {
  const result = await db
    .delete(reflectionEntries)
    .where(writableReflection(eq(reflectionEntries.date, date)))
    .returning();

  if (result.length === 0) return false;

  const activities = await queryWellnessActivities();
  const reflectionActivity = activities.find(a => a.name.toLowerCase() === "reflection");
  if (reflectionActivity) {
    await deleteWellnessLogByDate(reflectionActivity.id, date);
  }

  return true;
}

export async function registerWellnessRoutes(app: Express) {
  try {
    await seedMetricLinks();
  } catch (err: any) {
    log.error(`[HealthBridge] Failed to seed metric links on startup: ${err.message}`);
  }

  // Auto-seed any missing default wellness activities on boot
  try {
    for (const a of DEFAULT_WELLNESS_ACTIVITIES) {
      await pool.query(
        `INSERT INTO wellness_activities (name, benefit, risk, estimated_minutes, estimated_cost, interval_days, category, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         ON CONFLICT (name) DO NOTHING`,
        [a.name, a.benefit, a.risk, a.estimated_minutes, a.estimated_cost, a.interval_days, a.category]
      );
    }
  } catch (err: any) {
    log.error(`[HealthBridge] Failed to seed default activities on startup: ${err.message}`);
  }

  app.post("/api/health/webhook", async (req, res) => {
    try {
      const payload = req.body;

      const payloadStr = JSON.stringify(payload !== undefined ? payload : null);
      log.debug("Webhook received payload:", payloadStr ? payloadStr.substring(0, 2000) : "undefined");

      const rawRows = extractMetricRows(payload);

      if (!rawRows) {
        const shape = payload && typeof payload === "object"
          ? `top-level keys: [${Object.keys(payload).join(", ")}], type: object`
          : `type: ${Array.isArray(payload) ? "array" : typeof payload}`;
        log.warn(`Webhook rejected unrecognized payload shape: ${shape}`);
        return res.status(400).json({
          error: "Unrecognized payload format. Expected an array of metrics, or an object with a data/metrics array.",
          receivedShape: shape,
        });
      }

      let inserted = 0;
      const SLEEP_FIELDS: Record<string, string> = {
        totalSleep: "sleep_total",
        rem: "sleep_rem",
        deep: "sleep_deep",
        core: "sleep_core",
        awake: "sleep_awake",
        inBed: "sleep_in_bed",
      };

      function explodeSleepRow(obj: any, out: any[]) {
        const rawDate = obj.date ?? obj.dateString ?? obj.date_string ?? obj.timestamp ?? obj.startDate ?? obj.start_date ?? null;
        const source = obj.source ?? obj.sourceName ?? obj.source_name ?? "apple_health";
        for (const [field, metricName] of Object.entries(SLEEP_FIELDS)) {
          const v = obj[field];
          if (v == null) continue;
          const num = Number(v);
          if (isNaN(num)) continue;
          out.push({ name: metricName, qty: num, units: "hr", date: rawDate, source });
        }
      }

      const HEART_RATE_FIELDS: Record<string, string> = {
        Avg: "heart_rate_avg",
        Min: "heart_rate_min",
        Max: "heart_rate_max",
      };

      function explodeHeartRateRow(obj: any, out: any[]) {
        const rawDate = obj.date ?? obj.dateString ?? obj.date_string ?? obj.timestamp ?? obj.startDate ?? obj.start_date ?? null;
        const source = obj.source ?? obj.sourceName ?? obj.source_name ?? "apple_health";
        for (const [field, metricName] of Object.entries(HEART_RATE_FIELDS)) {
          const v = obj[field];
          if (v == null) continue;
          const num = Number(v);
          if (isNaN(num)) continue;
          out.push({ name: metricName, qty: num, units: "bpm", date: rawDate, source });
        }
      }

      const flattenedRows: any[] = [];
      for (const raw of rawRows) {
        const groupName = String(raw?.name ?? "").toLowerCase();
        if (raw && Array.isArray(raw.data) && raw.data.length > 0 && typeof raw.data[0] === "object") {
          if (groupName === "sleep_analysis") {
            for (const child of raw.data) {
              explodeSleepRow(child, flattenedRows);
            }
          } else if (groupName === "heart_rate") {
            for (const child of raw.data) {
              explodeHeartRateRow(child, flattenedRows);
            }
          } else {
            for (const child of raw.data) {
              flattenedRows.push({
                ...child,
                name: child.name ?? raw.name,
                units: child.units ?? raw.units,
                unit: child.unit ?? raw.unit,
              });
            }
          }
        } else if (raw && groupName === "sleep_analysis") {
          explodeSleepRow(raw, flattenedRows);
        } else if (raw && groupName === "heart_rate") {
          explodeHeartRateRow(raw, flattenedRows);
        } else {
          flattenedRows.push(raw);
        }
      }

      let dropped = 0;
      const rawNormalized: Array<{ metricType: string; value: number; unit: string; source: string; date: string }> = [];
      for (const raw of flattenedRows) {
        const row = normalizeMetricRow(raw);
        if (!row) {
          dropped++;
          if (dropped <= 5) {
            const name = raw?.name ?? raw?.metricType ?? raw?.metric_type ?? "unknown";
            const keys = raw && typeof raw === "object" ? Object.keys(raw).join(", ") : "n/a";
            log.debug(`Dropped metric: name=${name}, keys=[${keys}]`);
          }
          continue;
        }
        rawNormalized.push(row);
      }

      const dailyAgg = new Map<string, { metricType: string; value: number; unit: string; source: string; date: string }>();
      for (const row of rawNormalized) {
        const key = `${row.metricType}|${row.date}|${row.source}`;
        const existing = dailyAgg.get(key);
        if (existing) {
          existing.value += row.value;
        } else {
          dailyAgg.set(key, { ...row });
        }
      }
      const normalizedRows: InsertHealthMetric[] = Array.from(dailyAgg.values()).map(r => ({
        ...r,
        value: Math.round(r.value * 1000) / 1000,
      }));

      const upsertResult = await upsertHealthMetricsAndProcessCompletions(normalizedRows, {
        logPrefix: "[HealthBridge]",
        swallowCompletionErrors: true,
      });
      inserted = upsertResult.inserted;
      const bridgeResult = upsertResult.bridge;

      log.log(`Webhook ingested ${inserted}/${normalizedRows.length} daily aggregates (from ${flattenedRows.length} raw points, ${dropped} dropped, ${rawRows.length} raw groups)`);
      res.json({ ok: true, inserted, bridge: bridgeResult });
    } catch (error: any) {
      log.error("webhook error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/health/metrics", requireAuth, async (req, res) => {
    try {
      const { type, days = "30" } = req.query;
      const rows = await queryHealthMetrics({
        type: type ? String(type) : undefined,
        days: parseInt(String(days), 10),
      });
      res.json(rows);
    } catch (error: any) {
      log.error("metrics query error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/health/summary", requireAuth, async (_req, res) => {
    try {
      const summary = await queryHealthSummary();
      res.json(summary);
    } catch (error: any) {
      log.error("summary error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/health/metrics", requireAuth, async (_req, res) => {
    try {
      const deletedCount = await clearAllHealthMetrics();
      res.json({ ok: true, deletedCount });
    } catch (error: any) {
      log.error("delete metrics error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/wellness/activities", requireAuth, async (_req, res) => {
    try {
      const activities = await queryWellnessActivities();
      res.json(activities);
    } catch (error: any) {
      log.error("list activities error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/wellness/status", requireAuth, async (_req, res) => {
    try {
      if (isUsingDefaultTimezone()) {
        log.warn(
          `wellness status served with default timezone (${getTimezone()}); user has not set a timezone yet — daily/heatmap bucketing may be off`,
        );
      }
      const status = await queryActivityStatus();
      res.json(status);
    } catch (error: any) {
      log.error("activity status error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/wellness/pulse-buckets", requireAuth, async (_req, res) => {
    try {
      const { buckets } = await queryActivityStatusWithBuckets();
      res.json(buckets);
    } catch (error: any) {
      log.error("pulse buckets error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/wellness/activities", requireAuth, async (req, res) => {
    try {
      const { name, benefit, risk, estimatedMinutes, estimatedCost, intervalDays, requirements, category, linkedMetricType, greatThreshold, goodThreshold, windowStart, windowEnd } = req.body;
      if (!name || !intervalDays) {
        return res.status(400).json({ error: "name and intervalDays are required" });
      }
      const activity = await createWellnessActivity({
        name, benefit, risk, estimatedMinutes, estimatedCost, intervalDays, requirements, category,
        linkedMetricType, greatThreshold, goodThreshold, windowStart, windowEnd,
      });
      res.json(activity);
    } catch (error: any) {
      if (error.message?.includes("unique") || error.message?.includes("duplicate")) {
        return res.status(409).json({ error: `An activity named "${req.body.name}" already exists` });
      }
      if (error.message?.includes("intervalDays") || error.message?.includes("category must be") || error.message?.includes("window")) {
        return res.status(400).json({ error: error.message });
      }
      log.error("create activity error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/wellness/activities/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const result = await updateWellnessActivity(id, req.body);
      if (!result) return res.status(404).json({ error: "Activity not found" });
      const response: any = result.activity;
      if (result.warning) response._warning = result.warning;
      res.json(response);
    } catch (error: any) {
      if (error.message?.includes("unique") || error.message?.includes("duplicate")) {
        return res.status(409).json({ error: `An activity with that name already exists` });
      }
      if (error.message?.includes("intervalDays") || error.message?.includes("category must be") || error.message?.includes("window")) {
        return res.status(400).json({ error: error.message });
      }
      log.error("update activity error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/wellness/activities/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const activity = await archiveWellnessActivity(id);
      if (!activity) return res.status(404).json({ error: "Activity not found" });
      res.json(activity);
    } catch (error: any) {
      log.error("archive activity error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/wellness/load-defaults", requireAuth, async (_req, res) => {
    try {
      let inserted = 0;
      for (const a of DEFAULT_WELLNESS_ACTIVITIES) {
        const result = await pool.query(
          `INSERT INTO wellness_activities (name, benefit, risk, estimated_minutes, estimated_cost, interval_days, category, is_default)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true)
           ON CONFLICT (name) DO NOTHING`,
          [a.name, a.benefit, a.risk, a.estimated_minutes, a.estimated_cost, a.interval_days, a.category]
        );
        if (result.rowCount && result.rowCount > 0) inserted++;
      }
      await seedMetricLinks();
      res.json({ ok: true, inserted });
    } catch (error: any) {
      log.error("load defaults error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/wellness/log", requireAuth, async (req, res) => {
    try {
      const { activityId, notes, date } = req.body;
      if (!activityId) return res.status(400).json({ error: "activityId is required" });

      let completedAt: Date | undefined;
      if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
        const [y, m, d] = date.split("-").map(Number);
        const probe = new Date(Date.UTC(y, m - 1, d));
        if (isNaN(probe.getTime()) || probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
          return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
        }
        const todayStr = userDateStr();
        if (date > todayStr) return res.status(400).json({ error: "Future dates are not allowed" });
        completedAt = userNoon(date);
      }

      const result = await logWellnessActivity(activityId, { notes, completedAt });
      if ("duplicate" in result) {
        const msg = date
          ? "This activity was already logged for that date"
          : "This activity was already logged within the last 60 seconds";
        return res.status(409).json({ error: msg });
      }
      res.json(result);
    } catch (error: any) {
      log.error("log activity error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/wellness/logs/by-date", requireAuth, async (req, res) => {
    try {
      const { activityId, date } = req.body;
      if (!activityId || !date) return res.status(400).json({ error: "activityId and date required" });
      const deleted = await deleteWellnessLogByDate(activityId, date);
      if (!deleted) return res.status(404).json({ error: "No log found for that date" });
      res.json({ ok: true });
    } catch (error: any) {
      log.error("delete log by date error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/wellness/logs/:id", requireAuth, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid log ID" });
      const deleted = await deleteWellnessLog(id);
      if (!deleted) return res.status(404).json({ error: "Log not found" });
      res.json({ ok: true });
    } catch (error: any) {
      log.error("delete log error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/wellness/activities/:id/trends", requireAuth, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid activity ID" });

      const activities = await queryWellnessActivities();
      const activity = activities.find(a => a.id === id);
      if (!activity) return res.status(404).json({ error: "Activity not found" });

      const allLogs = await db
        .select()
        .from(wellnessLogs)
        .where(eq(wellnessLogs.activityId, id))
        .orderBy(desc(wellnessLogs.completedAt));
      const trends = computeActivityTrends(allLogs, activity.intervalDays);
      res.json(trends);
    } catch (error: any) {
      log.error("activity trends error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/wellness/logs", requireAuth, async (req, res) => {
    try {
      const activityId = req.query.activityId ? parseInt(String(req.query.activityId), 10) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const date = req.query.date ? String(req.query.date) : undefined;
      const logs = await queryActivityLogs(activityId, limit, date);
      res.json(logs);
    } catch (error: any) {
      log.error("query logs error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/wellness/gratitude", requireAuth, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 30;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
      const entries = await listGratitudeEntries(limit, offset);
      res.json(entries);
    } catch (error: any) {
      log.error("list gratitude error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/wellness/gratitude", requireAuth, async (req, res) => {
    try {
      const { content, date } = req.body;
      if (!content || typeof content !== "string" || !content.trim()) {
        return res.status(400).json({ error: "content is required" });
      }
      if (content.length > 5000) {
        return res.status(400).json({ error: "content must be 5000 characters or fewer" });
      }
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
      }
      const entry = await upsertGratitudeEntry(content.trim(), date);
      res.json(entry);
    } catch (error: any) {
      log.error("upsert gratitude error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/wellness/gratitude/:date", requireAuth, async (req, res) => {
    try {
      const dateStr = req.params.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
      }
      const deleted = await deleteGratitudeEntry(dateStr);
      if (!deleted) return res.status(404).json({ error: "No entry found for that date" });
      res.json({ ok: true });
    } catch (error: any) {
      log.error("delete gratitude error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // --- Learning entries ---
  app.get("/api/wellness/learning", requireAuth, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 30;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
      const entries = await listLearningEntries(limit, offset);
      res.json(entries);
    } catch (error: any) {
      log.error("list learning error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/wellness/learning", requireAuth, async (req, res) => {
    try {
      const { content, date } = req.body;
      if (!content || typeof content !== "string" || !content.trim()) {
        return res.status(400).json({ error: "content is required" });
      }
      if (content.length > 5000) {
        return res.status(400).json({ error: "content must be 5000 characters or fewer" });
      }
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
      }
      const entry = await upsertLearningEntry(content.trim(), date);
      res.json(entry);
    } catch (error: any) {
      log.error("upsert learning error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/wellness/learning/:date", requireAuth, async (req, res) => {
    try {
      const dateStr = req.params.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
      }
      const deleted = await deleteLearningEntry(dateStr);
      if (!deleted) return res.status(404).json({ error: "No entry found for that date" });
      res.json({ ok: true });
    } catch (error: any) {
      log.error("delete learning error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // --- Reflection entries ---
  app.get("/api/wellness/reflection", requireAuth, async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 30;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : 0;
      const entries = await listReflectionEntries(limit, offset);
      res.json(entries);
    } catch (error: any) {
      log.error("list reflection error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/wellness/reflection", requireAuth, async (req, res) => {
    try {
      const { content, date } = req.body;
      if (!content || typeof content !== "string" || !content.trim()) {
        return res.status(400).json({ error: "content is required" });
      }
      if (content.length > 5000) {
        return res.status(400).json({ error: "content must be 5000 characters or fewer" });
      }
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
      }
      const entry = await upsertReflectionEntry(content.trim(), date);
      res.json(entry);
    } catch (error: any) {
      log.error("upsert reflection error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/wellness/reflection/:date", requireAuth, async (req, res) => {
    try {
      const dateStr = req.params.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD" });
      }
      const deleted = await deleteReflectionEntry(dateStr);
      if (!deleted) return res.status(404).json({ error: "No entry found for that date" });
      res.json({ ok: true });
    } catch (error: any) {
      log.error("delete reflection error:", error.message);
      res.status(500).json({ error: error.message });
    }
  });
}
