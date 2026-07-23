import { db, pool } from "../db";
import { timers, responsibilityRuns } from "@shared/schema";
import { and, eq, desc, count, ilike, or, isNotNull, isNull } from "drizzle-orm";
import { getSetting, setSetting } from "../system-settings";
import { TTLCache } from "../utils/ttl-cache";
import type {
  Timer,
  InsertTimer,
  TimerRun,
  TimerRunStatus,
  SchedulerState,
} from "@shared/models/timers";
import { timerTypes, timerScopes } from "@shared/models/timers";
import { generateId } from "./utils";
import { createLogger } from "../log";
import { requireCurrentUserPrincipal } from "../principal-context";
import type { Principal } from "../principal";

const log = createLogger("StoreTimers");

function rowToTimer(row: typeof timers.$inferSelect): Timer {
  const scope = (timerScopes as readonly string[]).includes(row.scope)
    ? (row.scope as Timer["scope"])
    : "quarantine";
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: (timerTypes as readonly string[]).includes(row.type)
      ? (row.type as Timer["type"])
      : "me",
    prompt: row.prompt,
    skillId: row.skillId ?? undefined,
    systemKey: row.systemKey ?? undefined,
    schedules: (row.schedules as Timer["schedules"]) || [],
    enabled: row.enabled,
    timezone: row.timezone,
    scope,
    ownerUserId: row.ownerUserId ?? undefined,
    accountId: row.accountId ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface RunRow {
  runId: string;
  responsibilityId: string;
  scheduleId: string;
  status: string;
  startedAt: Date | string;
  completedAt: Date | string | null;
  durationMs: number | null;
  sessionId: string | null;
  trigger: string;
  intendedFireAt: Date | string | null;
  scheduledSlotStart: Date | string | null;
  scheduledSlotEnd: Date | string | null;
  error: string | null;
  metadata: unknown;
}

function rowToRun(row: RunRow): TimerRun {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? (row.metadata as TimerRun["metadata"])
    : undefined;
  return {
    id: row.runId,
    timerId: row.responsibilityId,
    scheduleId: row.scheduleId,
    status: row.status as TimerRun["status"],
    startedAt: row.startedAt instanceof Date ? row.startedAt.toISOString() : row.startedAt,
    completedAt: row.completedAt instanceof Date ? row.completedAt.toISOString() : row.completedAt || undefined,
    durationMs: row.durationMs ?? undefined,
    sessionId: row.sessionId ?? undefined,
    trigger: row.trigger as "scheduled" | "manual",
    intendedFireAt: row.intendedFireAt instanceof Date ? row.intendedFireAt.toISOString() : row.intendedFireAt || undefined,
    scheduledSlotStart: row.scheduledSlotStart instanceof Date ? row.scheduledSlotStart.toISOString() : row.scheduledSlotStart || undefined,
    scheduledSlotEnd: row.scheduledSlotEnd instanceof Date ? row.scheduledSlotEnd.toISOString() : row.scheduledSlotEnd || undefined,
    error: row.error ?? undefined,
    metadata,
  };
}

function userTimerPredicate(principal: Principal) {
  if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
    throw new Error("User Timer access requires a user principal with account ownership");
  }
  return and(
    eq(timers.scope, "user"),
    eq(timers.ownerUserId, principal.userId),
    eq(timers.accountId, principal.accountId),
  )!;
}

function validSchedulerTimerPredicate() {
  return or(
    and(eq(timers.scope, "user"), isNotNull(timers.ownerUserId), isNotNull(timers.accountId)),
    and(eq(timers.scope, "system"), eq(timers.type, "system"), isNotNull(timers.systemKey)),
  )!;
}

function ownershipForTimer(timer: Timer) {
  if (timer.scope === "user" && timer.ownerUserId && timer.accountId) {
    return { scope: "user", ownerUserId: timer.ownerUserId, accountId: timer.accountId } as const;
  }
  if (timer.scope === "system" && timer.systemKey) {
    return { scope: "system", ownerUserId: null, accountId: null } as const;
  }
  throw new Error(`Timer ${timer.id} has invalid execution ownership`);
}

export class FileTimerStorage {
  private readonly _cache = new TTLCache<Timer[]>("Timers", Infinity);
  private readonly _schedulerStateCache = new TTLCache<SchedulerState>("TimerSchedulerState", Infinity);

