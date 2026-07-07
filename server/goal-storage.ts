// Use createLogger for logging ONLY
import { randomBytes } from "crypto";
import { documentStorage } from "./memory";
import type { Goal, GoalIndexEntry, GoalNote, GoalActivity, GoalHorizon, GoalStatus, CreateGoalInput, UpdateGoalInput } from "@shared/schema";
import { goalStatuses, resolveHorizon } from "@shared/schema";
import { tagRegistry } from "./file-storage";
import { TTLCache } from "./utils/ttl-cache";
import { createLogger } from "./log";
import { getCurrentPrincipalOrSystem } from "./principal-context";
import { getDateInTimezone } from "./timezone";

const log = createLogger("GoalStorage");

function principalCacheKey(): string {
  const principal = getCurrentPrincipalOrSystem();
  return `${principal.actorType}:${principal.accountId || "no-account"}:${principal.userId || "no-user"}`;
}

function generateId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Determine if a completed goal should be visible given its horizon and the current date.
 * Completed goals are only visible within the period they were completed in.
 * Goals without completedAt (legacy) are always visible.
 */
function isCompletedGoalVisibleNow(entry: GoalIndexEntry): boolean {
  if (entry.status !== "achieved") return true;
  if (!entry.completedAt) return true; // legacy data — no timestamp, always show

  const today = getDateInTimezone();
  const completedDate = entry.completedAt.slice(0, 10); // YYYY-MM-DD

  switch (entry.horizon) {
    case "today":
      return completedDate === today;
    case "this_week": {
      // Same ISO week: compare YYYY-Www
      const toWeek = isoWeekString(today);
      const compWeek = isoWeekString(completedDate);
      return toWeek === compWeek;
    }
    case "this_month":
      return completedDate.slice(0, 7) === today.slice(0, 7); // YYYY-MM
    case "this_quarter": {
      const tq = dateToQuarter(today);
      const cq = dateToQuarter(completedDate);
      return tq === cq;
    }
    case "this_year":
      return completedDate.slice(0, 4) === today.slice(0, 4);
    default:
      // Longer horizons (three_year, ten_year, lifetime) — always visible
      return true;
  }
}

