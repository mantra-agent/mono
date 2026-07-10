/**
 * GoalsService — canonical service boundary for goal CRUD and lifecycle.
 *
 * All goal mutations should route through this service rather than calling
 * goalStorage directly. This enables de-duplication, validation, and
 * migration logic to live in one place.
 */
import { goalStorage } from "./goal-storage";
import type { Goal, GoalIndexEntry, GoalListFilters, GoalHorizon, GoalStatus, CreateGoalInput, UpdateGoalInput } from "@shared/schema";
import type { Priority } from "@shared/models/goals";

import { createLogger } from "./log";

const log = createLogger("GoalsService");

/** Normalize a title for dedup comparison: lowercase, collapse whitespace, trim */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Map check-in sessionType to GoalHorizon */
function sessionTypeToHorizon(sessionType: string): GoalHorizon {
  switch (sessionType) {
    case "daily": return "today";
    case "weekly": return "this_week";
    case "monthly": return "this_month";
    default: return "today";
  }
}

/** Map priority urgency to GoalStatus */
function mapUrgencyToStatus(urgency?: string): GoalStatus {
  switch (urgency) {
    case "completed": return "achieved";
    case "partial": return "at_risk";
    case "missed": return "at_risk";
    default: return "active";
  }
}

/** Compute ISO week string YYYY-Www from a date for weekly check-ins */
function computePeriodWeek(dateStr: string, sessionType: string): string | null {
  if (sessionType !== "weekly") return null;
  try {
    const d = new Date(dateStr + "T00:00:00Z");
    const year = d.getUTCFullYear();
    // ISO week calculation
    const jan1 = new Date(Date.UTC(year, 0, 1));
    const dayOfYear = Math.floor((d.getTime() - jan1.getTime()) / 86400000) + 1;
    const jan1Day = jan1.getUTCDay() || 7; // Monday=1..Sunday=7
    const weekNum = Math.ceil((dayOfYear + jan1Day - 1) / 7);
    return `${year}-W${String(weekNum).padStart(2, "0")}`;
  } catch {
    return null;
  }
}

/** Compute period month YYYY-MM from a date for monthly check-ins */
function computePeriodMonth(dateStr: string, sessionType: string): string | null {
  if (sessionType !== "monthly") return null;
  try {
    return dateStr.slice(0, 7); // YYYY-MM
  } catch {
    return null;
  }
}

export class GoalsService {
  // --- Query ---

  async listByHorizon(horizon: GoalHorizon, opts?: { includeDormant?: boolean }): Promise<GoalIndexEntry[]> {
    return goalStorage.listGoals({ horizon, ...(opts?.includeDormant ? { includeDormant: true } : {}) });
  }

  async listAll(filters?: GoalListFilters): Promise<GoalIndexEntry[]> {
    return goalStorage.listGoals(filters);
  }

  async get(id: string): Promise<Goal | null> {
    return goalStorage.getGoal(id);
  }

  async search(query: string): Promise<GoalIndexEntry[]> {
    return goalStorage.listGoals({ search: query });
  }

  // --- Mutation ---

  /**
   * Create a goal with optional de-duplication by normalized title within the same horizon.
   * If a duplicate is found, returns the existing goal instead of creating a new one.
   */
  async create(input: CreateGoalInput): Promise<{ goal: Goal; created: boolean }> {
    const normalized = normalizeTitle(input.shortName);
    const existing = await goalStorage.listGoals({ horizon: input.horizon, includeDormant: true });
    const dupe = existing.find(g => normalizeTitle(g.shortName) === normalized);
    if (dupe) {
      const goal = await goalStorage.getGoal(dupe.id);
      if (goal) {
        log.info(`Dedup: goal "${input.shortName}" already exists as "${goal.shortName}" [${goal.id}] in horizon ${input.horizon}`);
        return { goal, created: false };
      }
    }
    const goal = await goalStorage.createGoal(input);
    return { goal, created: true };
  }

  async update(id: string, input: UpdateGoalInput): Promise<Goal> {
    return goalStorage.updateGoal(id, input);
  }

  async setStatus(id: string, status: GoalStatus): Promise<Goal> {
    return goalStorage.updateGoal(id, { status });
  }

  async linkParent(id: string, parentId: string): Promise<Goal> {
    const goal = await goalStorage.getGoal(id);
    if (!goal) throw new Error(`Goal ${id} not found`);
    // Clear existing parent if different
    if (goal.parentId && goal.parentId !== parentId) {
      await goalStorage.updateGoal(id, { parentId: null });
    }
    return goalStorage.updateGoal(id, { parentId });
  }

  async unlinkParent(id: string): Promise<Goal> {
    return goalStorage.updateGoal(id, { parentId: null });
  }

  async delete(id: string): Promise<void> {
    return goalStorage.deleteGoal(id);
  }

  async addNote(id: string, content: string): Promise<Goal> {
    return goalStorage.addNote(id, content);
  }

  async addActivity(id: string, action: string, detail: string): Promise<Goal> {
    return goalStorage.addActivity(id, action, detail);
  }

  // --- Migration ---

  // --- Priority compatibility ---

  /** Map a GoalStatus to the legacy Priority urgency field */
  private statusToUrgency(status: GoalStatus): Priority["urgency"] {
    switch (status) {
      case "achieved": return "completed";
      case "at_risk": return "partial";
      case "blocked": return "missed";
      default: return undefined;
    }
  }

  /** Map a legacy urgency string to GoalStatus */
  private urgencyToStatus(urgency?: string): GoalStatus {
    switch (urgency) {
      case "completed": return "achieved";
      case "partial": return "at_risk";
      case "missed": return "at_risk";
      default: return "active";
    }
  }

