import type { Task } from "@shared/models/work";
import { formatDeadlineCompact, getDeadlineProximity } from "@shared/models/work";

function deadlineStr(deadline: string | null): string {
  if (!deadline) return '';
  const compact = formatDeadlineCompact(deadline);
  const prox = getDeadlineProximity(deadline);
  return prox ? `, due ${compact} (${prox.label})` : `, due ${compact}`;
}

export function formatTaskForBridge(t: Task): string {
  const dl = deadlineStr(t.deadline);
  const assignee = t.assigneeSubjectType && t.assigneeSubjectId
    ? `, assignee: ${t.assigneeSubjectType}:${t.assigneeSubjectId}`
    : "";
  return `- [${t.status}] ${t.title} (id: ${t.id}, ${t.priority}, owner: ${t.owner}${assignee}${dl})${t.projectId ? ` — project ${t.projectId}` : ""}`;
}
