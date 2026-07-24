// Use createLogger for logging ONLY
import type { Timer, InsertTimer, Schedule } from "@shared/models/timers";
import { timerStorage } from "./file-storage";
import { withQueryAttributionAsync } from "./db";
import { createLogger } from "./log";
import { getTimezone } from "./timezone";
import { db } from "./db";
import { userProfiles } from "@shared/schema";
import { eq } from "drizzle-orm";
import type { Principal } from "./principal";
import { createUserPrincipalFromUser } from "./principal";
import { runWithPrincipal } from "./principal-context";
import { storage } from "./storage";
import { getUserEffectivePermissions } from "./permissions";

const log = createLogger("SystemTimerRegistry");

export const SYSTEM_TIMER_SKILL_ALIASES: Record<string, string> = {
  "plan-weekly": "plan",
  "plan-monthly": "plan",
  "reflect-daily": "reflect",
  "reflect-weekly": "reflect",
  "reflect-monthly": "reflect",
  "reflect-quarterly": "reflect",
  "reflect-annual": "reflect",
  "sleep-cycle": "sleep",
  "memory-sleep": "sleep",
  "idea-generation": "ideate",
  "landscape-scan": "scan",
};

export interface SystemTimerDefinition extends InsertTimer {
  systemKey: string;
  legacyMatch: (timer: Timer) => boolean;
}

export type CanonicalSchedule = {
  id: string;
  frequency: Schedule["frequency"];
  interval?: number;
  timeOfDay?: string;
  daysOfWeek?: string[];
  dayOfMonth?: number;
  monthOfYear?: number;
  dayOfYear?: number;
  quarter?: number;
  cronExpression?: string;
  fireAt?: string;
  fireOnNextBoot?: boolean;
  fireOnNextBuild?: boolean;
};

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const compacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (Array.isArray(entry)) compacted[key] = [...entry].sort();
    else compacted[key] = entry;
  }
  return compacted as T;
}

export function normalizeSchedule(schedule: Schedule): CanonicalSchedule {
  return compactObject({
    id: schedule.id,
    frequency: schedule.frequency,
    interval: schedule.interval,
    timeOfDay: schedule.timeOfDay,
    daysOfWeek: schedule.daysOfWeek,
    dayOfMonth: schedule.dayOfMonth,
    monthOfYear: schedule.monthOfYear,
    dayOfYear: schedule.dayOfYear,
    quarter: schedule.quarter,
    cronExpression: schedule.cronExpression,
    fireAt: schedule.fireAt,
    fireOnNextBoot: schedule.fireOnNextBoot,
    fireOnNextBuild: schedule.fireOnNextBuild,
  });
}