  private invalidateCache(): void {
    this._cache.invalidateAll();
  }

  private userCacheKey(principal: Principal): string {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) {
      throw new Error("User Timer cache requires complete user ownership");
    }
    return `user:${principal.userId}:${principal.accountId}`;
  }

  async getAll(): Promise<Timer[]> {
    const principal = requireCurrentUserPrincipal();
    return this._cache.getOrFetch(this.userCacheKey(principal), async () => {
      const rows = await db.select().from(timers).where(userTimerPredicate(principal));
      return rows.map(rowToTimer).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    });
  }

  async getAllForScheduler(): Promise<Timer[]> {
    return this._cache.getOrFetch("scheduler:valid", async () => {
      const rows = await db.select().from(timers).where(validSchedulerTimerPredicate());
      return rows.map(rowToTimer).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    });
  }

  async getAllSystemFresh(): Promise<Timer[]> {
    this.invalidateCache();
    const rows = await db.select().from(timers).where(eq(timers.scope, "system"));
    return rows.map(rowToTimer);
  }

  async getLatestSystemRunCompletedAt(systemKey: string): Promise<Date | null> {
    const rows = await db
      .select({ completedAt: responsibilityRuns.completedAt })
      .from(responsibilityRuns)
      .innerJoin(timers, and(eq(timers.id, responsibilityRuns.responsibilityId), eq(timers.scope, "system")))
      .where(and(
        eq(timers.systemKey, systemKey),
        eq(responsibilityRuns.scope, "system"),
        eq(responsibilityRuns.status, "success"),
      ))
      .orderBy(desc(responsibilityRuns.completedAt))
      .limit(1);
    return rows[0]?.completedAt ?? null;
  }

  async getManagedUserOwners(): Promise<Array<{ ownerUserId: string; accountId: string }>> {
    const rows = await db
      .selectDistinct({ ownerUserId: timers.ownerUserId, accountId: timers.accountId })
      .from(timers)
      .where(and(eq(timers.scope, "user"), isNotNull(timers.systemKey), isNotNull(timers.ownerUserId), isNotNull(timers.accountId)));
    return rows.filter((row): row is { ownerUserId: string; accountId: string } => !!row.ownerUserId && !!row.accountId);
  }

  async get(id: string): Promise<Timer | null> {
    const principal = requireCurrentUserPrincipal();
    const rows = await db.select().from(timers).where(and(eq(timers.id, id), userTimerPredicate(principal))).limit(1);
    return rows[0] ? rowToTimer(rows[0]) : null;
  }

  async getForScheduler(id: string): Promise<Timer | null> {
    const rows = await db.select().from(timers).where(and(eq(timers.id, id), validSchedulerTimerPredicate())).limit(1);
    return rows[0] ? rowToTimer(rows[0]) : null;
  }

  async searchByName(name: string, limit = 20): Promise<Timer[]> {
    const principal = requireCurrentUserPrincipal();
    const trimmed = name.trim();
    if (!trimmed) return [];
    const rows = await db.select().from(timers).where(and(
      userTimerPredicate(principal),
      or(eq(timers.name, trimmed), ilike(timers.name, `%${trimmed}%`)),
    )).orderBy(desc(timers.updatedAt)).limit(Math.max(1, Math.min(limit, 100)));
    return rows.map(rowToTimer);
  }

  async getByIdOrName(idOrName: string): Promise<Timer | null> {
    const byId = await this.get(idOrName);
    if (byId) return byId;
    const matches = await this.searchByName(idOrName, 2);
    return matches.find((timer) => timer.name === idOrName) || matches[0] || null;
  }

  private valuesFromInput(input: InsertTimer, ownership: ReturnType<typeof ownershipForTimer> | { scope: "user"; ownerUserId: string; accountId: string }, systemKey?: string) {
    const now = new Date();
    return {
      id: generateId(),
      name: input.name,
      description: input.description || "",
      type: input.type,
      prompt: input.prompt || "",
      skillId: input.skillId || null,
      systemKey: systemKey || null,
      schedules: input.schedules || [],
      enabled: input.enabled !== undefined ? input.enabled : true,
      timezone: input.timezone || "America/New_York",
      ...ownership,
      createdAt: now,
      updatedAt: now,
    };
  }

  async create(input: InsertTimer): Promise<Timer> {
    if (input.type === "system") throw new Error("System Timers require explicit platform authority");
    const principal = requireCurrentUserPrincipal();
    const [row] = await db.insert(timers).values(this.valuesFromInput(input, {
      scope: "user",
      ownerUserId: principal.userId,
      accountId: principal.accountId,
    })).returning();
    this.invalidateCache();
    return rowToTimer(row);
  }

  async createManagedUser(input: InsertTimer, systemKey: string, principal: Principal): Promise<Timer> {
    if (principal.actorType !== "user" || !principal.userId || !principal.accountId) throw new Error("Managed user Timer creation requires an owning user principal");
    const [row] = await db.insert(timers).values(this.valuesFromInput(input, {
      scope: "user", ownerUserId: principal.userId, accountId: principal.accountId,
    }, systemKey)).returning();
    this.invalidateCache();
    return rowToTimer(row);
  }

  async createSystem(input: InsertTimer, systemKey: string): Promise<Timer> {
    if (input.type !== "system") throw new Error("System-scoped Timers must use type=system");
    const [row] = await db.insert(timers).values(this.valuesFromInput(input, {
      scope: "system", ownerUserId: null, accountId: null,
    }, systemKey)).returning();
    this.invalidateCache();
    return rowToTimer(row);
  }

  private updateValues(updates: Partial<Omit<Timer, "id" | "createdAt" | "scope" | "ownerUserId" | "accountId">>) {
    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of ["name", "description", "type", "prompt", "schedules", "enabled", "timezone"] as const) if (updates[key] !== undefined) setValues[key] = updates[key];
    if (updates.skillId !== undefined) setValues.skillId = updates.skillId || null;
    if (updates.systemKey !== undefined) setValues.systemKey = updates.systemKey || null;
    return setValues;
  }

  async update(id: string, updates: Partial<Omit<Timer, "id" | "createdAt" | "scope" | "ownerUserId" | "accountId">>): Promise<Timer | null> {
    if (updates.type === "system") throw new Error("User Timers cannot become platform Timers");
    const principal = requireCurrentUserPrincipal();
    const [row] = await db.update(timers).set(this.updateValues(updates)).where(and(eq(timers.id, id), userTimerPredicate(principal))).returning();
    this.invalidateCache();
    return row ? rowToTimer(row) : null;
  }

  async updateForScheduler(timer: Timer, updates: Partial<Omit<Timer, "id" | "createdAt" | "scope" | "ownerUserId" | "accountId">>): Promise<Timer | null> {
    const ownership = ownershipForTimer(timer);
    const ownershipPredicate = ownership.scope === "user"
      ? and(eq(timers.scope, "user"), eq(timers.ownerUserId, ownership.ownerUserId), eq(timers.accountId, ownership.accountId))
      : and(eq(timers.scope, "system"), eq(timers.systemKey, timer.systemKey!));
    const [row] = await db.update(timers).set(this.updateValues(updates)).where(and(eq(timers.id, timer.id), ownershipPredicate)).returning();
    this.invalidateCache();
    return row ? rowToTimer(row) : null;
  }

  async updateSystem(id: string, updates: Partial<Omit<Timer, "id" | "createdAt" | "scope" | "ownerUserId" | "accountId">>): Promise<Timer | null> {
    if (updates.type !== undefined && updates.type !== "system") throw new Error("Platform Timers must remain type=system");
    if (updates.systemKey !== undefined && !updates.systemKey) throw new Error("Platform Timers require systemKey");
    const [row] = await db.update(timers).set(this.updateValues(updates)).where(and(eq(timers.id, id), eq(timers.scope, "system"))).returning();
    this.invalidateCache();
    return row ? rowToTimer(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const principal = requireCurrentUserPrincipal();
    const result = await db.delete(timers).where(and(eq(timers.id, id), userTimerPredicate(principal)));
    this.invalidateCache();
    return (result.rowCount ?? 0) > 0;
  }

  async deleteSystem(id: string): Promise<boolean> {
    const result = await db.delete(timers).where(and(eq(timers.id, id), eq(timers.scope, "system")));
    this.invalidateCache();
    return (result.rowCount ?? 0) > 0;
  }

  async deleteForScheduler(timer: Timer): Promise<boolean> {
    const ownership = ownershipForTimer(timer);
    const ownershipPredicate = ownership.scope === "user"
      ? and(eq(timers.scope, "user"), eq(timers.ownerUserId, ownership.ownerUserId), eq(timers.accountId, ownership.accountId))
      : and(eq(timers.scope, "system"), eq(timers.systemKey, timer.systemKey!));
    const result = await db.delete(timers).where(and(eq(timers.id, timer.id), ownershipPredicate));
    this.invalidateCache();
    return (result.rowCount ?? 0) > 0;
  }

  async deleteCompletedOneTimeRemindersForScheduler(): Promise<number> {
    const result = await pool.query<{ id: string }>(`
      DELETE FROM timers AS timer
      WHERE timer.type = 'reminder'
        AND timer.enabled = false
        AND timer.scope = 'user'
        AND timer.owner_user_id IS NOT NULL
        AND timer.account_id IS NOT NULL
        AND jsonb_typeof(timer.schedules) = 'array'
        AND jsonb_array_length(timer.schedules) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(timer.schedules) AS schedule
          WHERE schedule->>'frequency' IS DISTINCT FROM 'once'
        )
        AND EXISTS (
          SELECT 1
          FROM responsibility_runs AS run
          WHERE run.responsibility_id = timer.id
            AND run.status = 'success'
            AND run.scope = 'user'
            AND run.owner_user_id = timer.owner_user_id
            AND run.account_id = timer.account_id
        )
      RETURNING timer.id
    `);
    if (result.rowCount) this.invalidateCache();
    return result.rowCount ?? 0;
  }

  async appendRun(timer: Timer, run: TimerRun): Promise<void> {
    const ownership = ownershipForTimer(timer);
    await db.insert(responsibilityRuns).values({
      runId: run.id, responsibilityId: run.timerId, scheduleId: run.scheduleId, status: run.status,
      startedAt: new Date(run.startedAt), completedAt: run.completedAt ? new Date(run.completedAt) : null,
      durationMs: run.durationMs ?? null, sessionId: run.sessionId ?? null, trigger: run.trigger,
      intendedFireAt: run.intendedFireAt ? new Date(run.intendedFireAt) : null,
      scheduledSlotStart: run.scheduledSlotStart ? new Date(run.scheduledSlotStart) : null,
      scheduledSlotEnd: run.scheduledSlotEnd ? new Date(run.scheduledSlotEnd) : null,
      error: run.error ?? null, metadata: run.metadata ?? null, ...ownership,
    });
  }

  async updateRun(timer: Timer, runId: string, updates: Partial<TimerRun>): Promise<void> {
    const ownership = ownershipForTimer(timer);
    const setValues: Record<string, unknown> = {};
    if (updates.status !== undefined) setValues.status = updates.status;
    if (updates.completedAt !== undefined) setValues.completedAt = new Date(updates.completedAt);
    if (updates.durationMs !== undefined) setValues.durationMs = updates.durationMs;
    if (updates.sessionId !== undefined) setValues.sessionId = updates.sessionId;
    if (updates.error !== undefined) setValues.error = updates.error;
    if (updates.metadata !== undefined) setValues.metadata = updates.metadata;
    if (Object.keys(setValues).length === 0) return;
    const result = await db.update(responsibilityRuns).set(setValues).where(and(
      eq(responsibilityRuns.runId, runId), eq(responsibilityRuns.responsibilityId, timer.id),
      eq(responsibilityRuns.scope, ownership.scope),
      ownership.scope === "user" ? eq(responsibilityRuns.ownerUserId, ownership.ownerUserId) : and(isNull(responsibilityRuns.ownerUserId), isNull(responsibilityRuns.accountId))!,
    ));
    if ((result.rowCount ?? 0) === 0) throw new Error(`timer run update missed: timerId=${timer.id} runId=${runId}`);
  }

  /**
   * Guarded post-completion reconciliation keyed by the run's session linkage,
   * used when async skill scoring lands after the scheduler already recorded a
   * terminal status (success → degraded on sub-threshold pass rate). The
   * fromStatus guard in the WHERE makes the transition atomic and idempotent.
   * Deliberately unscoped by ownership: this is a system-level integrity
   * reconciliation keyed by an exact unique session linkage, mirroring
   * healStuckSkillRuns.
   */
  async reconcileRunStatusBySession(
    sessionId: string,
    fromStatus: TimerRunStatus,
    toStatus: TimerRunStatus,
    reason: string,
  ): Promise<{ runId: string; timerId: string } | null> {
    const [row] = await db.update(responsibilityRuns)
      .set({ status: toStatus, error: reason })
      .where(and(
        eq(responsibilityRuns.sessionId, sessionId),
        eq(responsibilityRuns.status, fromStatus),
      ))
      .returning({ runId: responsibilityRuns.runId, timerId: responsibilityRuns.responsibilityId });
    return row ?? null;
  }

  private async readRuns(timer: Timer, limit?: number): Promise<TimerRun[]> {
    const ownership = ownershipForTimer(timer);
    const ownershipPredicate = ownership.scope === "user"
      ? and(eq(responsibilityRuns.scope, "user"), eq(responsibilityRuns.ownerUserId, ownership.ownerUserId), eq(responsibilityRuns.accountId, ownership.accountId))
      : eq(responsibilityRuns.scope, "system");
    const query = db.select().from(responsibilityRuns).where(and(eq(responsibilityRuns.responsibilityId, timer.id), ownershipPredicate)).orderBy(desc(responsibilityRuns.startedAt));
    const rows = limit ? await query.limit(limit) : await query;
    return rows.map(rowToRun);
  }

  async getRuns(timerId: string, limit?: number): Promise<TimerRun[]> {
    const timer = await this.get(timerId);
    return timer ? this.readRuns(timer, limit) : [];
  }
  async getRunsForTimers(timerIds: string[], limitPerTimer = 10): Promise<Map<string, TimerRun[]>> {
    const principal = requireCurrentUserPrincipal();
    if (timerIds.length === 0) return new Map();
    const boundedLimit = Math.max(1, Math.min(limitPerTimer, 100));
    const result = await pool.query<{
      run_id: string; responsibility_id: string; schedule_id: string; status: string;
      started_at: Date; completed_at: Date | null; duration_ms: number | null;
      session_id: string | null; trigger: string; intended_fire_at: Date | null;
      scheduled_slot_start: Date | null; scheduled_slot_end: Date | null;
      error: string | null; metadata: unknown;
    }>(`
      SELECT run_id, responsibility_id, schedule_id, status, started_at, completed_at,
             duration_ms, conversation_id AS session_id, trigger, intended_fire_at,
             scheduled_slot_start, scheduled_slot_end, error, metadata
      FROM (
        SELECT runs.*, row_number() OVER (
          PARTITION BY responsibility_id ORDER BY started_at DESC
        ) AS timer_rank
        FROM responsibility_runs AS runs
        WHERE responsibility_id = ANY($1::text[])
          AND scope = 'user'
          AND owner_user_id = $2
          AND account_id = $3
      ) ranked
      WHERE timer_rank <= $4
      ORDER BY responsibility_id, started_at DESC
    `, [timerIds, principal.userId, principal.accountId, boundedLimit]);
    const grouped = new Map<string, TimerRun[]>();
    for (const row of result.rows) {
      const runs = grouped.get(row.responsibility_id) ?? [];
      runs.push(rowToRun({
        runId: row.run_id, responsibilityId: row.responsibility_id, scheduleId: row.schedule_id,
        status: row.status, startedAt: row.started_at, completedAt: row.completed_at,
        durationMs: row.duration_ms, sessionId: row.session_id, trigger: row.trigger,
        intendedFireAt: row.intended_fire_at, scheduledSlotStart: row.scheduled_slot_start,
        scheduledSlotEnd: row.scheduled_slot_end, error: row.error, metadata: row.metadata,
      }));
      grouped.set(row.responsibility_id, runs);
    }
    return grouped;
  }


  async getRunsForScheduler(timer: Timer, limit?: number): Promise<TimerRun[]> {
    return this.readRuns(timer, limit);
  }

  async getSchedulerState(): Promise<SchedulerState> {
    return this._schedulerStateCache.getOrFetch("state", async () => (await getSetting<SchedulerState>("scheduler_state")) || { globalPaused: false, lastUpdated: new Date().toISOString() });
  }

  async setSchedulerState(state: SchedulerState): Promise<void> {
    await setSetting("scheduler_state", state);
    this._schedulerStateCache.invalidateAll();
  }
}

export const timerStorage = new FileTimerStorage();
