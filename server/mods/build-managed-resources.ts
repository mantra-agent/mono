import crypto from "node:crypto";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { InsertTimer, Schedule, Timer } from "@shared/models/timers";
import {
  modInstallationResources,
  modInstallations,
  timers,
  type ModInstallationResourceRow,
  type ModInstallationRow,
} from "@shared/schema";
import type { DrizzleTx } from "../db";
import type { Principal } from "../principal";
import { ownedInsertValues } from "../scoped-storage";

export const BUILD_MANAGED_TIMER_KIND = "timer";
export const BUILD_REGRESSION_CONTRIBUTION_ID = "build.timer.post-acceptance-regression";
export const BUILD_REGRESSION_SYSTEM_KEY = "post-build-regression";

export interface BuildManagedTimerDefinition extends InsertTimer {
  contributionId: string;
  systemKey: string;
  legacyNames: readonly string[];
}

export const BUILD_MANAGED_TIMER_DEFINITIONS: readonly BuildManagedTimerDefinition[] = [
  {
    contributionId: "build.timer.reliability-sentinel-30m",
    systemKey: "build-reliability-sentinel-30m",
    legacyNames: ["Reliability Sentinel 30m", "Monitor Stability"],
    name: "Monitor Stability",
    description: "Every 30 minutes, inspect Mantra Web stage and production health, deployment/build state, runtime errors and recurring warnings, Sentry crashes when configured, and performance/context degradation. Deduplicate incidents and autonomously repair only bounded stage/main software defects; production remains observe-only and human-promoted.",
    type: "skill",
    skillId: "sentry",
    prompt: "",
    schedules: [{ id: "every-30-minutes", frequency: "every_x_minutes", interval: 30 }],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    contributionId: "build.timer.security-sentinel-weekly",
    systemKey: "build-security-sentinel-weekly",
    legacyNames: ["Security Sentinel Weekly", "Monitor Security"],
    name: "Monitor Security",
    description: "Weekly read-only Security Sentinel review of mantra-agent/mono main. Diff-only by default; full baseline review every 4th run or after 30 days. Immediate off-schedule runs are triggered manually after auth, data-ownership, execution, secret, webhook, or infrastructure changes.",
    type: "skill",
    skillId: "guard",
    prompt: "",
    schedules: [{ id: "weekly-monday", frequency: "weekly", daysOfWeek: ["mon"], timeOfDay: "08:00" }],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    contributionId: "build.timer.self-heal-nightly",
    systemKey: "build-self-heal-nightly",
    legacyNames: ["Self Heal", "Nightly Self Heal", "Production Error Repair"],
    name: "Self Heal",
    description: "Nightly Build-owned production error repair at 02:00 America/Chicago. Inspects canonical reliability evidence, repairs bounded source defects through the trusted engineering path, verifies with the production build, and merges completed fixes to main; production promotion remains separate.",
    type: "skill",
    skillId: "self-heal",
    prompt: "",
    schedules: [{ id: "build-self-heal-nightly-0200", frequency: "daily", timeOfDay: "02:00" }],
    enabled: true,
    timezone: "America/Chicago",
  },
  {
    contributionId: BUILD_REGRESSION_CONTRIBUTION_ID,
    systemKey: BUILD_REGRESSION_SYSTEM_KEY,
    legacyNames: ["Post-build Regression", "Post-acceptance Regression"],
    name: "Post-acceptance Regression",
    description: "Reviews existing open Issues after each accepted Build deployment and each genuinely new deployed build.",
    type: "skill",
    skillId: "regression",
    prompt: "",
    schedules: [{ id: "sys-skill-regression-next-build", frequency: "once", fireOnNextBuild: true }],
    enabled: true,
    timezone: "__USER_TZ__",
  },
] as const;

const resourceScope = {
  scope: modInstallationResources.scope,
  ownerUserId: modInstallationResources.ownerUserId,
  accountId: modInstallationResources.accountId,
};

function compactSchedule(schedule: Schedule): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schedule)
    .filter(([, value]) => value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]));
}

function uniqueSchedules(schedules: readonly Schedule[]): Schedule[] {
  const byId = new Map<string, Schedule>();
  for (const schedule of schedules) byId.set(schedule.id, schedule);
  return Array.from(byId.values());
}

function definitionPayload(definition: BuildManagedTimerDefinition, timezone: string) {
  return {
    contributionId: definition.contributionId,
    systemKey: definition.systemKey,
    name: definition.name,
    description: definition.description,
    type: definition.type,
    skillId: definition.skillId ?? null,
    prompt: definition.prompt ?? "",
    schedules: uniqueSchedules(definition.schedules ?? []).map(compactSchedule).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    enabled: true,
    timezone,
  };
}

