import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { requireCurrentPrincipal } from "./principal-context";
import { principalHasPermission } from "./permissions";
import { combineWithSensitiveVisible, combineWithSensitiveWritable, sensitiveOwnershipValues } from "./sensitive-scope";
import { wellnessActivities, wellnessActivityTemplates, type WellnessActivity } from "@shared/models/health";
import { validateWindow } from "@shared/wellness-window";

const activityScope = { ownerUserId: wellnessActivities.ownerUserId, principalAccountId: wellnessActivities.principalAccountId };
const visible = (predicate?: any) => combineWithSensitiveVisible(activityScope, predicate);
const writable = (predicate?: any) => combineWithSensitiveWritable(activityScope, predicate);
const CATEGORIES = ["daily_practice", "weekly_ritual", "monthly_renewal", "quarterly_reset", "annual_checkup"];

export type ActivityMutation = {
  name?: string;
  benefit?: string | null;
  intervalDays?: number;
  category?: string;
  linkedMetricType?: string | null;
  greatThreshold?: number | null;
  goodThreshold?: number | null;
  windowStart?: number | null;
  windowEnd?: number | null;
};

type TemplatePayload = {
  name: string; benefit: string | null; intervalDays: number; category: string;
  linkedMetricType: string | null; greatThreshold: number | null; goodThreshold: number | null;
  windowStart: number | null; windowEnd: number | null; launchKind: string | null;
  launchTarget: string | null; completionSource: string | null;
};

function payloadRevision(payload: TemplatePayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function activityPayload(activity: WellnessActivity): TemplatePayload {
  return {
    name: activity.name, benefit: activity.benefit ?? null, intervalDays: activity.intervalDays,
    category: activity.category, linkedMetricType: activity.linkedMetricType ?? null,
    greatThreshold: activity.greatThreshold ?? null, goodThreshold: activity.goodThreshold ?? null,
    windowStart: activity.windowStart ?? null, windowEnd: activity.windowEnd ?? null,
    launchKind: activity.launchKind ?? null, launchTarget: activity.launchTarget ?? null,
    completionSource: activity.completionSource ?? null,
  };
}

function validateMutation(data: ActivityMutation): void {
  if (data.intervalDays !== undefined && data.intervalDays < 1) throw new Error("intervalDays must be >= 1");
  if (data.category !== undefined && !CATEGORIES.includes(data.category)) throw new Error(`category must be one of: ${CATEGORIES.join(", ")}`);
}

function payloadColumns(payload: TemplatePayload) {
  return {
    name: payload.name, benefit: payload.benefit, intervalDays: payload.intervalDays, category: payload.category,
    linkedMetricType: payload.linkedMetricType, greatThreshold: payload.greatThreshold, goodThreshold: payload.goodThreshold,
    windowStart: payload.windowStart, windowEnd: payload.windowEnd, launchKind: payload.launchKind,
    launchTarget: payload.launchTarget, completionSource: payload.completionSource,
  };
}

export async function reconcileWellnessActivityDefaults(): Promise<void> {
  const principal = requireCurrentPrincipal();
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) return;
  const templates = await db.select().from(wellnessActivityTemplates);
  for (const template of templates) {
    const payload = template.payload as TemplatePayload;
    const [linked] = await db.select().from(wellnessActivities).where(visible(eq(wellnessActivities.defaultTemplateId, template.id))).limit(1);
    if (template.retiredAt) {
      if (linked) await db.update(wellnessActivities).set({
        defaultTemplateId: null, appliedTemplateRevision: null, defaultUpdateState: null, isDefault: false, updatedAt: new Date(),
      }).where(writable(eq(wellnessActivities.id, linked.id)));
      continue;
    }
    if (!linked) {
      const [sameName] = await db.select().from(wellnessActivities).where(visible(and(eq(wellnessActivities.name, payload.name), isNull(wellnessActivities.archivedAt)))).limit(1);
      if (sameName) {
        const matches = payloadRevision(activityPayload(sameName)) === template.revision;
        await db.update(wellnessActivities).set({
          defaultTemplateId: template.id,
          appliedTemplateRevision: matches ? template.revision : null,
          defaultUpdateState: matches ? "following" : "update_available",
          isDefault: true,
          updatedAt: new Date(),
        }).where(writable(eq(wellnessActivities.id, sameName.id)));
      } else {
        await db.insert(wellnessActivities).values({
          ...sensitiveOwnershipValues(principal), ...payloadColumns(payload), isDefault: true,
          defaultTemplateId: template.id, appliedTemplateRevision: template.revision,
          defaultUpdateState: "following",
        }).onConflictDoNothing();
      }
      continue;
    }
    if (linked.appliedTemplateRevision === template.revision) continue;
    if (linked.defaultUpdateState === "following") {
      await db.update(wellnessActivities).set({
        ...payloadColumns(payload), appliedTemplateRevision: template.revision,
        defaultUpdateState: "following", isDefault: true, updatedAt: new Date(),
      }).where(writable(eq(wellnessActivities.id, linked.id)));
    } else {
      await db.update(wellnessActivities).set({ defaultUpdateState: "update_available", isDefault: true, updatedAt: new Date() })
        .where(writable(eq(wellnessActivities.id, linked.id)));
    }
  }
}

