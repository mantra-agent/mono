import { z } from "zod";

export const timerTypes = ["agent", "system", "me", "skill", "reminder"] as const;
export type TimerType = typeof timerTypes[number];

export const responsibilityTypes = timerTypes;
export type ResponsibilityType = TimerType;

export const scheduleFrequencies = [
  "every_x_minutes",
  "every_x_hours",
  "every_x_weeks",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "annually",
  "custom",
  "once",
] as const;
export type ScheduleFrequency = typeof scheduleFrequencies[number];

export const daysOfWeek = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayOfWeek = typeof daysOfWeek[number];

export const scheduleSchema = z.object({
  id: z.string(),
  frequency: z.enum(scheduleFrequencies),
  interval: z.number().optional(),
  timeOfDay: z.string().optional(),
  daysOfWeek: z.array(z.enum(daysOfWeek)).optional(),
  dayOfMonth: z.number().min(1).max(31).optional(),
  monthOfYear: z.number().min(1).max(12).optional(),
  dayOfYear: z.number().min(1).max(366).optional(),
  quarter: z.number().min(1).max(4).optional(),
  cronExpression: z.string().optional(),
  fireAt: z.string().optional(),
  fireOnNextBoot: z.boolean().optional(),
  fireOnNextBuild: z.boolean().optional(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

export const timerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  type: z.enum(timerTypes),
  prompt: z.string().default(""),
  skillId: z.string().optional(),
  systemKey: z.string().optional(),
  schedules: z.array(scheduleSchema).default([]),
  enabled: z.boolean().default(true),
  timezone: z.string().default("America/New_York"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Timer = z.infer<typeof timerSchema>;

export const responsibilitySchema = timerSchema;
export type Responsibility = Timer;

export const insertTimerSchema = timerSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTimer = z.infer<typeof insertTimerSchema>;

export const insertResponsibilitySchema = insertTimerSchema;
export type InsertResponsibility = InsertTimer;

export const runStatuses = ["pending", "running", "success", "error", "skipped", "deferred", "degraded"] as const;
export type TimerRunStatus = typeof runStatuses[number];

export interface TimerRunMetadata {
  intendedFireAt?: string;
  slotStart?: string;
  slotEnd?: string;
  requestedAt?: string;
  [key: string]: unknown;
}

export interface TimerRun {
  id: string;
  timerId: string;
  scheduleId: string;
  status: TimerRunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  sessionId?: string;
  error?: string;
  trigger: "scheduled" | "manual";
  intendedFireAt?: string;
  scheduledSlotStart?: string;
  scheduledSlotEnd?: string;
  metadata?: TimerRunMetadata;
}

export type ResponsibilityRun = TimerRun;

export interface TimerWithNextRun extends Timer {
  nextRunAt?: string;
  lastRun?: TimerRun;
  recentRuns?: TimerRun[];
  stats?: {
    totalRuns: number;
    successCount: number;
    errorCount: number;
    avgDurationMs: number;
    currentStreak: number;
    streakType: "success" | "error" | "none";
  };
}

export type ResponsibilityWithNextRun = TimerWithNextRun;

export interface SchedulerState {
  globalPaused: boolean;
  lastUpdated: string;
}
