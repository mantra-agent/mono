import type { PriorityLevel, TaskStatus } from "./models/work";

export interface RecipientRecapTaskProjection {
  title: string;
  description: string;
  status: TaskStatus;
  priority: PriorityLevel;
  deadline: string | null;
  completedAt: string | null;
}

export interface RecipientRecapProjection {
  meetingTitle: string;
  startedAt: string | null;
  recap: {
    summary: string;
    decisions: string[];
    openQuestions: string[];
    actionItems: string[];
  };
  tasks: RecipientRecapTaskProjection[];
  expiresAt: string;
}

export interface RecipientRecapProjectionResponse {
  projection: RecipientRecapProjection;
}