export async function listWellnessActivities(): Promise<WellnessActivity[]> {
  await reconcileWellnessActivityDefaults();
  return db.select().from(wellnessActivities).where(visible(isNull(wellnessActivities.archivedAt)))
    .orderBy(wellnessActivities.category, wellnessActivities.intervalDays, wellnessActivities.name);
}

export async function createWellnessActivityLocal(data: ActivityMutation & { name: string; intervalDays: number }): Promise<WellnessActivity> {
  validateMutation(data);
  const category = data.category ?? (data.intervalDays <= 1 ? "daily_practice" : data.intervalDays <= 7 ? "weekly_ritual" : data.intervalDays <= 30 ? "monthly_renewal" : data.intervalDays <= 90 ? "quarterly_reset" : "annual_checkup");
  const window = validateWindow(category, data.windowStart ?? null, data.windowEnd ?? null);
  if (!window.valid) throw new Error(window.error!);
  const [activity] = await db.insert(wellnessActivities).values({
    ...sensitiveOwnershipValues(requireCurrentPrincipal()), name: data.name, benefit: data.benefit ?? null,
    intervalDays: data.intervalDays, category, isDefault: false, linkedMetricType: data.linkedMetricType ?? null,
    greatThreshold: data.greatThreshold ?? null, goodThreshold: data.goodThreshold ?? null,
    windowStart: data.windowStart ?? null, windowEnd: data.windowEnd ?? null,
  }).returning();
  return activity;
}

export async function updateWellnessActivityLocal(id: number, data: ActivityMutation): Promise<{ activity: WellnessActivity; warning?: string } | null> {
  validateMutation(data);
  const [current] = await db.select().from(wellnessActivities).where(visible(eq(wellnessActivities.id, id))).limit(1);
  if (!current) return null;
  let warning: string | undefined;
  const updates: Record<string, unknown> = { ...data };
  if (data.category !== undefined && (current.windowStart != null || current.windowEnd != null) && data.windowStart === undefined && data.windowEnd === undefined) {
    updates.windowStart = null; updates.windowEnd = null;
    warning = "Window cleared because category changed. Reconfigure window for the new category.";
  }
  const category = String(updates.category ?? current.category);
  if (updates.windowStart !== undefined || updates.windowEnd !== undefined) {
    const check = validateWindow(category, (updates.windowStart as number | null | undefined) ?? null, (updates.windowEnd as number | null | undefined) ?? null);
    if (!check.valid) throw new Error(check.error!);
  }
  if (current.defaultTemplateId) updates.defaultUpdateState = "customized";
  const [activity] = await db.update(wellnessActivities).set({ ...updates, updatedAt: new Date() })
    .where(writable(eq(wellnessActivities.id, id))).returning();
  return activity ? { activity, warning } : null;
}

export async function archiveWellnessActivityLocal(id: number): Promise<WellnessActivity | null> {
  const [activity] = await db.update(wellnessActivities).set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(writable(eq(wellnessActivities.id, id))).returning();
  return activity ?? null;
}

function requireCatalogPublisher(): { userId: string } {
  const principal = requireCurrentPrincipal();
  if (principal.actorType !== "user" || !principal.userId || !principalHasPermission(principal, "build:write")) {
    throw Object.assign(new Error("Only an authenticated human with build:write may publish Wellness defaults"), { status: 403 });
  }
  return { userId: principal.userId };
}

export async function publishActivityAsDefault(activityId: number): Promise<WellnessActivity> {
  const { userId } = requireCatalogPublisher();
  const [activity] = await db.select().from(wellnessActivities).where(visible(eq(wellnessActivities.id, activityId))).limit(1);
  if (!activity) throw Object.assign(new Error("Activity not found"), { status: 404 });
  const payload = activityPayload(activity);
  const revision = payloadRevision(payload);
  const stableKey = activity.defaultTemplateId ? null : `published-${randomUUID()}`;
  const template = activity.defaultTemplateId
    ? (await db.update(wellnessActivityTemplates).set({ name: payload.name, payload, revision, retiredAt: null, publishedByUserId: userId, updatedAt: new Date() }).where(eq(wellnessActivityTemplates.id, activity.defaultTemplateId)).returning())[0]
    : (await db.insert(wellnessActivityTemplates).values({ stableKey: stableKey!, name: payload.name, payload, revision, publishedByUserId: userId }).returning())[0];
  if (!template) throw new Error("Default template publication failed");
  const [updated] = await db.update(wellnessActivities).set({
    defaultTemplateId: template.id, appliedTemplateRevision: revision, defaultUpdateState: "following", isDefault: true, updatedAt: new Date(),
  }).where(writable(eq(wellnessActivities.id, activityId))).returning();
  return updated;
}

export async function retireActivityDefault(activityId: number): Promise<WellnessActivity> {
  requireCatalogPublisher();
  const [activity] = await db.select().from(wellnessActivities).where(visible(eq(wellnessActivities.id, activityId))).limit(1);
  if (!activity) throw Object.assign(new Error("Activity not found"), { status: 404 });
  if (activity.defaultTemplateId) {
    await db.update(wellnessActivityTemplates).set({ retiredAt: new Date(), updatedAt: new Date() }).where(eq(wellnessActivityTemplates.id, activity.defaultTemplateId));
  }
  const [updated] = await db.update(wellnessActivities).set({
    defaultTemplateId: null, appliedTemplateRevision: null, defaultUpdateState: null, isDefault: false, updatedAt: new Date(),
  }).where(writable(eq(wellnessActivities.id, activityId))).returning();
  return updated;
}
