import crypto from "node:crypto";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { InsertTimer, Schedule } from "@shared/models/timers";
import {
  modInstallationResources,
  timers,
  type ModInstallationResourceRow,
  type ModInstallationRow,
} from "@shared/schema";
import type { DrizzleTx } from "../db";
import type { Principal } from "../principal";
import { ownedInsertValues } from "../scoped-storage";

export const WELLNESS_MANAGED_TIMER_KIND = "timer";

export interface WellnessManagedTimerDefinition extends InsertTimer {
  contributionId: string;
  systemKey: string;
  legacyNames: readonly string[];
  legacySkillIds?: readonly string[];
}

/**
 * Wellness-owned cadence Timers. Declared once here, contributed on the Wellness
 * Mod definition, and materialised/disabled through installation ownership.
 * Durable health/reflection/coaching/history data is never deleted on disable.
 */
export const WELLNESS_MANAGED_TIMER_DEFINITIONS: readonly WellnessManagedTimerDefinition[] = [
  {
    contributionId: "wellness.timer.weekly-reflection",
    systemKey: "weekly-reflection",
    legacyNames: ["Weekly Reflection"],
    legacySkillIds: ["reflect-weekly"],
    name: "Weekly Reflection",
    description:
      "Weekly review using parameterized Reflect — produces a surfaced Library brief for the completed week",
    type: "skill",
    skillId: "reflect",
    prompt: "cadence=weekly",
    schedules: [
      {
        id: "sys-skill-reflect-weekly-1",
        frequency: "weekly",
        daysOfWeek: ["sun"],
        timeOfDay: "20:00",
      },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    contributionId: "wellness.timer.monthly-reflection",
    systemKey: "monthly-reflection",
    legacyNames: ["Monthly Reflection"],
    legacySkillIds: ["reflect-monthly"],
    name: "Monthly Reflection",
    description:
      "Monthly synthesis using parameterized Reflect — produces a surfaced Library brief from the completed month",
    type: "skill",
    skillId: "reflect",
    prompt: "cadence=monthly",
    schedules: [
      {
        id: "sys-skill-reflect-monthly-1",
        frequency: "monthly",
        dayOfMonth: 1,
        timeOfDay: "06:00",
      },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    contributionId: "wellness.timer.reflect-daily",
    systemKey: "reflect-daily",
    legacyNames: ["Reflect Daily", "Nightly Journal", "Daily Digest"],
    legacySkillIds: ["reflect-daily"],
    name: "Daily Digest",
    description:
      "Daily Digest using parameterized Reflect — creates a deterministic source artifact without surfacing inbox noise",
    type: "skill",
    skillId: "reflect",
    prompt: "cadence=daily",
    schedules: [
      {
        id: "sys-skill-reflect-daily-1",
        frequency: "daily",
        timeOfDay: "21:00",
      },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    contributionId: "wellness.timer.daily-brief",
    systemKey: "daily-brief",
    legacyNames: ["Morning Brief", "Daily Brief"],
    legacySkillIds: ["brief-daily"],
    name: "Morning Brief",
    description:
      "Assembles a morning briefing from calendar, priorities, tasks, email, finance, people, and yesterday's journal",
    type: "skill",
    skillId: "brief-daily",
    prompt: "",
    schedules: [
      {
        id: "sys-skill-brief-daily-1",
        frequency: "daily",
        timeOfDay: "05:00",
      },
    ],
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
  return Object.fromEntries(
    Object.entries(schedule)
      .filter(
        ([, value]) =>
          value !== undefined &&
          value !== "" &&
          !(Array.isArray(value) && value.length === 0),
      )
      .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value]),
  );
}

function uniqueSchedules(schedules: readonly Schedule[]): Schedule[] {
  const byId = new Map<string, Schedule>();
  for (const schedule of schedules) byId.set(schedule.id, schedule);
  return Array.from(byId.values());
}

function definitionPayload(definition: WellnessManagedTimerDefinition, timezone: string) {
  return {
    contributionId: definition.contributionId,
    systemKey: definition.systemKey,
    name: definition.name,
    description: definition.description,
    type: definition.type,
    skillId: definition.skillId ?? null,
    prompt: definition.prompt ?? "",
    schedules: uniqueSchedules(definition.schedules ?? [])
      .map(compactSchedule)
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    enabled: true,
    timezone,
  };
}

export function wellnessManagedTimerDefinitionHash(
  definition: WellnessManagedTimerDefinition,
  timezone: string,
): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(definitionPayload(definition, timezone)))
    .digest("hex");
}

function timerValues(definition: WellnessManagedTimerDefinition, timezone: string, now: Date) {
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
    throw new Error("Wellness-managed Timer materialization requires a user principal");
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
  definition: WellnessManagedTimerDefinition,
  timezone: string,
): Promise<string> {
  const owner = userTimerOwner(principal);
  const matchers = [
    eq(timers.systemKey, definition.systemKey),
    inArray(timers.name, [...definition.legacyNames]),
  ];
  if (definition.legacySkillIds && definition.legacySkillIds.length > 0) {
    matchers.push(inArray(timers.skillId, [...definition.legacySkillIds]));
  }
  const candidates = await tx
    .select()
    .from(timers)
    .where(and(owner, or(...matchers)))
    .orderBy(asc(timers.createdAt), asc(timers.id))
    .for("update");
  const canonical = candidates[0];
  const now = new Date();
  if (canonical) {
    await tx
      .update(timers)
      .set(timerValues(definition, timezone, now))
      .where(and(owner, eq(timers.id, canonical.id)));
    const duplicates = candidates.slice(1).map((row) => row.id);
    if (duplicates.length > 0) {
      await tx
        .update(timers)
        .set({ enabled: false, updatedAt: now })
        .where(and(owner, inArray(timers.id, duplicates)));
    }
    return canonical.id;
  }
  const [created] = await tx
    .insert(timers)
    .values({
      id: generateTimerId(),
      ...timerValues(definition, timezone, now),
      scope: "user",
      ownerUserId: principal.userId!,
      accountId: principal.accountId!,
      createdAt: now,
    })
    .returning({ id: timers.id });
  if (!created) {
    throw new Error(`Wellness-managed Timer creation failed: ${definition.contributionId}`);
  }
  return created.id;
}

