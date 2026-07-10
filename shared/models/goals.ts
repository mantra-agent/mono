import { z } from "zod";

/**
 * @deprecated Priority is a backward-compatibility view type derived from Goal.
 * New code should use Goal directly. This schema defines the wire format
 * returned by GoalsService.goalToPriority() for legacy consumers.
 */
export const prioritySchema = z.object({
  id: z.string(),
  title: z.string(),
  urgency: z.enum(["completed", "partial", "missed"]).optional(),
  linkedParentId: z.string().nullable().optional(),
});

/** @deprecated Use Goal instead. Priority is a compatibility projection. */
export type Priority = z.infer<typeof prioritySchema>;




// --- Goal Horizons ---

/** Canonical horizon values stored in the database */
export const goalHorizons = [
  "today",
  "this_week",
  "this_month",
  "this_quarter",
  "this_year",
  "three_year",
  "ten_year",
  "lifetime",
] as const;
export type GoalHorizon = typeof goalHorizons[number];

/** Legacy aliases accepted at parse/validation boundaries, resolved to canonical values */
const HORIZON_ALIASES: Record<string, GoalHorizon> = {
  now: "today",
  "3_year": "three_year",
  "10_year": "ten_year",
  decade: "ten_year",
};

/** Resolve a horizon string (canonical or alias) to its canonical form. Returns null if unrecognized. */
export function resolveHorizon(input: string): GoalHorizon | null {
  if ((goalHorizons as readonly string[]).includes(input)) return input as GoalHorizon;
  return HORIZON_ALIASES[input] ?? null;
}

/** All accepted horizon strings (canonical + aliases) for Zod validation */
const allAcceptedHorizons = [
  ...goalHorizons,
  ...Object.keys(HORIZON_ALIASES),
] as [string, ...string[]];

/** Zod schema that accepts canonical + alias values and transforms to canonical */
export const horizonSchema = z.enum(allAcceptedHorizons).transform((val) => {
  return resolveHorizon(val) ?? val as GoalHorizon;
});

// --- Goal Statuses ---

export const goalStatuses = ["active", "on_track", "at_risk", "achieved", "blocked", "dormant"] as const;
export type GoalStatus = typeof goalStatuses[number];
export const goalStatusSchema = z.enum(goalStatuses);

// --- Goal Types ---

export interface GoalNote {
  id: string;
  content: string;
  createdAt: string;
}

export interface GoalActivity {
  id: string;
  action: string;
  detail: string;
  timestamp: string;
}

export interface Goal {
  id: string;
  shortName: string;
  description: string;
  rawInput: string;
  horizon: GoalHorizon;
  parentId: string | null;
  owner: string;
  tags: string[];
  status: GoalStatus;
  notes: GoalNote[];
  activities: GoalActivity[];
  createdAt: string;
  updatedAt: string;

  // New fields for unified goals system
  targetDate?: string | null;
  periodDate?: string | null;
  periodWeek?: string | null;
  periodMonth?: string | null;
  source?: string;
  completedAt?: string | null;
}

/**
 * Filters for goal list queries.
 * Dormant goals are excluded from every listing by default (they are shelved, not in play).
 * Management and mutation-lookup surfaces must pass includeDormant: true explicitly.
 */
export interface GoalListFilters {
  horizon?: GoalHorizon;
  owner?: string;
  search?: string;
  tag?: string;
  periodDate?: string;
  periodWeek?: string;
  periodMonth?: string;
  periodScoped?: boolean;
  includeDormant?: boolean;
}

export interface GoalIndexEntry {
  id: string;
  shortName: string;
  horizon: GoalHorizon;
  owner: string;
  tags: string[];
  parentId: string | null;
  status: GoalStatus;
  targetDate?: string | null;
  periodDate?: string | null;
  periodWeek?: string | null;
  periodMonth?: string | null;
  source?: string;
  completedAt?: string | null;
}

export const createGoalSchema = z.object({
  shortName: z.string().min(1).max(80),
  description: z.string().min(1),
  rawInput: z.string().default(""),
  horizon: horizonSchema,
  parentId: z.string().nullable().optional(),
  owner: z.string().default("me"),
  tags: z.array(z.string()).default([]),
  status: goalStatusSchema.optional().default("active"),
  targetDate: z.string().nullable().optional(),
  periodDate: z.string().nullable().optional(),
  periodWeek: z.string().nullable().optional(),
  periodMonth: z.string().nullable().optional(),
  source: z.string().optional(),
});

export type CreateGoalInput = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = z.object({
  shortName: z.string().min(1).max(80).optional(),
  description: z.string().min(1).optional(),
  horizon: horizonSchema.optional(),
  parentId: z.string().nullable().optional(),
  owner: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: goalStatusSchema.optional(),
  targetDate: z.string().nullable().optional(),
  periodDate: z.string().nullable().optional(),
  periodWeek: z.string().nullable().optional(),
  periodMonth: z.string().nullable().optional(),
  source: z.string().optional(),
});

export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;


export const HORIZON_LABELS: Record<GoalHorizon, string> = {
  today: "Today",
  this_week: "This Week",
  this_month: "This Month",
  this_quarter: "This Quarter",
  this_year: "This Year",
  three_year: "3-Year",
  ten_year: "10-Year",
  lifetime: "Lifetime",
};

export const HORIZON_ORDER: Record<GoalHorizon, number> = {
  today: 0,
  this_week: 1,
  this_month: 2,
  this_quarter: 3,
  this_year: 4,
  three_year: 5,
  ten_year: 6,
  lifetime: 7,
};
