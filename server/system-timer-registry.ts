// Use createLogger for logging ONLY
import type { Timer, InsertTimer, Schedule } from "@shared/models/timers";
import { timerStorage } from "./file-storage";
import { withQueryAttributionAsync } from "./db";
import { createLogger } from "./log";
import { getTimezone } from "./timezone";

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
  "memory-consolidate": "consolidate",
  "memory-integrate": "integrate",
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
  // Intentions Prioritize and Advance removed — replaced by autonomy skill
  {
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.skillId === "consolidate" || t.skillId === "memory-consolidate"),

    systemKey: "memory-consolidate",
    name: "Consolidate",
    description:
      "Promotes short-term memories older than 30 minutes into mid-term every 30 minutes",
    type: "skill",
    skillId: "consolidate",
    prompt: "",
    schedules: [
      {
        id: "sys-skill-consolidate-1",
        frequency: "every_x_minutes",
        interval: 30,
      },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.skillId === "integrate" || t.skillId === "memory-integrate"),

    systemKey: "memory-integrate",
    name: "Integrate",
    description:
      "Integrates mid-term memories into long-term and runs graph myelination every 4 hours",
    type: "skill",
    skillId: "integrate",
    prompt: "",
    schedules: [
      { id: "sys-skill-integrate-1", frequency: "every_x_hours", interval: 4 },
    ],
    enabled: true,
    timezone: "__USER_TZ__",
  },
  {
    legacyMatch: (t) => t.type === "skill" && t.skillId === "sleep",

    systemKey: "sleep",
    name: "Sleep",
    description: "Nightly belief decay and reinforcement cycle at 2am",
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
        frequency: "weekly",
        daysOfWeek: ["fri"],
        timeOfDay: "14:00",
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
      "Fire the ideate skill once a week. Top 3 ideas to make xyz, Ray, or the collaboration better. Research-backed, context-grounded.",
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
  "Memory: Short-term Consolidation": "Consolidate",
  "Memory: Mid-to-Long Integration": "Integrate",
  "Nightly Sleep": "Sleep",
  "Memory Sleep": "Sleep",
  "Memory Hygiene": "Wonder",
  "Hourly Consolidate": "Consolidate",
  "4-Hourly Integrate": "Integrate",
  "Morning Introspect": "Reflect Daily",
  "Evening Introspect": "Reflect Daily",
  "Daily Capability Audit": "Reflect Daily",
  "Memory Consolidate": "Consolidate",
  "Memory Integrate": "Integrate",
};


const RETIRED_SYSTEM_TIMERS: Array<{
  systemKey: string;
  legacyMatch: (timer: Timer) => boolean;
  description: string;
}> = [
  {
    systemKey: "intentions-advance",
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.name === "Intentions Advance" ||
        t.skillId === "advance" ||
        t.systemKey === "intentions-advance"),
    description:
      "Deprecated orphaned timer: intentions system removed; replaced by autonomy skill.",
  },
  {
    systemKey: "intentions-prioritize",
    legacyMatch: (t) =>
      t.type === "skill" &&
      (t.name === "Intentions Prioritize" ||
        t.skillId === "prioritize" ||
        t.systemKey === "intentions-prioritize"),
    description:
      "Deprecated orphaned timer: intentions/prioritize system removed; replaced by autonomy skill.",
  },
];
const TIMER_SCHEDULE_MIGRATIONS: Array<{
  match: (t: Timer) => boolean;
  schedules: Timer["schedules"];
}> = [
  {
    match: (t) =>
      t.type === "skill" &&
      (t.skillId === "consolidate" || t.skillId === "memory-consolidate"),
    schedules: [
      {
        id: "sys-skill-consolidate-1",
        frequency: "every_x_minutes",
        interval: 30,
      },
    ],
  },
];

export class SystemTimerRegistry {
  private lastHealCheckAt = 0;
  private static readonly HEAL_INTERVAL_MS = 5 * 60 * 1000;

  private findDefinitionForTimer(timer: Timer): SystemTimerDefinition | null {
    if (timer.systemKey) {
      return (
        SYSTEM_TIMER_DEFINITIONS.find(
          (definition) => definition.systemKey === timer.systemKey,
        ) ?? null
      );
    }
    return (
      SYSTEM_TIMER_DEFINITIONS.find((definition) =>
        definition.legacyMatch(timer),
      ) ?? null
    );
  }

  private definitionByKey(systemKey: string): SystemTimerDefinition | null {
    return (
      SYSTEM_TIMER_DEFINITIONS.find(
        (definition) => definition.systemKey === systemKey,
      ) ?? null
    );
  }