/** Returns ISO week string YYYY-Www for a YYYY-MM-DD date */
function isoWeekString(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const dayOfWeek = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // nearest Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Returns YYYY-QN for a YYYY-MM-DD date */
function dateToQuarter(dateStr: string): string {
  const month = parseInt(dateStr.slice(5, 7), 10);
  const q = Math.ceil(month / 3);
  return `${dateStr.slice(0, 4)}-Q${q}`;
}

export class GoalStorage {
  private readonly _listCache = new TTLCache<GoalIndexEntry[]>("Goals", 30_000);

  private invalidateCache(): void {
    this._listCache.invalidateAll();
  }

  private toIndexEntry(goal: Goal): GoalIndexEntry {
    return {
      id: goal.id,
      shortName: goal.shortName,
      horizon: goal.horizon,
      owner: goal.owner,
      tags: goal.tags,
      parentId: goal.parentId ?? null,
      status: goal.status,
      targetDate: goal.targetDate ?? null,
      periodDate: goal.periodDate ?? null,
      periodWeek: goal.periodWeek ?? null,
      periodMonth: goal.periodMonth ?? null,
      source: goal.source,
      completedAt: goal.completedAt ?? null,
    };
  }

  private migrateGoal(raw: any): { goal: Goal; dirty: boolean } {
    const goal = { ...raw };
    let dirty = false;

    // Legacy domain → tags migration
    if (goal.domain && !goal.tags) {
      goal.tags = [goal.domain];
      dirty = true;
    } else if (goal.domain && Array.isArray(goal.tags) && !goal.tags.includes(goal.domain)) {
      goal.tags = [goal.domain, ...goal.tags];
      dirty = true;
    }
    if (goal.domain) { delete goal.domain; dirty = true; }

    // Remove deprecated fields
    if (goal.deadlineType !== undefined) { delete goal.deadlineType; dirty = true; }
    if (goal.linkedProjectIds !== undefined) { delete goal.linkedProjectIds; dirty = true; }
    if (goal.deadline !== undefined) { delete goal.deadline; dirty = true; }
    if (goal.dependencies !== undefined) { delete goal.dependencies; dirty = true; }

    // Status normalization
    if (!goal.status || !goalStatuses.includes(goal.status)) { goal.status = "active"; dirty = true; }

    // Tags normalization
    if (!Array.isArray(goal.tags)) { goal.tags = []; dirty = true; }

    // Horizon migration: resolve aliases and legacy values to canonical
    if (!goal.horizon) {
      goal.horizon = "this_year";
      dirty = true;
    } else {
      const resolved = resolveHorizon(goal.horizon);
      if (resolved && resolved !== goal.horizon) {
        goal.horizon = resolved;
        dirty = true;
      } else if (!resolved) {
        // Unrecognized horizon, default to this_year
        goal.horizon = "this_year";
        dirty = true;
      }
    }

    // Parent normalization
    if (!("parentId" in goal)) { goal.parentId = null; dirty = true; }

    return { goal: goal as Goal, dirty };
  }

  async saveGoal(goal: Goal): Promise<void> {
    await documentStorage.upsertDocument(
      "goal",
      goal.id,
      `goals/life/${goal.id}.json`,
      goal.shortName,
      JSON.stringify(goal),
      goal as any
    );
    this.invalidateCache();
  }

  async listGoals(filters?: { horizon?: GoalHorizon; owner?: string; search?: string; tag?: string; periodDate?: string; periodWeek?: string; periodMonth?: string; periodScoped?: boolean }): Promise<GoalIndexEntry[]> {
    const allEntries = await this._listCache.getOrFetch(`all:${principalCacheKey()}`, async () => {
      const docs = await documentStorage.getDocumentsByType("goal");
      const entries: GoalIndexEntry[] = [];
      for (const doc of docs) {
        const raw = doc.metadata as any;
        if (!raw || !raw.id || !raw.shortName) continue;
        const { goal, dirty } = this.migrateGoal(raw);
        if (dirty) this.saveGoal(goal).catch(err => log.warn("migration write-back failed", err));
        entries.push(this.toIndexEntry(goal));
      }
      return entries;
    });
    if (!filters) return allEntries;

    // Resolve horizon filter alias before comparing
    const filterHorizon = filters.horizon ? (resolveHorizon(filters.horizon) ?? filters.horizon) : undefined;

    return allEntries.filter((entry) => {
      if (filterHorizon && entry.horizon !== filterHorizon) return false;
      if (filters.owner && entry.owner !== filters.owner) return false;
      if (filters.tag && !(entry.tags || []).includes(filters.tag)) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!entry.shortName.toLowerCase().includes(q)) return false;
      }
      // Period-scoped completion visibility: completed goals only show in their completion period
      if (filters.periodScoped && !isCompletedGoalVisibleNow(entry)) return false;

      // Period-scoped filtering with carry-forward:
      // Incomplete goals from prior periods carry forward into the current period.
      // Completed goals only appear in the period they were completed in.
      if (filters.periodDate) {
        if (entry.periodDate === filters.periodDate) {
          // Exact match — always include
        } else if (entry.periodDate && entry.periodDate < filters.periodDate) {
          // Prior period — include only if not completed
          if (entry.status === "achieved") return false;
        } else if (!entry.periodDate && entry.status !== "achieved") {
          // Legacy/current active daily goals without period metadata carry forward.
        } else {
          // Future period or completed unscoped goal — exclude
          return false;
        }
      }
      if (filters.periodWeek) {
        if (entry.periodWeek === filters.periodWeek) {
          // Exact match
        } else if (entry.periodWeek && entry.periodWeek < filters.periodWeek) {
          if (entry.status === "achieved") return false;
        } else if (!entry.periodWeek && entry.status !== "achieved") {
          // Legacy/current active weekly goals without period metadata carry forward.
        } else {
          return false;
        }
      }
      if (filters.periodMonth) {
        if (entry.periodMonth === filters.periodMonth) {
          // Exact match
        } else if (entry.periodMonth && entry.periodMonth < filters.periodMonth) {
          if (entry.status === "achieved") return false;
        } else if (!entry.periodMonth && entry.status !== "achieved") {
          // Legacy/current active monthly goals without period metadata carry forward.
        } else {
          return false;
        }
      }
      return true;
    });
  }

  async getGoal(id: string): Promise<Goal | null> {
    const doc = await documentStorage.getDocument("goal", id);
    if (!doc) return null;
    const raw = doc.metadata as any;
    if (!raw) return null;
    const { goal, dirty } = this.migrateGoal(raw);
    if (dirty) this.saveGoal(goal).catch(err => log.warn("migration write-back failed", err));
    return goal;
  }

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    const now = new Date().toISOString();
    const parentId = input.parentId ?? null;
    const goal: Goal = {
      id: generateId(),
      shortName: input.shortName,
      description: input.description,
      rawInput: input.rawInput || "",
      horizon: input.horizon,
      parentId,
      owner: input.owner || "me",
      tags: input.tags || [],
      status: input.status || "active",
      notes: [],
      activities: [{
        id: generateId(),
        action: "created",
        detail: "Goal created",
        timestamp: now,
      }],
      createdAt: now,
      updatedAt: now,
      targetDate: input.targetDate ?? null,
      periodDate: input.periodDate ?? null,
      periodWeek: input.periodWeek ?? null,
      periodMonth: input.periodMonth ?? null,
      source: input.source,
    };
    await this.saveGoal(goal);
    tagRegistry.syncEntityTags("goal", goal.id, goal.shortName, goal.tags).catch(err => log.warn("tag sync failed", err));
    return goal;
  }

  async updateGoal(id: string, updates: UpdateGoalInput): Promise<Goal> {
    const goal = await this.getGoal(id);
    if (!goal) throw new Error(`Goal ${id} not found`);

    const changedFields: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && JSON.stringify((goal as any)[key]) !== JSON.stringify(value)) {
        changedFields.push(key);
      }
    }
    const now = new Date().toISOString();

    // Auto-manage completedAt: set when achieving, clear when un-achieving
    let completedAt = goal.completedAt;
    if (updates.status === "achieved" && goal.status !== "achieved") {
      completedAt = now;
    } else if (updates.status && updates.status !== "achieved" && goal.status === "achieved") {
      completedAt = null;
    }

    const updated: Goal = {
      ...goal,
      ...updates,
      id: goal.id,
      createdAt: goal.createdAt,
      notes: goal.notes,
      activities: goal.activities,
      updatedAt: now,
      completedAt,
    };
    if (changedFields.length > 0) {
      updated.activities.push({
        id: generateId(),
        action: "updated",
        detail: `Updated ${changedFields.join(", ")}`,
        timestamp: now,
      });
    }
    await this.saveGoal(updated);
    if (changedFields.includes("tags")) {
      tagRegistry.syncEntityTags("goal", updated.id, updated.shortName, updated.tags).catch(err => log.warn("tag sync failed", err));
    }
    return updated;
  }

  async deleteGoal(id: string): Promise<void> {
    await documentStorage.deleteDocument("goal", id);
    this.invalidateCache();
    tagRegistry.removeEntityTags("goal", id).catch(err => log.warn("tag removal failed", err));
  }

  async addNote(goalId: string, content: string): Promise<Goal> {
    const goal = await this.getGoal(goalId);
    if (!goal) throw new Error(`Goal ${goalId} not found`);
    const now = new Date().toISOString();
    goal.notes.push({
      id: generateId(),
      content,
      createdAt: now,
    });
    goal.updatedAt = now;
    await this.saveGoal(goal);
    return goal;
  }

  async addActivity(goalId: string, action: string, detail: string): Promise<Goal> {
    const goal = await this.getGoal(goalId);
    if (!goal) throw new Error(`Goal ${goalId} not found`);
    const now = new Date().toISOString();
    goal.activities.push({
      id: generateId(),
      action,
      detail,
      timestamp: now,
    });
    goal.updatedAt = now;
    await this.saveGoal(goal);
    return goal;
  }

  async rebuildIndex(): Promise<void> {
  }

  async getGraphData(): Promise<{ goals: (GoalIndexEntry & { description?: string })[] }> {
    const index = await this.listGoals();
    const goals: (GoalIndexEntry & { description?: string })[] = [];
    for (const entry of index) {
      const goal = await this.getGoal(entry.id);
      goals.push({ ...entry, description: goal?.description });
    }
    return { goals };
  }
}

export const goalStorage = new GoalStorage();