export function fingerprintSchedules(
  schedules: Schedule[] | undefined,
): string {
  return JSON.stringify(
    (schedules ?? [])
      .map(normalizeSchedule)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function materializeDefinition(
  definition: SystemTimerDefinition,
  userTimezone = getTimezone(),
): InsertTimer & { systemKey: string } {
  return {
    systemKey: definition.systemKey,
    name: definition.name,
    description: definition.description,
    type: definition.type,
    prompt: definition.prompt ?? "",
    skillId: definition.skillId,
    schedules: definition.schedules ?? [],
    enabled: definition.enabled,
    timezone:
      definition.timezone === "__USER_TZ__"
        ? userTimezone
        : definition.timezone,
  };
}

export const SYSTEM_TIMER_DEFINITIONS: SystemTimerDefinition[] = [
  {
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.name === "Weekly Reflection" || t.skillId === "reflect-weekly"),

    systemKey: "weekly-reflection",
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
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.name === "Monthly Reflection" || t.skillId === "reflect-monthly"),

    systemKey: "monthly-reflection",
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
    legacyMatch: (t) => t.type === "skill" && t.skillId === "financial-review",

    systemKey: "financial-review-monthly",
    name: "Financial Review Monthly",
    description:
      "Monthly financial advisory review using live finance data, investment positions, budget targets, and liabilities",
    type: "skill",
    skillId: "financial-review",
    prompt: "",
    schedules: [
      {
        id: "sys-skill-financial-review-monthly",
        frequency: "monthly",
        dayOfMonth: 1,
        timeOfDay: "08:00",
      },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) => t.type === "skill" && t.skillId === "sleep",

    systemKey: "sleep",
    name: "Sleep",
    description: "Nightly vNext claim lifecycle, REM dream generation, and weekly GSI at 2am",
    type: "skill",
    skillId: "sleep",
    prompt: "",
    schedules: [
      { id: "sys-skill-sleep-1", frequency: "daily", timeOfDay: "02:00" },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.name === "Reflect Daily" || t.skillId === "reflect-daily"),

    systemKey: "reflect-daily",
    name: "Reflect Daily",
    description:
      "Daily journal using parameterized Reflect — creates a deterministic source artifact without surfacing inbox noise",
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
    legacyMatch: (t) => t.type === "skill" && t.skillId === "brief-daily",

    systemKey: "daily-brief",
    name: "Daily Brief",
    description:
      "Assembles a morning briefing from calendar, priorities, tasks, email, finance, people, and yesterday's journal",
    type: "skill",
    skillId: "brief-daily",
    prompt: "",
    schedules: [
      { id: "sys-skill-brief-daily-1", frequency: "daily", timeOfDay: "07:00" },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) => t.type === "skill" && t.name === "Weekly Planning",

    systemKey: "weekly-planning",
    name: "Weekly Planning",
    description:
      "Friday weekly planning using parameterized Plan — sets canonical weekly goals and writes the weekly plan artifact",
    type: "skill",
    skillId: "plan",
    prompt: "cadence=weekly",
    schedules: [
      {
        id: "sys-skill-plan-weekly-1",
        frequency: "weekly",
        daysOfWeek: ["fri"],
        timeOfDay: "14:00",
      },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) => t.type === "skill" && t.name === "Monthly Planning",

    systemKey: "monthly-planning",
    name: "Monthly Planning",
    description:
      "Last-Friday monthly planning using parameterized Plan — sets canonical monthly goals and writes the monthly plan artifact",
    type: "skill",
    skillId: "plan",
    prompt: "cadence=monthly",
    schedules: [
      {
        id: "sys-skill-plan-monthly-1",
        frequency: "custom",
        cronExpression: "0 14 * * FRI#L",
      },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) => t.type === "system" && t.prompt === "email-sync",

    systemKey: "email-sync",
    name: "Email Sync",
    description:
      "Hourly sync of connected Gmail accounts to local email cache — full sync on first run, incremental thereafter",
    type: "system",
    skillId: undefined,
    prompt: "email-sync",
    schedules: [
      { id: "sys-email-sync-hourly", frequency: "every_x_hours", interval: 1 },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) => t.type === "system" && t.prompt === "content-publish",

    systemKey: "content-publisher",
    name: "Content Publisher",
    description:
      "Checks every 5 minutes for scheduled posts ready to publish to X (Twitter)",
    type: "system",
    skillId: undefined,
    prompt: "content-publish",
    schedules: [
      {
        id: "sys-content-publisher",
        frequency: "every_x_minutes",
        interval: 5,
      },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) => t.type === "system" && t.prompt === "plaid-refresh",

    systemKey: "plaid-refresh",
    name: "Plaid Refresh",
    description:
      "Daily sync of connected Plaid accounts — re-fetches transactions, holdings, and liabilities as a safety net for missed webhooks",
    type: "system",
    skillId: undefined,
    prompt: "plaid-refresh",
    schedules: [
      { id: "sys-plaid-refresh-daily", frequency: "daily", timeOfDay: "06:00" },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) => t.type === "skill" && t.skillId === "wonder",

    systemKey: "wonder",
    name: "Wonder",
    description:
      "Weekly deep question for Ray. One genuine, context-grounded question delivered Sunday morning to invite introspection.",
    type: "skill",
    skillId: "wonder",
    prompt: "",
    schedules: [
      {
        id: "sunday-morning",
        frequency: "weekly",
        daysOfWeek: ["sun"],
        timeOfDay: "09:00",
      },
    ],
    enabled: true,
    timezone: "America/Chicago",
  },
  {
    // Quarterly fires on the 1st of Jan/Apr/Jul/Oct at 10:00 — after the
    // month-start monthly reflection has had time to close the previous
    // month. Quarterly synthesizes those three monthlies.
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.name === "Quarterly Reflection" || t.skillId === "reflect-quarterly"),

    systemKey: "quarterly-reflection",
    name: "Quarterly Reflection",
    description:
      "Quarterly synthesis using parameterized Reflect — produces a surfaced Library brief from accumulated monthly summaries",
    type: "skill",
    skillId: "reflect",
    prompt: "cadence=quarterly",
    schedules: [
      {
        id: "sys-skill-reflect-quarterly-1",
        frequency: "quarterly",
        timeOfDay: "10:00",
      },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    // Annual fires on Jan 2 at 10:00 — explicitly the day AFTER the Q4
    // quarterly fires (Jan 1 at 10:00) so all four quarterlies have closed
    // and written to the Library before annual synthesis begins. Scheduling
    // them on different days avoids a same-slot race in the executor queue
    // where annual could otherwise be enqueued before quarterly and run
    // against stale data.
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.name === "Annual Reflection" || t.skillId === "reflect-annual"),

    systemKey: "annual-reflection",
    name: "Annual Reflection",
    description:
      "Annual synthesis using parameterized Reflect — produces the This Year, Last Year, and This Life History layers from accumulated quarterly summaries",
    type: "skill",
    skillId: "reflect",
    prompt: "cadence=annual",
    schedules: [
      {
        id: "sys-skill-reflect-annual-1",
        frequency: "annually",
        timeOfDay: "10:00",
        dayOfYear: 2,
      },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.skillId === "ideate" || t.skillId === "idea-generation"),

    systemKey: "weekly-ideas",
    name: "Weekly Ideas",
    description:
      "Fire the ideate skill once a week. Top 3 ideas to make Agent, Ray, or the collaboration better. Research-backed, context-grounded.",
    type: "skill",
    skillId: "ideate",
    prompt: "",
    schedules: [
      {
        id: "weekly-ideas",
        frequency: "weekly",
        daysOfWeek: ["sat"],
        timeOfDay: "09:00",
      },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.skillId === "scan" || t.skillId === "landscape-scan"),

    systemKey: "landscape-scan",
    name: "Landscape Scan",
    description:
      "Automated market intelligence scan — collects signals, scores, curates, surfaces relevant items",
    type: "skill",
    skillId: "scan",
    prompt: "",
    schedules: [
      { id: "sys-skill-scan-1", frequency: "every_x_hours", interval: 8 },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) => t.type === "system" && t.prompt === "meeting-watchdog",

    systemKey: "meeting-watchdog",
    name: "Meeting Watchdog",
    description:
      "Scans recently ended calendar events every 2 hours, auto-links attendees to People, and logs meeting interactions with follow-up deadlines",
    type: "system",
    skillId: undefined,
    prompt: "meeting-watchdog",
    schedules: [
      { id: "sys-meeting-watchdog", frequency: "every_x_hours", interval: 2 },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) => t.type === "system" && t.prompt === "backup:create",

    systemKey: "nightly-backup",
    name: "Nightly Backup",
    description:
      "Automated nightly database backup at 3 AM CT. Creates a full database snapshot.",
    type: "system",
    skillId: undefined,
    prompt: "backup:create",
    schedules: [
      { id: "nightly-backup-3am", frequency: "daily", timeOfDay: "03:00" },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
];

const TIMER_NAME_RENAMES: Record<string, string> = {
  "Nightly Sleep": "Sleep",
  "Memory Sleep": "Sleep",
  "Memory Hygiene": "Wonder",
  "Morning Introspect": "Reflect Daily",
  "Evening Introspect": "Reflect Daily",
  "Daily Capability Audit": "Reflect Daily",
};


const RETIRED_SYSTEM_TIMERS: Array<{
  systemKey: string;
  legacyMatch: (timer: Timer) => boolean;
  description: string;
}> = [
  {
    systemKey: "memory-consolidate",
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.skillId === "consolidate" || t.skillId === "memory-consolidate"),
    description: "Legacy short-to-mid memory consolidation retired with the vNext sleep cycle",
  },
  {
    systemKey: "memory-integrate",
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.skillId === "integrate" || t.skillId === "memory-integrate"),
    description: "Legacy mid-to-long memory integration retired with the vNext sleep cycle",
  },
];