  private retiredDefinitionForTimer(timer: Timer) {
    return (
      RETIRED_SYSTEM_TIMERS.find(
        (definition) =>
          timer.systemKey === definition.systemKey || definition.legacyMatch(timer),
      ) ?? null
    );
  }

  private async retireDeprecatedTimers(timers: Timer[]): Promise<void> {
    for (const timer of timers) {
      const retired = this.retiredDefinitionForTimer(timer);
      if (!retired) continue;

      const updates: Partial<Timer> = {};
      if (timer.enabled) updates.enabled = false;
      if (timer.systemKey !== retired.systemKey) updates.systemKey = retired.systemKey;
      if (timer.description !== retired.description)
        updates.description = retired.description;

      if (Object.keys(updates).length === 0) continue;

      await withQueryAttributionAsync("system-timer-registry", () =>
        timerStorage.update(timer.id, updates),
      );
      Object.assign(timer, updates);
      log.log(
        `Retired deprecated system timer "${timer.name}" (${timer.id}) systemKey=${retired.systemKey}: ${Object.keys(updates).join(", ")}`,
      );
    }
  }

  private async dedupGroup(group: Timer[]): Promise<void> {
    if (group.length <= 1) return;
    const counts = await Promise.all(
      group.map(async (timer) => ({
        timer,
        runCount: await withQueryAttributionAsync("system-timer-registry", () =>
          timerStorage.getRunCount(timer.id),
        ),
        hasSystemKey: Boolean(timer.systemKey),
        hasCanonicalShape: Boolean(this.findDefinitionForTimer(timer)),
      })),
    );
    counts.sort((a, b) => {
      if (a.hasSystemKey !== b.hasSystemKey) return a.hasSystemKey ? -1 : 1;
      if (a.hasCanonicalShape !== b.hasCanonicalShape)
        return a.hasCanonicalShape ? -1 : 1;
      return (
        b.runCount - a.runCount ||
        (a.timer.createdAt || "").localeCompare(b.timer.createdAt || "")
      );
    });
    const keeper = counts[0];
    const definition = this.findDefinitionForTimer(keeper.timer);
    if (definition) {
      const materialized = materializeDefinition(definition);
      const updates: Partial<Timer> = {};
      if (keeper.timer.systemKey !== definition.systemKey)
        updates.systemKey = definition.systemKey;
      if (definition.skillId && keeper.timer.skillId !== definition.skillId)
        updates.skillId = definition.skillId;
      if (Object.keys(updates).length > 0) {
        await withQueryAttributionAsync("system-timer-registry", () =>
          timerStorage.update(keeper.timer.id, updates),
        );
        Object.assign(keeper.timer, updates, {
          timezone: materialized.timezone,
        });
        log.log(
          `Fixed duplicate keeper "${keeper.timer.name}" (${keeper.timer.id}) fields=${Object.keys(updates).join(",")}`,
        );
      }
    }
    for (let i = 1; i < counts.length; i++) {
      const duplicate = counts[i];
      if (duplicate.runCount > 0) {
        const migrated = await withQueryAttributionAsync(
          "system-timer-registry",
          () => timerStorage.migrateRuns(duplicate.timer.id, keeper.timer.id),
        );
        if (migrated === 0) {
          log.warn(
            `Duplicate system timer cleanup degraded: run migration returned zero migrated runs timerName="${duplicate.timer.name}" timerId=${duplicate.timer.id} keeperId=${keeper.timer.id} — skipping delete to preserve run history`,
          );
          continue;
        }
      }
      await withQueryAttributionAsync("system-timer-registry", () =>
        timerStorage.delete(duplicate.timer.id),
      );
      log.log(
        `Deleted duplicate system timer: "${duplicate.timer.name}" (${duplicate.timer.id}) runs=${duplicate.runCount}, kept "${keeper.timer.name}" (${keeper.timer.id}) runs=${keeper.runCount}`,
      );
    }
  }

  async reconcile(): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const all = await withQueryAttributionAsync("system-timer-registry", () =>
        timerStorage.getAllFresh(),
      );
      const userTimezone = getTimezone();

      await this.retireDeprecatedTimers(all);