export function buildManagedTimerDefinitionHash(definition: BuildManagedTimerDefinition, timezone: string): string {
  return crypto.createHash("sha256").update(JSON.stringify(definitionPayload(definition, timezone))).digest("hex");
}

function timerValues(definition: BuildManagedTimerDefinition, timezone: string, now: Date) {
  return {
    name: definition.name,
    description: definition.description,
    type: definition.type,
    prompt: definition.prompt ?? "",
    skillId: definition.skillId ?? null,
    systemKey: definition.systemKey,
    schedules: uniqueSchedules(definition.schedules ?? []),
    enabled: true,
    timezone,
    updatedAt: now,
  };
}

function userTimerOwner(principal: Principal) {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("Build-managed Timer materialization requires a user principal");
  }
  return and(
    eq(timers.scope, "user"),
    eq(timers.ownerUserId, principal.userId),
    eq(timers.accountId, principal.accountId),
  )!;
}

function generateTimerId(): string {
  return `mod-${crypto.randomUUID()}`;
}

async function adoptOrCreateTimer(
  tx: DrizzleTx,
  principal: Principal,
  definition: BuildManagedTimerDefinition,
  timezone: string,
): Promise<string> {
  const owner = userTimerOwner(principal);
  const candidates = await tx.select().from(timers).where(and(owner, or(
    eq(timers.systemKey, definition.systemKey),
    inArray(timers.name, [...definition.legacyNames]),
  ))).orderBy(asc(timers.createdAt), asc(timers.id)).for("update");
  const canonical = candidates[0];
  const now = new Date();
  if (canonical) {
    await tx.update(timers).set(timerValues(definition, timezone, now)).where(and(owner, eq(timers.id, canonical.id)));
    const duplicates = candidates.slice(1).map((row) => row.id);
    if (duplicates.length > 0) {
      await tx.update(timers).set({ enabled: false, updatedAt: now }).where(and(owner, inArray(timers.id, duplicates)));
    }
    return canonical.id;
  }
  const [created] = await tx.insert(timers).values({
    id: generateTimerId(),
    ...timerValues(definition, timezone, now),
    scope: "user",
    ownerUserId: principal.userId!,
    accountId: principal.accountId!,
    instanceId: principal.instanceId ?? null,
    createdAt: now,
  }).returning({ id: timers.id });
  if (!created) throw new Error(`Build-managed Timer creation failed: ${definition.contributionId}`);
  return created.id;
}

export async function materializeBuildManagedResources(
  tx: DrizzleTx,
  principal: Principal,
  installation: ModInstallationRow,
  timezone: string,
): Promise<ModInstallationResourceRow[]> {
  const rows: ModInstallationResourceRow[] = [];
  const activeContributionIds = BUILD_MANAGED_TIMER_DEFINITIONS.map((definition) => definition.contributionId);
  const staleResources = await tx.select().from(modInstallationResources).where(and(
    eq(modInstallationResources.installationId, installation.id),
    eq(modInstallationResources.ownerUserId, principal.userId!),
    eq(modInstallationResources.accountId, principal.accountId!),
    eq(modInstallationResources.resourceKind, BUILD_MANAGED_TIMER_KIND),
  )).for("update");
  const stale = staleResources.filter((resource) => !activeContributionIds.includes(resource.contributionId));
  if (stale.length > 0) {
    await tx.update(timers).set({ enabled: false, updatedAt: new Date() }).where(and(
      userTimerOwner(principal),
      inArray(timers.id, stale.map((resource) => resource.resourceId)),
    ));
    await tx.update(modInstallationResources).set({
      status: "detached",
      updatedByUserId: principal.userId!,
      updatedAt: new Date(),
    }).where(inArray(modInstallationResources.id, stale.map((resource) => resource.id)));
  }
  for (const definition of BUILD_MANAGED_TIMER_DEFINITIONS) {
    const now = new Date();
    const definitionHash = buildManagedTimerDefinitionHash(definition, timezone);
    const [existing] = await tx.select().from(modInstallationResources).where(and(
      eq(modInstallationResources.installationId, installation.id),
      eq(modInstallationResources.contributionId, definition.contributionId),
      eq(modInstallationResources.subjectUserId, principal.userId!),
      eq(modInstallationResources.ownerUserId, principal.userId!),
      eq(modInstallationResources.accountId, principal.accountId!),
    )).limit(1).for("update");
    let resourceId = existing?.resourceId;
    if (resourceId) {
      const [ownedTimer] = await tx.select({ id: timers.id }).from(timers).where(and(
        userTimerOwner(principal),
        eq(timers.id, resourceId),
      )).limit(1).for("update");
      if (ownedTimer) {
        await tx.update(timers).set(timerValues(definition, timezone, now)).where(and(
          userTimerOwner(principal),
          eq(timers.id, resourceId),
        ));
      } else {
        resourceId = undefined;
      }
    }
    if (!resourceId) resourceId = await adoptOrCreateTimer(tx, principal, definition, timezone);
    const [resource] = existing
      ? await tx.update(modInstallationResources).set({
          resourceKind: BUILD_MANAGED_TIMER_KIND,
          resourceId: resourceId!,
          definitionHash,
          status: "active",
          updatedByUserId: principal.userId!,
          updatedAt: now,
        }).where(eq(modInstallationResources.id, existing.id)).returning()
      : await tx.insert(modInstallationResources).values({
          installationId: installation.id,
          contributionId: definition.contributionId,
          subjectUserId: principal.userId!,
          resourceKind: BUILD_MANAGED_TIMER_KIND,
          resourceId: resourceId!,
          definitionHash,
          status: "active",
          ...ownedInsertValues(principal, resourceScope),
          createdByUserId: principal.userId!,
          updatedByUserId: principal.userId!,
        }).returning();
    if (!resource) throw new Error(`Build resource ledger upsert failed: ${definition.contributionId}`);
    rows.push(resource);
  }
  return rows;
}

