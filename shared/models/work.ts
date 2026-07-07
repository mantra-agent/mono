import { z } from "zod";

export const taskStatusEnum = z.enum(["on_hold", "ready", "active", "done"]);
export type TaskStatus = z.infer<typeof taskStatusEnum>;

export const projectStatusEnum = z.enum(["idea", "planning", "active", "on_hold", "completed"]);
export type ProjectStatus = z.infer<typeof projectStatusEnum>;

export const priorityEnum = z.enum(["high", "mid", "low"]);
export type PriorityLevel = z.infer<typeof priorityEnum>;

export const impactEffortEnum = z.enum(["high", "mid", "low"]);
export type ImpactEffort = z.infer<typeof impactEffortEnum>;

export const ownerEnum = z.enum(["me", "agent"]);
export type Owner = z.infer<typeof ownerEnum>;

export const milestoneStatusEnum = z.enum(["planned", "active", "completed"]);
export type MilestoneStatus = z.infer<typeof milestoneStatusEnum>;

export const milestoneSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: milestoneStatusEnum,
  order: z.number().optional().default(0),
  startDate: z.string().nullable().optional().default(null),
  dueDate: z.string().nullable().optional().default(null),
});
export type Milestone = z.infer<typeof milestoneSchema>;

export const insertMilestoneSchema = z.object({
  name: z.string().min(1),
  status: milestoneStatusEnum.optional().default("planned"),
  order: z.number().optional().default(0),
  startDate: z.string().nullable().optional().default(null),
  dueDate: z.string().nullable().optional().default(null),
});
export type InsertMilestone = z.infer<typeof insertMilestoneSchema>;

export const projectNoteSchema = z.object({
  id: z.string(),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectNote = z.infer<typeof projectNoteSchema>;

export const projectFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  objectKey: z.string(),
  size: z.number(),
  uploadedAt: z.string(),
});
export type ProjectFile = z.infer<typeof projectFileSchema>;

export const activityEntrySchema = z.object({
  timestamp: z.string(),
  author: ownerEnum,
  message: z.string(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const insertTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().default(""),
  status: taskStatusEnum.optional().default("ready"),
  priority: priorityEnum.optional().default("mid"),
  impact: impactEffortEnum.optional().default("mid"),
  effort: impactEffortEnum.optional().default("mid"),
  owner: ownerEnum.optional().default("me"),
  requiresReview: z.boolean().optional().default(false),
  projectId: z.number().nullable().optional().default(null),
  milestoneId: z.number().nullable().optional().default(null),
  tags: z.array(z.string()).optional().default([]),
  deliverable: z.string().optional().default(""),
  acceptanceCriteria: z.string().optional().default(""),
  context: z.string().optional().default(""),
  output: z.string().optional().default(""),
  estimateLow: z.number().nullable().optional().default(null),
  estimateHigh: z.number().nullable().optional().default(null),
  deadline: z.string().nullable().optional().default(null),
  tokenEstimate: z.number().nullable().optional().default(null),
});
export type InsertTask = z.infer<typeof insertTaskSchema>;

export interface Task {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: PriorityLevel;
  impact: ImpactEffort;
  effort: ImpactEffort;
  owner: Owner;
  requiresReview: boolean;
  projectId: number | null;
  milestoneId: number | null;
  tags: string[];
  deliverable: string;
  acceptanceCriteria: string;
  context: string;
  output: string;
  estimateLow: number | null;
  estimateHigh: number | null;
  deadline: string | null;
  tokenEstimate: number | null;
  createdAt: string;
  updatedAt: string;
}

export function computeEffort(estimateLow: number | null, estimateHigh: number | null): ImpactEffort | null {
  if (estimateLow == null || estimateHigh == null) return null;
  const avg = (estimateLow + estimateHigh) / 2;
  if (avg < 1) return "low";
  if (avg <= 4) return "mid";
  return "high";
}

export function formatDeadlineCompact(deadline: string): string {
  const d = new Date(deadline + 'T12:00:00');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

export function getDeadlineProximity(deadline: string | null): { label: string; urgency: 'overdue' | 'urgent' | 'soon' | 'normal' } | null {
  if (!deadline) return null;
  const now = new Date();
  const dl = new Date(deadline + 'T23:59:59');
  const daysLeft = Math.ceil((dl.getTime() - now.getTime()) / 86400000);
  if (daysLeft < 0) return { label: `${Math.abs(daysLeft)}d overdue`, urgency: 'overdue' };
  if (daysLeft === 0) return { label: 'today', urgency: 'urgent' };
  if (daysLeft === 1) return { label: 'tomorrow', urgency: 'urgent' };
  if (daysLeft <= 7) return { label: `${daysLeft}d`, urgency: 'soon' };
  return { label: `${daysLeft}d`, urgency: 'normal' };
}

export const insertProjectSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().default(""),
  status: projectStatusEnum.optional().default("idea"),
  priority: priorityEnum.optional().default("mid"),
  owner: ownerEnum.optional().default("me"),
  requiresReview: z.boolean().optional().default(false),
  dueDate: z.string().nullable().optional().default(null),
  milestones: z.array(milestoneSchema).optional().default([]),
  spec: z.string().optional().default(""),
  tags: z.array(z.string()).optional().default([]),
  people: z.array(z.string()).optional().default([]),
  goalId: z.string().nullable().optional().default(null),
});
export type InsertProject = z.infer<typeof insertProjectSchema>;

export interface Project {
  id: number;
  title: string;
  description: string;
  status: ProjectStatus;
  priority: PriorityLevel;
  owner: Owner;
  requiresReview: boolean;
  dueDate: string | null;
  milestones: Milestone[];
  spec: string;
  tags: string[];
  people: string[];
  goalId: string | null;
  notes: ProjectNote[];
  files: ProjectFile[];
  activity: ActivityEntry[];
  createdAt: string;
  updatedAt: string;
}