export class SystemTimerRegistry {
  private platformDefinitions(): SystemTimerDefinition[] {
    return SYSTEM_TIMER_DEFINITIONS.filter((definition) => definition.type === "system");
  }

  private managedUserDefinitions(): SystemTimerDefinition[] {
    return SYSTEM_TIMER_DEFINITIONS.filter((definition) => definition.type !== "system");
  }

  private updatesFor(timer: Timer, definition: SystemTimerDefinition, timezone: string): Partial<Timer> {
    const materialized = materializeDefinition(definition, timezone);
    const updates: Partial<Timer> = {};
    if (timer.name !== materialized.name) updates.name = materialized.name;
    if (timer.description !== materialized.description) updates.description = materialized.description;
    if (timer.type !== materialized.type) updates.type = materialized.type;
    if ((timer.prompt ?? "") !== (materialized.prompt ?? "")) updates.prompt = materialized.prompt ?? "";
    if ((timer.skillId ?? undefined) !== (materialized.skillId ?? undefined)) updates.skillId = materialized.skillId;
    if (fingerprintSchedules(timer.schedules) !== fingerprintSchedules(materialized.schedules)) updates.schedules = materialized.schedules;
    if (!timer.enabled && materialized.enabled) updates.enabled = true;
    if (timer.timezone !== materialized.timezone) updates.timezone = materialized.timezone;
    if (timer.systemKey !== definition.systemKey) updates.systemKey = definition.systemKey;
    return updates;
  }

