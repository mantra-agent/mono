import { db } from "../db";
import { timers, responsibilityRuns } from "@shared/schema";
import { and, eq, desc, count, ilike, or } from "drizzle-orm";
import { getSetting, setSetting } from "../system-settings";
import { TTLCache } from "../utils/ttl-cache";
import type {
  Timer,
  InsertTimer,
  TimerRun,
  SchedulerState,
} from "@shared/models/timers";
import { timerTypes } from "@shared/models/timers";
import { generateId } from "./utils";
import { createLogger } from "../log";

const log = createLogger("StoreTimers");

/** Convert a DB row to the Timer model shape */
function rowToTimer(row: typeof timers.$inferSelect): Timer {
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
  const metadata =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as TimerRun["metadata"])
      : undefined;

  return {
    id: row.runId,
    timerId: row.responsibilityId,
    scheduleId: row.scheduleId,
    status: row.status as TimerRun["status"],
    startedAt:
      row.startedAt instanceof Date ? row.startedAt.toISOString() : row.startedAt,
    completedAt:
      row.completedAt instanceof Date
        ? row.completedAt.toISOString()
        : row.completedAt || undefined,
    durationMs: row.durationMs ?? undefined,
    sessionId: row.sessionId ?? undefined,
    trigger: row.trigger as "scheduled" | "manual",
    intendedFireAt:
      row.intendedFireAt instanceof Date
        ? row.intendedFireAt.toISOString()
        : row.intendedFireAt || undefined,
    scheduledSlotStart:
      row.scheduledSlotStart instanceof Date
        ? row.scheduledSlotStart.toISOString()
        : row.scheduledSlotStart || undefined,
    scheduledSlotEnd:
      row.scheduledSlotEnd instanceof Date
        ? row.scheduledSlotEnd.toISOString()
        : row.scheduledSlotEnd || undefined,
    error: row.error ?? undefined,
    metadata,
  };
}

export class FileTimerStorage {
  private readonly _cache = new TTLCache<Timer[]>("Timers", Infinity);
  private readonly _schedulerStateCache = new TTLCache<SchedulerState>("TimerSchedulerState", Infinity);

  private invalidateCache(): void {
    this._cache.invalidateAll();
  }

  async getAll(): Promise<Timer[]> {
    return this._cache.getOrFetch("all", async () => {
      try {
        const rows = await db.select().from(timers);
        const results = rows.map(rowToTimer);
        results.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        log.log(`getAll count=${results.length}`);
        return results;
      } catch (err) {
        log.error(`getAll error`, err);
        throw err;
      }
    });
  }

  async getAllFresh(): Promise<Timer[]> {
    this.invalidateCache();
    return this.getAll();
  }

  async get(id: string): Promise<Timer | null> {
    try {
      const rows = await db.select().from(timers).where(eq(timers.id, id)).limit(1);
      if (rows.length === 0) {
        log.log(`get id=${id} not-found`);
        return null;
      }
      log.log(`get id=${id} found`);
      return rowToTimer(rows[0]);
    } catch (err) {
      log.error(`get id=${id} error`, err);
      throw err;
    }
  }

  async searchByName(name: string, limit = 20): Promise<Timer[]> {
    const trimmed = name.trim();
    if (!trimmed) return [];
    try {
      const rows = await db
        .select()
        .from(timers)
        .where(or(eq(timers.name, trimmed), ilike(timers.name, `%${trimmed}%`)))
        .orderBy(desc(timers.updatedAt))
        .limit(Math.max(1, Math.min(limit, 100)));
      log.log(`searchByName name="${trimmed}" count=${rows.length}`);
      return rows.map(rowToTimer);
    } catch (err) {
      log.error(`searchByName name="${trimmed}" error`, err);
      throw err;
    }
  }

  async getByIdOrName(idOrName: string): Promise<Timer | null> {
    const byId = await this.get(idOrName);
    if (byId) return byId;
    const matches = await this.searchByName(idOrName, 2);
    if (matches.length === 0) return null;
    const exact = matches.find((timer) => timer.name === idOrName);
    return exact || matches[0];
  }

  async create(input: InsertTimer): Promise<Timer> {
    const now = new Date();
    const id = generateId();
    const [row] = await db.insert(timers).values({
      id,
      name: input.name,
      description: input.description || "",
      type: input.type,
      prompt: input.prompt || "",
      skillId: input.skillId || null,
      systemKey: input.systemKey || null,
      schedules: input.schedules || [],
      enabled: input.enabled !== undefined ? input.enabled : true,
      timezone: input.timezone || "America/New_York",
      createdAt: now,
      updatedAt: now,
    }).returning();
    this.invalidateCache();
    const timer = rowToTimer(row);
    log.log(`create id=${timer.id} name="${timer.name}" type=${timer.type}`);
    return timer;
  }

  async update(id: string, updates: Partial<Omit<Timer, "id" | "createdAt">>): Promise<Timer | null> {
    const existing = await this.get(id);
    if (!existing) {
      log.log(`update id=${id} not-found`);
      return null;
    }

    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.description !== undefined) setValues.description = updates.description;
    if (updates.type !== undefined) setValues.type = updates.type;
    if (updates.prompt !== undefined) setValues.prompt = updates.prompt;
    if (updates.skillId !== undefined) setValues.skillId = updates.skillId || null;
    if (updates.systemKey !== undefined) setValues.systemKey = updates.systemKey || null;
    if (updates.schedules !== undefined) setValues.schedules = updates.schedules;
    if (updates.enabled !== undefined) setValues.enabled = updates.enabled;
    if (updates.timezone !== undefined) setValues.timezone = updates.timezone;