export async function disableBuildManagedResources(
  tx: DrizzleTx,
  principal: Principal,
  installation: ModInstallationRow,
): Promise<void> {
  const owner = userTimerOwner(principal);
  const resources = await tx.select().from(modInstallationResources).where(and(
    eq(modInstallationResources.installationId, installation.id),
    eq(modInstallationResources.accountId, principal.accountId!),
    eq(modInstallationResources.ownerUserId, principal.userId!),
    eq(modInstallationResources.resourceKind, BUILD_MANAGED_TIMER_KIND),
  )).for("update");
  const ids = resources.map((resource) => resource.resourceId);
  const now = new Date();
  if (ids.length > 0) {
    await tx.update(timers).set({ enabled: false, updatedAt: now }).where(and(owner, inArray(timers.id, ids)));
    await tx.update(modInstallationResources).set({
      status: "disabled",
      updatedByUserId: principal.userId!,
      updatedAt: now,
    }).where(and(
      eq(modInstallationResources.installationId, installation.id),
      eq(modInstallationResources.accountId, principal.accountId!),
      eq(modInstallationResources.ownerUserId, principal.userId!),
      eq(modInstallationResources.resourceKind, BUILD_MANAGED_TIMER_KIND),
    ));
  }
}

export async function getActiveBuildRegressionResource(
  tx: DrizzleTx,
  principal: Principal,
): Promise<{ installation: ModInstallationRow; resource: ModInstallationResourceRow; timer: Timer } | null> {
  if (!principal.userId || !principal.accountId) return null;
  const [row] = await tx.select({
    installation: modInstallations,
    resource: modInstallationResources,
    timer: timers,
  }).from(modInstallations)
    .innerJoin(modInstallationResources, and(
      eq(modInstallationResources.installationId, modInstallations.id),
      eq(modInstallationResources.contributionId, BUILD_REGRESSION_CONTRIBUTION_ID),
      eq(modInstallationResources.status, "active"),
      eq(modInstallationResources.ownerUserId, principal.userId),
      eq(modInstallationResources.accountId, principal.accountId),
    ))
    .innerJoin(timers, and(
      eq(timers.id, modInstallationResources.resourceId),
      eq(timers.scope, "user"),
      eq(timers.ownerUserId, principal.userId),
      eq(timers.accountId, principal.accountId),
      eq(timers.enabled, true),
    ))
    .where(and(
      eq(modInstallations.modKey, "build"),
      eq(modInstallations.status, "active"),
      eq(modInstallations.ownerUserId, principal.userId),
      eq(modInstallations.accountId, principal.accountId),
    )).limit(1);
  if (!row) return null;
  return { installation: row.installation, resource: row.resource, timer: {
    id: row.timer.id,
    name: row.timer.name,
    description: row.timer.description,
    type: row.timer.type as Timer["type"],
    prompt: row.timer.prompt,
    skillId: row.timer.skillId ?? undefined,
    systemKey: row.timer.systemKey ?? undefined,
    schedules: row.timer.schedules as Timer["schedules"],
    enabled: row.timer.enabled,
    timezone: row.timer.timezone,
    scope: "user",
    ownerUserId: row.timer.ownerUserId ?? undefined,
    accountId: row.timer.accountId ?? undefined,
    createdAt: row.timer.createdAt.toISOString(),
    updatedAt: row.timer.updatedAt.toISOString(),
  } };
}