  /** Map a GoalIndexEntry to a legacy Priority shape for backward compatibility */
  goalToPriority(goal: GoalIndexEntry): Priority {
    return {
      id: goal.id,
      title: goal.shortName,
      urgency: this.statusToUrgency(goal.status as GoalStatus),
      linkedParentId: goal.parentId ?? undefined,
    };
  }

  /** List goals for a specific period as Priority-shaped objects */
  async listPrioritiesForPeriod(
    horizon: GoalHorizon,
    periodDate: string,
    periodWeek?: string | null,
    periodMonth?: string | null,
  ): Promise<Priority[]> {
    const goals = await goalStorage.listGoals({
      horizon,
      periodDate,
      ...(periodWeek ? { periodWeek } : {}),
      ...(periodMonth ? { periodMonth } : {}),
    });
    return goals.map(g => this.goalToPriority(g));
  }

  /** Find a goal by normalized title within a specific period */
  async findByTitleInPeriod(
    title: string,
    horizon: GoalHorizon,
    periodDate: string,
  ): Promise<Goal | null> {
    const normalized = normalizeTitle(title);
    const goals = await goalStorage.listGoals({ horizon, periodDate, includeDormant: true });
    const match = goals.find(g => normalizeTitle(g.shortName) === normalized);
    if (!match) return null;
    return goalStorage.getGoal(match.id);
  }

  /** Create a priority-compatible goal for a specific period */
  async createPriority(
    title: string,
    horizon: GoalHorizon,
    periodDate: string,
    opts?: { periodWeek?: string | null; periodMonth?: string | null; source?: string },
  ): Promise<{ goal: Goal; created: boolean; duplicate?: Priority }> {
    const normalized = normalizeTitle(title);
    const existing = await goalStorage.listGoals({ horizon, periodDate, includeDormant: true });
    const dupe = existing.find(g => normalizeTitle(g.shortName) === normalized);
    if (dupe) {
      const goal = await goalStorage.getGoal(dupe.id);
      if (goal) {
        return { goal, created: false, duplicate: this.goalToPriority(dupe) };
      }
    }

    const input: CreateGoalInput = {
      shortName: title,
      description: `${horizon} priority for ${periodDate}`,
      rawInput: "",
      horizon,
      owner: "me",
      tags: [],
      status: "active",
      periodDate,
      periodWeek: opts?.periodWeek ?? null,
      periodMonth: opts?.periodMonth ?? null,
      source: opts?.source ?? "priority_tool",
    };

    const goal = await goalStorage.createGoal(input);
    return { goal, created: true };
  }

  /** Rename a priority (goal shortName) by finding it by title in a period */
  async renamePriority(
    oldTitle: string,
    newTitle: string,
    horizon: GoalHorizon,
    periodDate: string,
  ): Promise<{ updated: Goal } | { error: string }> {
    const goal = await this.findByTitleInPeriod(oldTitle, horizon, periodDate);
    if (!goal) return { error: `Priority "${oldTitle}" not found` };

    // Check for duplicate with new title
    const normalized = normalizeTitle(newTitle);
    const existing = await goalStorage.listGoals({ horizon, periodDate, includeDormant: true });
    const dupe = existing.find(g => g.id !== goal.id && normalizeTitle(g.shortName) === normalized);
    if (dupe) return { error: `DUPLICATE_PRIORITY: "${newTitle}" already exists as "${dupe.shortName}"` };

    const updated = await goalStorage.updateGoal(goal.id, { shortName: newTitle });
    return { updated };
  }

  /** Remove a priority by title in a period */
  async removePriority(
    title: string,
    horizon: GoalHorizon,
    periodDate: string,
  ): Promise<{ removed: boolean } | { error: string }> {
    const goal = await this.findByTitleInPeriod(title, horizon, periodDate);
    if (!goal) return { error: `Priority "${title}" not found` };
    await goalStorage.deleteGoal(goal.id);
    return { removed: true };
  }

  /** Mark priority status by title in a period */
  async markPriorityStatus(
    title: string,
    status: "completed" | "partial" | "missed",
    horizon: GoalHorizon,
    periodDate: string,
  ): Promise<{ updated: Goal; alreadySet: boolean } | { error: string }> {
    const goal = await this.findByTitleInPeriod(title, horizon, periodDate);
    if (!goal) return { error: `Priority "${title}" not found` };
    const goalStatus = this.urgencyToStatus(status);
    if (goal.status === goalStatus) {
      return { updated: goal, alreadySet: true };
    }
    const updated = await goalStorage.updateGoal(goal.id, { status: goalStatus });
    return { updated, alreadySet: false };
  }

  /** Link/unlink a priority's parent by title in a period */
  async linkPriorityParent(
    title: string,
    parentId: string | null,
    horizon: GoalHorizon,
    periodDate: string,
  ): Promise<{ updated: Goal } | { error: string }> {
    const goal = await this.findByTitleInPeriod(title, horizon, periodDate);
    if (!goal) return { error: `Priority "${title}" not found` };
    if (parentId) {
      const updated = await this.linkParent(goal.id, parentId);
      return { updated };
    } else {
      const updated = await this.unlinkParent(goal.id);
      return { updated };
    }
  }

  // --- Graph ---

  async getGraphData(): Promise<{ goals: (GoalIndexEntry & { description?: string })[] }> {
    return goalStorage.getGraphData();
  }
}

export const goalsService = new GoalsService();