    const [row] = await db.update(timers).set(setValues).where(eq(timers.id, id)).returning();
    this.invalidateCache();
    const timer = rowToTimer(row);
    log.log(`update id=${id} fields=${Object.keys(updates).join(",")}`);
    return timer;
  }

  async delete(id: string): Promise<boolean> {
    try {
      const result = await db.delete(timers).where(eq(timers.id, id));
      const deleted = (result.rowCount ?? 0) > 0;
      this.invalidateCache();
      log.log(`delete id=${id} success=${deleted}`);
      return deleted;
    } catch (err) {
      log.error(`delete id=${id} error`, err);
      return false;
    }
  }

  // ── Run management (unchanged — still uses responsibility_runs table) ──

  async appendRun(run: TimerRun): Promise<void> {
    await db.insert(responsibilityRuns).values({
      runId: run.id,
      responsibilityId: run.timerId,
      scheduleId: run.scheduleId,
      status: run.status,
      startedAt: new Date(run.startedAt),
      completedAt: run.completedAt ? new Date(run.completedAt) : null,
      durationMs: run.durationMs ?? null,
      sessionId: run.sessionId ?? null,
      trigger: run.trigger,
      intendedFireAt: run.intendedFireAt ? new Date(run.intendedFireAt) : null,
      scheduledSlotStart: run.scheduledSlotStart ? new Date(run.scheduledSlotStart) : null,
      scheduledSlotEnd: run.scheduledSlotEnd ? new Date(run.scheduledSlotEnd) : null,
      error: run.error ?? null,
      metadata: run.metadata ?? null,
    });
    log.log(`appendRun runId=${run.id} timerId=${run.timerId} status=${run.status} trigger=${run.trigger}`);
  }

  async updateRun(timerId: string, runId: string, updates: Partial<TimerRun>): Promise<void> {
    const setValues: Partial<{
      status: string;
      completedAt: Date;
      durationMs: number;
      sessionId: string;
      intendedFireAt: Date;
      scheduledSlotStart: Date;
      scheduledSlotEnd: Date;
      error: string;
      metadata: Record<string, unknown>;
    }> = {};
    if (updates.status !== undefined) setValues.status = updates.status;
    if (updates.completedAt !== undefined)
      setValues.completedAt = new Date(updates.completedAt);
    if (updates.durationMs !== undefined) setValues.durationMs = updates.durationMs;
    if (updates.sessionId !== undefined) setValues.sessionId = updates.sessionId;
    if (updates.intendedFireAt !== undefined)
      setValues.intendedFireAt = new Date(updates.intendedFireAt);
    if (updates.scheduledSlotStart !== undefined)
      setValues.scheduledSlotStart = new Date(updates.scheduledSlotStart);
    if (updates.scheduledSlotEnd !== undefined)
      setValues.scheduledSlotEnd = new Date(updates.scheduledSlotEnd);
    if (updates.error !== undefined) setValues.error = updates.error;
    if (updates.metadata !== undefined) setValues.metadata = updates.metadata;

    if (Object.keys(setValues).length === 0) return;

    const result = await db
      .update(responsibilityRuns)
      .set(setValues)
      .where(
        and(
          eq(responsibilityRuns.runId, runId),
          eq(responsibilityRuns.responsibilityId, timerId),
        ),
      );
    if ((result.rowCount ?? 0) === 0) {
      throw new Error(
        `timer run update missed: timerId=${timerId} runId=${runId}`,
      );
    }
    log.log(`updateRun runId=${runId} timerId=${timerId} fields=${Object.keys(setValues).join(",")}`);
  }

  async getRuns(timerId: string, limit?: number): Promise<TimerRun[]> {
    const query = db
      .select()
      .from(responsibilityRuns)
      .where(eq(responsibilityRuns.responsibilityId, timerId))
      .orderBy(desc(responsibilityRuns.startedAt));

    const rows = limit ? await query.limit(limit) : await query;
    log.log(`getRuns timerId=${timerId} count=${rows.length}`);
    return rows.map(rowToRun);
  }

  async getRunCount(timerId: string): Promise<number> {
    try {
      const rows = await db
        .select({ total: count() })
        .from(responsibilityRuns)
        .where(eq(responsibilityRuns.responsibilityId, timerId));
      return rows[0]?.total ?? 0;
    } catch (err) {
      log.error(`getRunCount timerId=${timerId} error`, err);
      return 0;
    }
  }

  async migrateRuns(fromTimerId: string, toTimerId: string): Promise<number> {
    try {
      const result = await db
        .update(responsibilityRuns)
        .set({ responsibilityId: toTimerId })
        .where(eq(responsibilityRuns.responsibilityId, fromTimerId));
      const migrated = result.rowCount ?? 0;
      if (migrated > 0) {
        log.log(`migrateRuns from=${fromTimerId} to=${toTimerId} count=${migrated}`);
      }
      return migrated;
    } catch (err) {
      log.error(`migrateRuns from=${fromTimerId} to=${toTimerId} error`, err);
      return 0;
    }
  }

  async getSchedulerState(): Promise<SchedulerState> {
    return this._schedulerStateCache.getOrFetch("state", async () => {
      try {
        const state = await getSetting<SchedulerState>("scheduler_state");
        if (state) return state;
        return { globalPaused: false, lastUpdated: new Date().toISOString() };
      } catch (err) {
        log.error(`getSchedulerState error`, err);
        return { globalPaused: false, lastUpdated: new Date().toISOString() };
      }
    });
  }

  async setSchedulerState(state: SchedulerState): Promise<void> {
    await setSetting("scheduler_state", state);
    this._schedulerStateCache.invalidateAll();
    log.log(`setSchedulerState globalPaused=${state.globalPaused}`);
  }
}

export const timerStorage = new FileTimerStorage();