export async function materializeWellnessManagedResources(
  tx: DrizzleTx,
  principal: Principal,
  installation: ModInstallationRow,
  timezone: string,
): Promise<ModInstallationResourceRow[]> {
  const rows: ModInstallationResourceRow[] = [];
  const activeContributionIds = WELLNESS_MANAGED_TIMER_DEFINITIONS.map(
    (definition) => definition.contributionId,
  );
  const staleResources = await tx
    .select()
    .from(modInstallationResources)
    .where(
      and(
        eq(modInstallationResources.installationId, installation.id),
        eq(modInstallationResources.ownerUserId, principal.userId!),
        eq(modInstallationResources.accountId, principal.accountId!),
        eq(modInstallationResources.resourceKind, WELLNESS_MANAGED_TIMER_KIND),
      ),
    )
    .for("update");
  const stale = staleResources.filter(
    (resource) => !activeContributionIds.includes(resource.contributionId),
  );
  if (stale.length > 0) {
    await tx
      .update(timers)
      .set({ enabled: false, updatedAt: new Date() })
      .where(
        and(
          userTimerOwner(principal),
          inArray(
            timers.id,
            stale.map((resource) => resource.resourceId),
          ),
        ),
      );
    await tx
      .update(modInstallationResources)
      .set({
        status: "detached",
        updatedByUserId: principal.userId!,
        updatedAt: new Date(),
      })
      .where(
        inArray(
          modInstallationResources.id,
          stale.map((resource) => resource.id),
        ),
      );
  }

  for (const definition of WELLNESS_MANAGED_TIMER_DEFINITIONS) {
    const now = new Date();
    const definitionHash = wellnessManagedTimerDefinitionHash(definition, timezone);
    const [existing] = await tx
      .select()
      .from(modInstallationResources)
      .where(
        and(
          eq(modInstallationResources.installationId, installation.id),
          eq(modInstallationResources.contributionId, definition.contributionId),
          eq(modInstallationResources.subjectUserId, principal.userId!),
          eq(modInstallationResources.ownerUserId, principal.userId!),
          eq(modInstallationResources.accountId, principal.accountId!),
        ),
      )
      .limit(1)
      .for("update");

    let resourceId = existing?.resourceId;
    if (resourceId) {
      const [ownedTimer] = await tx
        .select({ id: timers.id })
        .from(timers)
        .where(and(userTimerOwner(principal), eq(timers.id, resourceId)))
        .limit(1)
        .for("update");
      if (ownedTimer) {
        await tx
          .update(timers)
          .set(timerValues(definition, timezone, now))
          .where(and(userTimerOwner(principal), eq(timers.id, resourceId)));
      } else {
        resourceId = undefined;
      }
    }
    if (!resourceId) {
      resourceId = await adoptOrCreateTimer(tx, principal, definition, timezone);
    }

    const [resource] = existing
      ? await tx
          .update(modInstallationResources)
          .set({
            resourceKind: WELLNESS_MANAGED_TIMER_KIND,
            resourceId: resourceId!,
            definitionHash,
            status: "active",
            updatedByUserId: principal.userId!,
            updatedAt: now,
          })
          .where(eq(modInstallationResources.id, existing.id))
          .returning()
      : await tx
          .insert(modInstallationResources)
          .values({
            installationId: installation.id,
            contributionId: definition.contributionId,
            subjectUserId: principal.userId!,
            resourceKind: WELLNESS_MANAGED_TIMER_KIND,
            resourceId: resourceId!,
            definitionHash,
            status: "active",
            ...ownedInsertValues(principal, resourceScope),
            createdByUserId: principal.userId!,
            updatedByUserId: principal.userId!,
          })
          .returning();
    if (!resource) {
      throw new Error(`Wellness resource ledger upsert failed: ${definition.contributionId}`);
    }
    rows.push(resource);
  }
  return rows;
}

/** Disable ledger-owned Wellness Timers without deleting history or health data. */
export async function disableWellnessManagedResources(
  tx: DrizzleTx,
  principal: Principal,
  installation: ModInstallationRow,
): Promise<void> {
  const owner = userTimerOwner(principal);
  const resources = await tx
    .select()
    .from(modInstallationResources)
    .where(
      and(
        eq(modInstallationResources.installationId, installation.id),
        eq(modInstallationResources.accountId, principal.accountId!),
        eq(modInstallationResources.ownerUserId, principal.userId!),
        eq(modInstallationResources.resourceKind, WELLNESS_MANAGED_TIMER_KIND),
      ),
    )
    .for("update");
  const ids = resources.map((resource) => resource.resourceId);
  const now = new Date();
  if (ids.length > 0) {
    await tx
      .update(timers)
      .set({ enabled: false, updatedAt: now })
      .where(and(owner, inArray(timers.id, ids)));
    await tx
      .update(modInstallationResources)
      .set({
        status: "disabled",
        updatedByUserId: principal.userId!,
        updatedAt: now,
      })
      .where(
        and(
          eq(modInstallationResources.installationId, installation.id),
          eq(modInstallationResources.accountId, principal.accountId!),
          eq(modInstallationResources.ownerUserId, principal.userId!),
          eq(modInstallationResources.resourceKind, WELLNESS_MANAGED_TIMER_KIND),
        ),
      );
  }
}