      for (const timer of all) {
        if (
          timer.type === "skill" &&
          timer.skillId &&
          SYSTEM_TIMER_SKILL_ALIASES[timer.skillId]
        ) {
          const newSkillId = SYSTEM_TIMER_SKILL_ALIASES[timer.skillId];
          await withQueryAttributionAsync("system-timer-registry", () =>
            timerStorage.update(timer.id, { skillId: newSkillId }),
          );
          timer.skillId = newSkillId;
          log.log(
            `Updated timer "${timer.name}" skillId: "${timer.skillId}" → "${newSkillId}"`,
          );
        }
        const newName = TIMER_NAME_RENAMES[timer.name];
        if (newName) {
          await withQueryAttributionAsync("system-timer-registry", () =>
            timerStorage.update(timer.id, { name: newName }),
          );
          timer.name = newName;
          log.log(`Renamed timer "${timer.name}" → "${newName}"`);
        }
        for (const migration of TIMER_SCHEDULE_MIGRATIONS) {
          if (!migration.match(timer)) continue;
          if (
            fingerprintSchedules(timer.schedules) !==
            fingerprintSchedules(migration.schedules)
          ) {
            await withQueryAttributionAsync("system-timer-registry", () =>
              timerStorage.update(timer.id, { schedules: migration.schedules }),
            );
            timer.schedules = migration.schedules;
            log.log(
              `Migrated timer "${timer.name}" schedule to ${migration.schedules[0]?.frequency ?? "unknown"}`,
            );
          }
        }
      }

      const afterLegacyMigration = await withQueryAttributionAsync(
        "system-timer-registry",
        () => timerStorage.getAllFresh(),
      );
      for (const definition of SYSTEM_TIMER_DEFINITIONS) {
        const legacyMatches = afterLegacyMigration.filter(
          (timer) =>
            timer.systemKey === definition.systemKey ||
            definition.legacyMatch(timer),
        );
        if (legacyMatches.length === 0) continue;
        await this.dedupGroup(legacyMatches);
      }

      const keyedTimers = await withQueryAttributionAsync(
        "system-timer-registry",
        () => timerStorage.getAllFresh(),
      );
      for (const definition of SYSTEM_TIMER_DEFINITIONS) {
        const matches = keyedTimers.filter(
          (timer) => timer.systemKey === definition.systemKey,
        );
        await this.dedupGroup(matches);
      }

      const refreshed = await withQueryAttributionAsync(
        "system-timer-registry",
        () => timerStorage.getAllFresh(),
      );
      for (const definition of SYSTEM_TIMER_DEFINITIONS) {
        const materialized = materializeDefinition(definition, userTimezone);
        const matched = refreshed.find(
          (timer) => timer.systemKey === definition.systemKey,
        );
        if (!matched) {
          log.warn(
            `Missing system timer definition detected during reconcile: systemKey="${definition.systemKey}" name="${definition.name}" type=${definition.type}`,
          );
          const created = await withQueryAttributionAsync(
            "system-timer-registry",
            () => timerStorage.create(materialized),
          );
          log.log(
            `Created system timer: ${created.name} (${created.type}) systemKey=${definition.systemKey}`,
          );
          continue;
        }

        const scheduleMismatch =
          fingerprintSchedules(matched.schedules) !==
          fingerprintSchedules(materialized.schedules);
        const updates: Partial<Timer> = {};
        if (matched.name !== materialized.name)
          updates.name = materialized.name;
        if (matched.description !== materialized.description)
          updates.description = materialized.description;
        if (matched.type !== materialized.type)
          updates.type = materialized.type;
        if ((matched.prompt ?? "") !== (materialized.prompt ?? ""))
          updates.prompt = materialized.prompt ?? "";
        if (
          (matched.skillId ?? undefined) !== (materialized.skillId ?? undefined)
        )
          updates.skillId = materialized.skillId;
        if (scheduleMismatch) updates.schedules = materialized.schedules;
        if (!matched.enabled && materialized.enabled) updates.enabled = true;
        if (matched.timezone !== materialized.timezone)
          updates.timezone = materialized.timezone;
        if (matched.systemKey !== materialized.systemKey)
          updates.systemKey = materialized.systemKey;

        if (Object.keys(updates).length > 0) {
          await withQueryAttributionAsync("system-timer-registry", () =>
            timerStorage.update(matched.id, updates),
          );
          log.log(
            `Reconciled system timer "${matched.name}" systemKey=${definition.systemKey}: ${Object.keys(updates).join(", ")}`,
          );
        }
      }
      return { ok: true };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      log.error(`Error reconciling system timers:`, error);
      return { ok: false, error };
    }
  }

  async healMissingTimers(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHealCheckAt < SystemTimerRegistry.HEAL_INTERVAL_MS)
      return;
    this.lastHealCheckAt = now;
    const result = await this.reconcile();
    if (!result.ok) {
      throw new Error(`system timer registry heal failed: ${result.error}`);
    }
  }

  isSystemTimer(timer: Timer): boolean {
    return Boolean(timer.systemKey && this.definitionByKey(timer.systemKey));
  }
}

export const systemTimerRegistry = new SystemTimerRegistry();
