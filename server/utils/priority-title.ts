import type { Priority } from "@shared/models/goals";

export function normalizePriorityTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function findDuplicatePriority(priorities: Priority[], title: string): Priority | null {
  const normalizedTitle = normalizePriorityTitle(title);
  if (!normalizedTitle) return null;
  return priorities.find((priority) => normalizePriorityTitle(priority.title) === normalizedTitle) || null;
}