  async reconcileUserTimers(principal: Principal): Promise<void> {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("Managed user Timer reconciliation requires an owning user principal");
    }
    const [profile] = await db.select({ status: userProfiles.onboardingStatus, timezone: userProfiles.timezone })
      .from(userProfiles).where(eq(userProfiles.userId, principal.userId)).limit(1);
    if (!profile || profile.status !== "completed") return;
    await runWithPrincipal(principal, async () => {
      const all = await timerStorage.getAll();
      for (const retired of RETIRED_SYSTEM_TIMERS) {
        const stale = all.filter((timer) => timer.systemKey === retired.systemKey || retired.legacyMatch(timer));
        for (const timer of stale) {
          await timerStorage.deleteForScheduler(timer);
          log.info(`Deleted retired timer "${timer.name}" (${retired.systemKey}) owner=${principal.userId}: ${retired.description}`);
        }
      }
      const remaining = all.filter((timer) =>
        !RETIRED_SYSTEM_TIMERS.some((retired) => timer.systemKey === retired.systemKey || retired.legacyMatch(timer)),
      );
      const timezone = profile.timezone || getTimezone();
      for (const definition of this.managedUserDefinitions()) {
        const matched = remaining.find((timer) => timer.systemKey === definition.systemKey);
        const materialized = materializeDefinition(definition, timezone);
        if (!matched) {
          await timerStorage.createManagedUser(materialized, definition.systemKey, principal);
          log.info(`Created managed user timer systemKey=${definition.systemKey} owner=${principal.userId}`);
          continue;
        }
        const updates = this.updatesFor(matched, definition, timezone);
        if (Object.keys(updates).length > 0) {
          await timerStorage.update(matched.id, updates);
          log.info(`Reconciled managed user timer systemKey=${definition.systemKey} owner=${principal.userId}: ${Object.keys(updates).join(",")}`);
        }
      }
    });
  }

  private async reconcileKnownManagedUserOwners(): Promise<void> {
    const owners = await timerStorage.getManagedUserOwners();
    for (const owner of owners) {
      const user = await storage.getUser(owner.ownerUserId);
      if (!user) {
        log.warn(`Managed Timer owner missing userId=${owner.ownerUserId}`);
        continue;
      }
      const principal = createUserPrincipalFromUser(user, owner.accountId);
      principal.permissions = await getUserEffectivePermissions(user.id);
      await this.reconcileUserTimers(principal);
    }
  }

  async reconcile(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const all = await timerStorage.getAllSystemFresh();
      for (const definition of this.platformDefinitions()) {
        const materialized = materializeDefinition(definition);
        const matched = all.find((timer) => timer.systemKey === definition.systemKey);
        if (!matched) {
          const created = await timerStorage.createSystem(materialized, definition.systemKey);
          log.info(`Created platform Timer ${created.name} systemKey=${definition.systemKey}`);
          continue;
        }
        const updates = this.updatesFor(matched, definition, materialized.timezone);
        if (Object.keys(updates).length > 0) {
          await timerStorage.updateSystem(matched.id, updates);
          log.info(`Reconciled platform Timer systemKey=${definition.systemKey}: ${Object.keys(updates).join(",")}`);
        }
      }
      await this.reconcileKnownManagedUserOwners();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Timer registry reconciliation failed", message);
      return { ok: false, error: message };
    }
  }


  isSystemTimer(timer: Timer): boolean {
    return timer.scope === "system" && timer.type === "system" && Boolean(timer.systemKey);
  }
}
export const systemTimerRegistry = new SystemTimerRegistry();
