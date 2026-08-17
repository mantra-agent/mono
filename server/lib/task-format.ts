import type { Task } from "@shared/models/work";
import { formatDeadlineCompact, getDeadlineProximity } from "@shared/models/work";

function deadlineStr(deadline: string | null): string {
  if (!deadline) return '';
  const compact = formatDeadlineCompact(deadline);
  const prox = getDeadlineProximity(deadline);
  return prox ? `, due ${compact} (${prox.label})` : `, due ${compact}`;
}

export function formatTaskForBridge(t: Task, ownerLabel?: string): string {
  const dl = deadlineStr(t.deadline);
  const assignee = t.assigneeSubjectType && t.assigneeSubjectId
    ? `, assignee: ${t.assigneeSubjectType}:${t.assigneeSubjectId}`
    : "";
  const owner = ownerLabel
    ?? (t.ownerPersonId ? `@person:${t.ownerPersonId}` : "unknown");
  return `- [${t.status}] ${t.title} (id: ${t.id}, ${t.priority}, owner: ${owner}${assignee}${dl})${t.projectId ? ` — project ${t.projectId}` : ""}`;
}

/** Async form that resolves Person names for bridge/context consumers. */
export async function formatTaskForBridgeNamed(t: Task): Promise<string> {
  const { formatWorkOwnerReference } = await import("../work-owner");
  const owner = await formatWorkOwnerReference(t.ownerPersonId);
  return formatTaskForBridge(t, owner);
}
